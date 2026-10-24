// Pure parsing of SpacetimeDB HTTP SQL results (SATS-JSON) into a PlatformSnapshot. No I/O here: the
// Inspector fetches the rows, this file turns them into the red team's contract (src/types.ts), so the
// parsing is unit-tested with recorded rows and no database.
//
// SATS-JSON as returned by POST /v1/database/:db/sql (SpacetimeDB 2.13):
//   rows are positional arrays in schema order; an Identity is ["0x<hex>"]; a Timestamp is [micros];
//   an Option is [0, value] (some) or [1, []] (none); a product is a positional array; arrays are arrays.

import { PlatformSnapshot, type SnapshotDocument } from "../types";
import type { SqlResult } from "./db";

type AlgebraicType = Record<string, unknown>;
type Element = { name: { some: string } | string | null; algebraic_type?: unknown };

const elementName = (e: Element, i: number): string => {
  const n = e.name;
  if (typeof n === "string") return n;
  if (n && typeof n === "object" && "some" in n) return n.some;
  return `_${i}`;
};

/** Decode one SATS-JSON value with its algebraic type into plain JS (identities -> hex, timestamps -> micros). */
export function decodeValue(type: unknown, value: unknown): unknown {
  const t = (type ?? {}) as AlgebraicType;
  if ("Product" in t) {
    const elements = ((t.Product as { elements: Element[] }).elements ?? []) as Element[];
    const arr = value as unknown[];
    if (elements.length === 1) {
      const only = elementName(elements[0]!, 0);
      if (only === "__identity__") return String(arr[0]);
      if (only === "__timestamp_micros_since_unix_epoch__") return Number(arr[0]);
      if (only === "__time_duration_micros__") return Number(arr[0]);
    }
    const out: Record<string, unknown> = {};
    elements.forEach((e, i) => {
      out[elementName(e, i)] = decodeValue(e.algebraic_type, arr[i]);
    });
    return out;
  }
  if ("Sum" in t) {
    const variants = ((t.Sum as { variants: Element[] }).variants ?? []) as Element[];
    const [tag, inner] = value as [number, unknown];
    const v = variants[tag];
    if (!v) throw new Error(`sum tag ${tag} out of range`);
    const name = elementName(v, tag);
    // Option<T>: some -> T, none -> null
    if (variants.length === 2 && elementName(variants[0]!, 0) === "some" && elementName(variants[1]!, 1) === "none") {
      return name === "some" ? decodeValue(v.algebraic_type, inner) : null;
    }
    return { tag: name, value: decodeValue(v.algebraic_type, inner) };
  }
  if ("Array" in t) return (value as unknown[]).map((x) => decodeValue(t.Array, x));
  return value; // String, Bool, integers (JSON numbers)
}

/** Rows of one statement as objects keyed by column name (snake_case, as in the schema). */
export function decodeRows(result: SqlResult): Record<string, unknown>[] {
  const els = result.schema.elements;
  return result.rows.map((row) => {
    const o: Record<string, unknown> = {};
    els.forEach((e, i) => {
      o[elementName(e, i)] = decodeValue(e.algebraic_type, row[i]);
    });
    return o;
  });
}

/** The tables a snapshot reads, in query order. */
export const SNAPSHOT_TABLES = [
  "business",
  "config_version",
  "actor",
  "customer_order",
  "document",
  "journal_line",
  "register_balance",
  "period",
  "processor_event",
  "outbox",
  "inbox_item",
  "owner_statement",
  "decision_record",
  "precedent",
] as const;
export type SnapshotTable = (typeof SNAPSHOT_TABLES)[number];
export type RawTables = Record<SnapshotTable, Record<string, unknown>[]>;

const S = (x: unknown) => (x === null || x === undefined ? "" : String(x));
const N = (x: unknown) => {
  const n = Number(x);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${String(x)}`);
  return n;
};
const fieldsRecord = (x: unknown): Record<string, string> =>
  Object.fromEntries(((x ?? []) as { name: string; value: string }[]).map((f) => [f.name, f.value]));

/** Build the PlatformSnapshot for one business from decoded rows. processorTruth comes from the processor, never from the DB. */
export function snapshotFromTables(businessId: string, t: RawTables, processorTruth: PlatformSnapshot["processorTruth"]): PlatformSnapshot {
  const mine = <K extends SnapshotTable>(k: K) => t[k].filter((r) => r.business_id === businessId);
  const biz = t.business.find((b) => b.business_id === businessId || b.id === businessId);
  if (!biz) throw new Error(`business ${businessId} not found in snapshot`);
  const activeId = S(biz.active_config_id);
  const activeRow = t.config_version.find((c) => S(c.id) === activeId);
  let activeConfig: unknown = null;
  if (activeRow) {
    try {
      activeConfig = JSON.parse(S(activeRow.json));
    } catch {
      activeConfig = { unparseable: S(activeRow.json).slice(0, 200) };
    }
  }

  const documents: SnapshotDocument[] = mine("document")
    .map((d) => ({
      id: S(d.id),
      docType: S(d.doc_type),
      status: S(d.status) as SnapshotDocument["status"],
      period: S(d.period),
      externalRef: S(d.external_ref),
      fields: fieldsRecord(d.fields),
      lines: ((d.lines ?? []) as { values: unknown }[]).map((l) => fieldsRecord(l.values)),
      totalCents: N(d.total_cents),
      createdBy: S(d.created_by),
      createdByRole: S(d.created_by_role),
      approvedBy: d.approved_by === null || d.approved_by === undefined ? null : S(d.approved_by),
      approvedByRole: S(d.approved_by_role),
      reversalOf: S(d.reversal_of),
      reversedBy: S(d.reversed_by),
    }))
    .sort((a, b) => N(a.id) - N(b.id));

  const snap = {
    businessId,
    activeConfigId: activeId,
    activeConfig,
    configVersions: mine("config_version")
      .map((c) => ({ id: S(c.id), version: N(c.version), status: S(c.status) }))
      .sort((a, b) => N(a.id) - N(b.id)),
    actors: mine("actor").map((a) => ({ identity: S(a.identity), role: S(a.role), name: S(a.name) })),
    orders: mine("customer_order")
      .map((o) => ({
        id: S(o.id),
        status: S(o.status),
        totalCents: N(o.total_cents),
        paidCents: N(o.paid_cents),
        refundedCents: N(o.refunded_cents),
        customerName: S(o.customer_name),
        saleDocumentId: S(o.sale_document_id),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
    documents,
    journal: mine("journal_line")
      .sort((a, b) => N(a.id) - N(b.id))
      .map((l) => ({ documentId: S(l.document_id), accountCode: S(l.account_code), period: S(l.period), debitCents: N(l.debit_cents), creditCents: N(l.credit_cents) })),
    registerBalances: mine("register_balance").map((r) => ({ registerId: S(r.register_id), dimsKey: S(r.dims_key), qty: N(r.qty), amountCents: N(r.amount_cents) })),
    periods: mine("period").map((p) => ({ month: S(p.month), status: S(p.status) })),
    processorEvents: mine("processor_event").map((e) => ({ eventId: S(e.event_id), kind: S(e.kind), orderId: S(e.order_id), amountCents: N(e.amount_cents), documentId: S(e.document_id) })),
    outbox: mine("outbox")
      .sort((a, b) => N(a.id) - N(b.id))
      .map((o) => ({ id: S(o.id), kind: S(o.kind), payloadJson: S(o.payload_json), idempotencyKey: S(o.idempotency_key), status: S(o.status), attempts: N(o.attempts) })),
    inbox: mine("inbox_item")
      .sort((a, b) => N(a.id) - N(b.id))
      .map((i) => ({ id: S(i.id), fromRole: S(i.from_role), question: S(i.question), status: S(i.status), documentRef: S(i.document_ref) })),
    ownerStatements: mine("owner_statement").map((s) => ({ id: S(s.id), channel: S(s.channel), status: S(s.status), diffJson: S(s.diff_json) })),
    decisions: mine("decision_record").map((d) => ({ id: S(d.id), actorId: S(d.actor_id), action: S(d.action), outcome: S(d.outcome), ruleIds: ((d.rule_ids ?? []) as unknown[]).map(S) })),
    precedents: mine("precedent").map((p) => ({ id: S(p.id), agentRole: S(p.agent_role), rule: S(p.rule) })),
    processorTruth,
  };
  return PlatformSnapshot.parse(snap);
}

/** business rows are keyed by `id`; give them a business_id so the generic filter works. */
export function normalizeBusinessRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => ({ ...r, business_id: r.id }));
}
