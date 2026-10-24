// Pure parts of the chaos driver: which cases need real Stripe, and checking a case's expected platform
// state against a snapshot plus the processor's truth. No I/O.

import type { ChaosCase, PlatformSnapshot } from "../types";

export const NEEDS_STRIPE = "skipped: needs Stripe test key";

/**
 * Why a case cannot run without a Stripe test key, or undefined if it can. In DEV SIMULATOR mode the brain
 * creates no Stripe checkout sessions at all (createCheckout and resolvePaymentLink skip the gateway), so
 * every step or expectation about sessions, their idempotency keys or the private payment_intent_log
 * (written on the session path) would be observed on code that does not run.
 */
export function chaosSkipReason(c: ChaosCase): string | undefined {
  const why: string[] = [];
  for (const s of c.steps) {
    if (s.op === "crash_at" && (s.point === "after_stripe_session_before_attach" || s.point === "after_create_order_before_stripe_session")) {
      why.push(`crash point ${s.point} sits on the Stripe checkout-session path`);
    }
    if (s.op === "stripe_timeout" && s.api !== "refunds.create") why.push(`${s.api} timeouts need the Stripe API`);
  }
  if (c.expected.stripe?.checkoutSessions !== undefined) why.push("expects a Stripe checkout-session count");
  if (c.expected.paymentIntents) why.push("expects payment_intent_log rows, written on the Stripe session path");
  return why.length ? `${NEEDS_STRIPE} (${[...new Set(why)].join("; ")})` : undefined;
}

const refsOrder = (d: PlatformSnapshot["documents"][number], orderId: string) => d.externalRef === orderId || d.fields.orderId === orderId;

/** Every expectation that does not hold, as a human-readable failure. Empty = the case passed. */
export function evaluateChaos(c: ChaosCase, snap: PlatformSnapshot): string[] {
  const e = c.expected;
  const f: string[] = [];

  for (const [orderId, want] of Object.entries(e.orderStatus ?? {})) {
    const got = snap.orders.find((o) => o.id === orderId)?.status ?? "(no order)";
    if (got !== want) f.push(`order ${orderId} status ${got}, expected ${want}`);
  }

  for (const [orderId, byType] of Object.entries(e.postedDocs ?? {})) {
    const docs = snap.documents.filter((d) => d.status !== "draft" && refsOrder(d, orderId));
    if (Object.keys(byType).length === 0 && docs.length > 0) {
      f.push(`order ${orderId}: expected no documents, found ${docs.map((d) => `${d.docType}#${d.id}`).join(", ")}`);
    }
    for (const [docType, n] of Object.entries(byType)) {
      const got = docs.filter((d) => d.docType === docType).length;
      if (got !== n) f.push(`order ${orderId}: ${got} ${docType} document(s), expected ${n}`);
    }
    if (Object.keys(byType).length === 0 && snap.orders.some((o) => o.id === orderId)) f.push(`order ${orderId} exists, expected none`);
  }

  if (e.processorEventsRecorded !== undefined && snap.processorEvents.length !== e.processorEventsRecorded) {
    f.push(`${snap.processorEvents.length} processor_event row(s) (${snap.processorEvents.map((p) => p.eventId).join(", ")}), expected ${e.processorEventsRecorded}`);
  }

  if (e.journalBalanced) {
    const dr = snap.journal.reduce((s, l) => s + l.debitCents, 0);
    const cr = snap.journal.reduce((s, l) => s + l.creditCents, 0);
    if (dr !== cr) f.push(`journal unbalanced: debits ${dr} != credits ${cr}`);
    const byDoc = new Map<string, number>();
    for (const l of snap.journal) byDoc.set(l.documentId, (byDoc.get(l.documentId) ?? 0) + l.debitCents - l.creditCents);
    for (const [doc, diff] of byDoc) if (diff !== 0) f.push(`document ${doc} unbalanced by ${diff}`);
  }

  for (const orderId of e.inboxOpenedFor ?? []) {
    if (!snap.inbox.some((i) => i.documentRef === orderId || i.question.includes(orderId))) f.push(`no inbox item for ${orderId}`);
  }

  if (e.stripe) {
    const refunds = snap.processorTruth.filter((t) => t.kind === "refund");
    if (e.stripe.refunds !== undefined && refunds.length !== e.stripe.refunds) f.push(`processor shows ${refunds.length} refund(s), expected ${e.stripe.refunds}`);
    const cents = refunds.reduce((s, r) => s + r.amountCents, 0);
    if (e.stripe.refundedCents !== undefined && cents !== e.stripe.refundedCents) f.push(`processor refunded ${cents} cents, expected ${e.stripe.refundedCents}`);
    if (e.stripe.checkoutSessions !== undefined) f.push("checkout sessions are not observable without Stripe (case should have been skipped)");
  }

  if (e.outbox) {
    const items = snap.outbox.filter((o) => o.kind === e.outbox!.kind);
    if (items.length !== e.outbox.count) f.push(`${items.length} ${e.outbox.kind} outbox item(s), expected ${e.outbox.count}`);
    for (const o of items) if (o.status !== e.outbox.status) f.push(`outbox ${o.id} (${o.kind}) is ${o.status}, expected ${e.outbox.status}`);
  }

  if (e.paymentIntents) f.push("payment_intent_log is private and written on the Stripe session path (case should have been skipped)");

  if (e.clearingMatchesProcessor) {
    const ledger = snap.journal.filter((l) => l.accountCode === "1010").reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    const t = snap.processorTruth;
    const sum = (k: string) => t.filter((x) => x.kind === k).reduce((s, x) => s + x.amountCents, 0);
    const net = sum("charge") - sum("fee") - sum("refund") - sum("payout");
    if (ledger !== net) f.push(`Stripe clearing (1010) is ${ledger} cents but the processor's net balance is ${net} (charges ${sum("charge")}, fees ${sum("fee")}, refunds ${sum("refund")}, payouts ${sum("payout")})`);
  }

  for (const [account, want] of Object.entries(e.accountBalances ?? {})) {
    const got = snap.journal.filter((l) => l.accountCode === account).reduce((s, l) => s + l.debitCents - l.creditCents, 0);
    if (got !== want) f.push(`account ${account} balance ${got}, expected ${want}`);
  }

  return f;
}
