// Napkin Inc. platform reducers. CONTRACT FILE: signatures here are frozen for M1 (client bindings
// are generated from them). Every reducer:
//   1. resolves the caller's role from the actor table via ctx.sender (never from arguments),
//   2. checks the role's permission and the invariants, throwing SenderError on violation
//      (the whole transaction rolls back),
//   3. writes an audit_log row.
// Business with enforce=false is the red-team BASELINE: role/policy/margin/SoD checks are skipped,
// caller-supplied prices are accepted. Balance (invariant 1) and dedupe are never skipped.

import { t, SenderError } from "spacetimedb/server";
import spacetimedb, { FieldValue, DocLine } from "./schema";

export default spacetimedb;

const OrderLine = t.object("OrderLine", { productId: t.string(), qty: t.u32() });

const todo = (name: string): never => {
  throw new SenderError(`not implemented: ${name}`);
};

// ---------- identity & roles ----------

/** First caller when no system actor exists becomes the platform "system" actor (the brain). */
export const claimSystem = spacetimedb.reducer((ctx) => todo("claimSystem"));

/** system or owner: mint a one-time code that lets another identity claim `role` for `businessId`. */
export const createRoleGrant = spacetimedb.reducer(
  { code: t.string(), businessId: t.string(), role: t.string(), name: t.string(), ttlSeconds: t.u32() },
  (ctx, args) => todo("createRoleGrant"),
);

/** any identity: claim the role behind an unexpired, unused code. */
export const redeemRoleGrant = spacetimedb.reducer({ code: t.string() }, (ctx, args) => todo("redeemRoleGrant"));

// ---------- business & configuration ----------

/** system: create a business. enforce=false creates a red-team baseline business (immutable after creation). */
export const registerBusiness = spacetimedb.reducer(
  { id: t.string(), name: t.string(), enforce: t.bool() },
  (ctx, args) => todo("registerBusiness"),
);

/**
 * system: store a compiled Configuration as "pending". Rejects JSON that does not parse, documents whose
 * expressions do not compile, and any proof report containing a "failed" proof (never accept failed proofs).
 */
export const submitConfiguration = spacetimedb.reducer(
  { businessId: t.string(), json: t.string(), proofReportJson: t.string() },
  (ctx, args) => todo("submitConfiguration"),
);

/**
 * owner: make a pending configuration active (prices/policies change ONLY here, invariant 6).
 * Exception: system may activate when the business has no active config and no owner yet (bootstrap).
 * Syncs catalog_item rows; on first activation posts an opening_balance document from initialStock.
 */
export const activateConfiguration = spacetimedb.reducer({ configId: t.u64() }, (ctx, args) => todo("activateConfiguration"));

/** owner: reject a pending configuration. */
export const rejectConfiguration = spacetimedb.reducer({ configId: t.u64(), reason: t.string() }, (ctx, args) => todo("rejectConfiguration"));

// ---------- orders & documents ----------

/**
 * storefront | shopkeeper | owner: create a customer_order ("pending_payment") and its sale draft.
 * Prices, costs and stock units are filled from the ACTIVE catalog, never from the caller.
 * discountRate is an exact decimal string; the sale's policy checks (discount cap, margin floor) run now
 * so a below-floor order is refused before payment. Stock availability is checked now too.
 */
export const createOrder = spacetimedb.reducer(
  {
    businessId: t.string(),
    orderId: t.string(),
    customerName: t.string(),
    channel: t.string(),
    discountRate: t.string(),
    couponCode: t.string(),
    lines: t.array(OrderLine),
  },
  (ctx, args) => todo("createOrder"),
);

/** owner | shopkeeper: move a paid order to "ready" or "picked_up". */
export const updateOrderStatus = spacetimedb.reducer({ orderId: t.string(), status: t.string() }, (ctx, args) => todo("updateOrderStatus"));

/** role in the doc type's creatorRoles: create a draft (or post immediately when postOn = "create"). */
export const createDocument = spacetimedb.reducer(
  { businessId: t.string(), docType: t.string(), externalRef: t.string(), fields: t.array(FieldValue), lines: t.array(DocLine), note: t.string() },
  (ctx, args) => todo("createDocument"),
);

/**
 * role in approverRoles, and not the creator when cannotApproveOwn (invariant 5): post a draft.
 * Runs ledger-core post() (policy checks + balance, invariants 1 and 4), checks the period is open (8)
 * and that no balance register goes negative (3), then writes journal lines, movements and balances.
 */
export const postDocument = spacetimedb.reducer({ documentId: t.u64() }, (ctx, args) => todo("postDocument"));

/** owner | bookkeeper: post a reversal document; the original becomes "reversed" (never edited). */
export const reverseDocument = spacetimedb.reducer({ documentId: t.u64(), reason: t.string() }, (ctx, args) => todo("reverseDocument"));

/** owner | bookkeeper: close a month; nothing can post into it afterwards. */
export const closePeriod = spacetimedb.reducer({ businessId: t.string(), month: t.string() }, (ctx, args) => todo("closePeriod"));

/**
 * support | shopkeeper | owner: create a refund draft for an order. saleTotal, saleNet, saleCost,
 * refundedSoFar and hoursSinceSale are filled by the platform from the order's posted sale.
 * Posting it (by a different role) queues a "stripe_refund" outbox item in the same transaction.
 */
export const requestRefund = spacetimedb.reducer(
  { orderId: t.string(), amountCents: t.i64(), reason: t.string() },
  (ctx, args) => todo("requestRefund"),
);

// ---------- payments (exactly-once) ----------

/** system: record the intent before calling Stripe. Unique orderId + idempotencyKey. */
export const logPaymentIntent = spacetimedb.reducer({ orderId: t.string(), idempotencyKey: t.string() }, (ctx, args) => todo("logPaymentIntent"));

/** system: attach the Stripe Checkout Session to the intent. */
export const attachCheckoutSession = spacetimedb.reducer(
  { orderId: t.string(), checkoutSessionId: t.string(), checkoutUrl: t.string() },
  (ctx, args) => todo("attachCheckoutSession"),
);

/**
 * system: one processor event, exactly once. Inserts processor_event(eventId) and, in the SAME
 * transaction, posts its document: payment_succeeded -> payment_received + posts the order's sale
 * (system approves; the sale was created by storefront/shopkeeper) + order "paid";
 * fee -> processor_fee; refund_succeeded -> completes the matching outbox item; payout -> payout.
 * A duplicate eventId returns without changes. An amount that does not match the order opens an
 * inbox item for the owner and posts nothing.
 */
export const recordProcessorEvent = spacetimedb.reducer(
  { eventId: t.string(), businessId: t.string(), kind: t.string(), orderId: t.string(), amountCents: t.i64(), processorRef: t.string() },
  (ctx, args) => todo("recordProcessorEvent"),
);

/** system: claim a pending outbox item (status -> claimed, attempts + 1). */
export const claimOutbox = spacetimedb.reducer({ id: t.u64() }, (ctx, args) => todo("claimOutbox"));

/** system: finish an outbox item. */
export const completeOutbox = spacetimedb.reducer({ id: t.u64(), ok: t.bool(), resultJson: t.string() }, (ctx, args) => todo("completeOutbox"));

// ---------- decisions, inbox, precedents, owner statements ----------

/** any actor of the business: write a DecisionRecord. actorKind/actorId come from the caller's actor row. */
export const recordDecision = spacetimedb.reducer(
  {
    businessId: t.string(),
    action: t.string(),
    documentRef: t.string(),
    ruleIds: t.array(t.string()),
    evidenceRefs: t.array(t.string()),
    inputsHash: t.string(),
    outcome: t.string(),
    reason: t.string(),
    wouldChangeIf: t.string(),
  },
  (ctx, args) => todo("recordDecision"),
);

/** any actor of the business: escalate a question to the owner inbox. */
export const openInbox = spacetimedb.reducer(
  { businessId: t.string(), question: t.string(), contextJson: t.string(), documentRef: t.string() },
  (ctx, args) => todo("openInbox"),
);

/** owner: answer an inbox item; optionally store the answer as a precedent for the asking role. */
export const answerInbox = spacetimedb.reducer(
  { id: t.u64(), answer: t.string(), makePrecedent: t.bool(), precedentRule: t.string(), conditionJson: t.string() },
  (ctx, args) => todo("answerInbox"),
);

/** system (verified phone owner, via the brain) | owner: queue an owner statement with its proposed diff. */
export const queueOwnerStatement = spacetimedb.reducer(
  { businessId: t.string(), channel: t.string(), text: t.string(), diffJson: t.string() },
  (ctx, args) => todo("queueOwnerStatement"),
);

/** owner ONLY (the authenticated app identity): confirm or reject a queued statement. */
export const decideOwnerStatement = spacetimedb.reducer({ id: t.u64(), confirm: t.bool() }, (ctx, args) => todo("decideOwnerStatement"));

/** system: mark a confirmed statement applied (after its configuration change was activated by the owner). */
export const markOwnerStatementApplied = spacetimedb.reducer({ id: t.u64() }, (ctx, args) => todo("markOwnerStatementApplied"));
