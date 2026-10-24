// The Bookkeeper's view of a set of books, and the deterministic facts its read tools return.
// A book set is either the live platform ledger (documents + journal lines + processor events) or a
// provided set (the red team's planted books). The tools only READ and compute facts (sums, matches);
// the Bookkeeper agent decides what is an error and reports it with document refs.

import { z } from "zod";

export interface BookJournalLine {
  account: string;
  debitCents: number;
  creditCents: number;
  memo?: string;
}

export interface BookMovement {
  register: string;
  dims: Record<string, string>;
  kind: "in" | "out";
  qty: number;
  amountCents: number;
}

export interface BookDoc {
  id: string;
  docType: string;
  status: string;
  period: string;
  createdAt?: string | undefined;
  postedAt?: string | undefined;
  createdBy: string;
  approvedBy: string;
  externalRef: string;
  fields: Record<string, string>;
  lines: Record<string, string>[];
  journal: BookJournalLine[];
  movements: BookMovement[];
  reversalOf: string | null;
  note: string;
}

export interface StatementEvent {
  eventId: string;
  kind: string;
  orderId: string;
  processorRef: string;
  amountCents: number;
  at?: string | undefined;
}

export interface BookSet {
  label: string;
  documents: BookDoc[];
  periods: { month: string; status: string; closedAt?: string | null | undefined }[];
  processorStatement: StatementEvent[];
  /** where the statement came from (honesty about what reconcile compares against) */
  statementSource: string;
}

/** Finding kinds the Bookkeeper reports (same list as redteam/src/types.ts PlantedErrorKind; a test pins it). */
export const FINDING_KINDS = [
  "unbalanced_entry",
  "below_margin_floor_sale",
  "discount_above_cap",
  "duplicate_payment",
  "payment_amount_mismatch",
  "refund_outside_window",
  "refund_below_floor",
  "refund_exceeds_payment",
  "fee_not_recorded",
  "negative_inventory",
  "posted_to_closed_period",
  "missing_reversal",
  "revenue_net_not_gross",
  "self_approved",
  "wrong_account",
  "other",
] as const;

export const Finding = z.object({ kind: z.enum(FINDING_KINDS), entries: z.array(z.string().min(1).max(64)).min(1).max(20), note: z.string().max(500).optional() });
export type Finding = z.infer<typeof Finding>;

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function docSummary(d: BookDoc) {
  const debit = sum(d.journal.map((j) => j.debitCents));
  const credit = sum(d.journal.map((j) => j.creditCents));
  return { ...d, debitCents: debit, creditCents: credit, balanced: debit === credit };
}

/** ledger_read: documents (optionally only those touching `account`) with journal totals, plus a trial balance. */
export function ledgerRead(set: BookSet, account?: string) {
  const docs = account ? set.documents.filter((d) => d.journal.some((j) => j.account === account)) : set.documents;
  const trial = new Map<string, { debitCents: number; creditCents: number }>();
  for (const d of set.documents) {
    for (const j of d.journal) {
      const t = trial.get(j.account) ?? { debitCents: 0, creditCents: 0 };
      t.debitCents += j.debitCents;
      t.creditCents += j.creditCents;
      trial.set(j.account, t);
    }
  }
  return {
    books: set.label,
    periods: set.periods,
    documentCount: docs.length,
    documents: docs.map(docSummary),
    trialBalance: [...trial.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([acct, t]) => ({ account: acct, ...t, balanceCents: t.debitCents - t.creditCents })),
  };
}

const STATEMENT_DOC: Record<string, string> = { payment_succeeded: "payment_received", fee: "processor_fee", refund_succeeded: "refund", payout: "payout" };
const AMOUNT_ACCOUNT: Record<string, { account: string; side: "debitCents" | "creditCents" }> = {
  payment_received: { account: "1200", side: "creditCents" },
  processor_fee: { account: "5100", side: "debitCents" },
  refund: { account: "4200", side: "debitCents" },
  payout: { account: "1000", side: "debitCents" },
};

function docAmount(d: BookDoc): number | undefined {
  const a = AMOUNT_ACCOUNT[d.docType];
  if (a) {
    const v = sum(d.journal.filter((j) => j.account === a.account).map((j) => j[a.side]));
    if (v > 0) return v;
  }
  // fall back to the largest one-sided amount
  const m = Math.max(0, ...d.journal.map((j) => Math.max(j.debitCents, j.creditCents)));
  return m || undefined;
}

const orderOf = (d: BookDoc) => d.fields["orderId"] ?? (d.externalRef.startsWith("order:") ? d.externalRef.slice(6) : "");

/**
 * reconcile: deterministic facts only. Per-document balance, the processor statement matched to
 * processor documents (by kind + processorRef/orderId), amount differences, the Stripe clearing (1010)
 * balance against the statement's net, stock running balances in posting order, and closed periods.
 */
export function reconcile(set: BookSet) {
  const docs = set.documents.filter((d) => d.status === "posted" || d.status === "reversed");
  const unbalanced = docs.map(docSummary).filter((d) => !d.balanced).map((d) => ({ document: d.id, debitCents: d.debitCents, creditCents: d.creditCents }));

  const used = new Set<string>();
  const statementMatches: { eventId: string; kind: string; processorRef: string; orderId: string; statementCents: number; documents: { id: string; amountCents: number | undefined }[] }[] = [];
  for (const e of set.processorStatement) {
    const docType = STATEMENT_DOC[e.kind];
    const matches = docs.filter((d) => d.docType === docType && d.reversalOf === null && ((e.processorRef && d.fields["processorRef"] === e.processorRef) || (!d.fields["processorRef"] && orderOf(d) === e.orderId)));
    for (const m of matches) used.add(m.id);
    statementMatches.push({ eventId: e.eventId, kind: e.kind, processorRef: e.processorRef, orderId: e.orderId, statementCents: e.amountCents, documents: matches.map((m) => ({ id: m.id, amountCents: docAmount(m) })) });
  }
  const statementWithoutDocument = statementMatches.filter((m) => m.documents.length === 0);
  const severalDocumentsForOneEvent = statementMatches.filter((m) => m.documents.length > 1);
  const amountDifferences = statementMatches.filter((m) => m.documents.some((d) => d.amountCents !== m.statementCents));
  const processorDocsWithoutStatement = docs
    .filter((d) => Object.values(STATEMENT_DOC).includes(d.docType) && d.docType !== "refund" && d.reversalOf === null && !used.has(d.id))
    .map((d) => ({ document: d.id, docType: d.docType, processorRef: d.fields["processorRef"] ?? "", amountCents: docAmount(d) }));

  const clearingLedger = sum(docs.flatMap((d) => d.journal.filter((j) => j.account === "1010").map((j) => j.debitCents - j.creditCents)));
  const net = sum(set.processorStatement.map((e) => (e.kind === "payment_succeeded" ? e.amountCents : -e.amountCents)));

  // stock running balance in posting order
  const ordered = [...docs].sort((a, b) => ((a.postedAt ?? a.createdAt ?? "") < (b.postedAt ?? b.createdAt ?? "") ? -1 : 1));
  const running = new Map<string, number>();
  const stockLow: { document: string; item: string; balanceAfter: number }[] = [];
  for (const d of ordered) {
    for (const m of d.movements) {
      const key = `${m.register}:${Object.entries(m.dims).map(([k, v]) => `${k}=${v}`).join(",")}`;
      const v = (running.get(key) ?? 0) + (m.kind === "in" ? m.qty : -m.qty);
      running.set(key, v);
      if (v < 0) stockLow.push({ document: d.id, item: key, balanceAfter: v });
    }
  }

  return {
    books: set.label,
    statementSource: set.statementSource,
    unbalancedDocuments: unbalanced,
    statementWithoutDocument,
    severalDocumentsForOneStatementEvent: severalDocumentsForOneEvent,
    amountDifferences,
    processorDocumentsWithoutStatementEvent: processorDocsWithoutStatement,
    clearing1010: { ledgerBalanceCents: clearingLedger, statementNetCents: net, differenceCents: clearingLedger - net },
    stockBalances: [...running.entries()].map(([item, qty]) => ({ item, qty })),
    stockWentNegativeAt: stockLow,
    closedPeriods: set.periods.filter((p) => p.status === "closed"),
  };
}

/** The red team's planted set (redteam/src/types.ts PlantedErrorSet), minus its answer key. */
export function bookSetFromPlanted(set: {
  id: string;
  documents: BookDoc[];
  periods: BookSet["periods"];
  processorStatement: StatementEvent[];
}): BookSet {
  return {
    label: `provided book set ${set.id} (test data)`,
    documents: set.documents.map((d) => ({ ...d, reversalOf: d.reversalOf ?? null })),
    periods: set.periods,
    processorStatement: set.processorStatement,
    statementSource: "the processor statement provided with the book set (simulated test-mode data)",
  };
}

/** Pulls the findings JSON block out of the Bookkeeper's report. Invalid entries are dropped, never repaired. */
export function parseFindings(text: string): Finding[] {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  for (const b of blocks.reverse()) {
    let raw: unknown;
    try {
      raw = JSON.parse(b);
    } catch {
      continue;
    }
    const arr = Array.isArray(raw) ? raw : (raw as { findings?: unknown })?.findings;
    if (!Array.isArray(arr)) continue;
    return arr.map((f) => Finding.safeParse(f)).filter((r) => r.success).map((r) => r.data);
  }
  return [];
}
