// GuardPlatformPort over the brain's live SpacetimeDB connections. Reads come from the system
// connection's cache; facts (refund amounts, document creators) are recomputed with ledger-core from
// the stored documents, the same way the platform computes them. Writes go through reducers: as the
// agent's own identity when the brain holds it (so the DecisionRecord's actor is the platform-known
// role), otherwise as system.

import { computeDocument, Rational, type DocumentDef } from "@napkin/ledger-core";
import { parseConfiguration, type Configuration } from "@napkin/schema";
import { postingContext } from "../compiler/dryrun";
import { actorKey, type StdbHub } from "../stdb";
import { Guard, type DecisionWrite, type GuardPlatformPort } from "./index";
import type { DocumentMeta, PrecedentRow, RefundFacts } from "./types";

const record = (fs: readonly { name: string; value: string }[]) => Object.fromEntries(fs.map((f) => [f.name, f.value]));

export class StdbGuardPlatform implements GuardPlatformPort {
  private cache = new Map<bigint, { json: string; cfg: Configuration }>();
  private subscribed: Promise<void> | undefined;

  constructor(private readonly hub: StdbHub, private readonly now: () => number = Date.now) {}

  private get db() {
    return this.hub.system().conn.db;
  }

  /** The system connection does not mirror precedents/inbox by default; subscribe once. */
  ready(): Promise<void> {
    this.subscribed ??= new Promise<void>((resolve, reject) => {
      this.hub
        .system()
        .conn.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(() => reject(new Error("precedent subscription failed")))
        .subscribe(["SELECT * FROM precedent"]);
    }).catch((e) => {
      this.subscribed = undefined;
      throw e;
    });
    return this.subscribed;
  }

  private config(id: bigint): Configuration | undefined {
    const row = this.db.configVersion.id.find(id);
    if (!row) return undefined;
    const hit = this.cache.get(id);
    if (hit && hit.json === row.json) return hit.cfg;
    const cfg = parseConfiguration(JSON.parse(row.json));
    this.cache.set(id, { json: row.json, cfg });
    return cfg;
  }

  activeConfiguration(businessId: string) {
    const b = this.db.business.id.find(businessId);
    if (!b || b.activeConfigId === 0n) return undefined;
    const config = this.config(b.activeConfigId);
    return config ? { configId: b.activeConfigId.toString(), config } : undefined;
  }

  precedents(businessId: string): PrecedentRow[] {
    return [...this.db.precedent.businessId.filter(businessId)].map((p) => ({ id: p.id.toString(), agentRole: p.agentRole, rule: p.rule, conditionJson: p.conditionJson }));
  }

  refundFacts(businessId: string, orderId: string): RefundFacts | undefined {
    const order = this.db.customerOrder.id.find(orderId);
    if (!order || order.businessId !== businessId) return undefined;
    const sale = this.db.document.id.find(order.saleDocumentId);
    if (!sale || sale.status !== "posted" || !sale.postedAt) return undefined;
    const cfg = this.config(sale.configId);
    const def = cfg?.documents.find((d) => d.id === sale.docType);
    if (!cfg || !def) return undefined;
    const envs = computeDocument(def as unknown as DocumentDef, { fields: record(sale.fields), lines: sale.lines.map((l) => record(l.values)) }, postingContext(cfg));
    let net = Rational.ZERO;
    let cost = Rational.ZERO;
    for (const l of envs.computed.lines) {
      net = net.add(l["net"]!);
      cost = cost.add(l["cost"]!);
    }
    let refunded = 0n;
    for (const d of this.db.document.externalRef.filter(orderId)) {
      if (d.businessId === businessId && d.docType === "refund" && d.status === "posted" && d.reversalOf === 0n) refunded += d.totalCents;
    }
    const hours = Rational.of(BigInt(this.now()) * 1000n - sale.postedAt.microsSinceUnixEpoch, 3_600_000_000n);
    return { orderId, saleTotal: Rational.fromCents(sale.totalCents).toJSON(), saleNet: net.toJSON(), saleCost: cost.toJSON(), refundedSoFarCents: refunded, hoursSinceSale: hours.toJSON() };
  }

  documentMeta(businessId: string, documentId: string): DocumentMeta | undefined {
    const d = this.db.document.id.find(BigInt(documentId));
    if (!d || d.businessId !== businessId) return undefined;
    return { id: d.id.toString(), docType: d.docType, status: d.status, createdByRole: d.createdByRole, createdByIdentity: d.createdBy.toHexString(), totalCents: d.totalCents };
  }

  private keyFor(role: string, businessId: string) {
    const k = actorKey(role, businessId);
    return this.hub.get(k) ? k : "system";
  }

  recordDecision(asRole: string, d: DecisionWrite): Promise<void> {
    return this.hub.call(this.keyFor(asRole, d.businessId), "recordDecision", (c) => c.reducers.recordDecision(d));
  }

  openInbox(asRole: string, i: { businessId: string; question: string; contextJson: string; documentRef: string }): Promise<void> {
    return this.hub.call(this.keyFor(asRole, i.businessId), "openInbox", (c) => c.reducers.openInbox(i));
  }

  queueOwnerStatement(s: { businessId: string; channel: "phone"; text: string; diffJson: string }): Promise<void> {
    return this.hub.call("system", "queueOwnerStatement", (c) => c.reducers.queueOwnerStatement(s));
  }
}

/** The guard M3 agents use: `wrapTool(tool, createStdbGuard(hub))`. */
export function createStdbGuard(hub: StdbHub): Guard {
  return new Guard(new StdbGuardPlatform(hub));
}
