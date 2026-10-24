// Napkin Inc. platform ("the 1C"): generic tables that can hold ANY compiled Configuration.
// Money columns are integer cents (i64). Runtime-defined document fields are typed name/value pairs
// with exact-decimal string values; the full Configuration is stored as a JSON document.
//
// Visibility: tables are public for the hackathon demo (owner app + storefront subscribe directly),
// except role_grant and payment_intent_log which only the module reads.

import { schema, table, t } from "spacetimedb/server";

export const FieldValue = t.object("FieldValue", { name: t.string(), value: t.string() });
export const DocLine = t.object("DocLine", { values: t.array(FieldValue) });

const business = table(
  { name: "business", public: true },
  {
    id: t.string().primaryKey(), // slug, e.g. "maya-cookies"
    name: t.string(),
    activeConfigId: t.u64(), // 0 = none yet
    enforce: t.bool(), // false = red-team baseline (guards off); fixed at creation
    createdAt: t.timestamp(),
  },
);

const configVersion = table(
  { name: "config_version", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    version: t.u32(),
    json: t.string(), // Configuration (packages/schema)
    proofReportJson: t.string(), // ProofReport, "" if none yet
    status: t.string(), // "pending" | "active" | "superseded" | "rejected"
    submittedBy: t.identity(),
    submittedAt: t.timestamp(),
    activatedBy: t.option(t.identity()),
    activatedAt: t.option(t.timestamp()),
  },
);

const actor = table(
  { name: "actor", public: true },
  {
    identity: t.identity().primaryKey(),
    businessId: t.string().index("btree"), // "*" for the platform system actor
    role: t.string(), // owner | system | storefront | shopkeeper | support | bookkeeper
    name: t.string(),
    grantedAt: t.timestamp(),
  },
);

/** One-time codes the system mints so an identity can claim a role (no Identity construction from strings). */
const roleGrant = table(
  { name: "role_grant" },
  {
    code: t.string().primaryKey(),
    businessId: t.string(),
    role: t.string(),
    name: t.string(),
    createdBy: t.identity(),
    expiresAt: t.timestamp(),
    used: t.bool(),
  },
);

/** Live catalog for the storefront, synced from the active configuration on activation. */
const catalogItem = table(
  { name: "catalog_item", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    catalog: t.string(),
    entryId: t.string(),
    data: t.array(FieldValue),
    active: t.bool(),
    configId: t.u64(),
  },
);

const document = table(
  {
    name: "document",
    public: true,
    indexes: [{ accessor: "by_business_type", algorithm: "btree", columns: ["businessId", "docType"] }],
  },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    docType: t.string(),
    number: t.u64(), // per business+docType sequence
    status: t.string(), // "draft" | "posted" | "reversed"
    period: t.string(), // "YYYY-MM"
    externalRef: t.string().index("btree"), // e.g. orderId; "" if none
    fields: t.array(FieldValue),
    lines: t.array(DocLine),
    totalCents: t.i64(), // headline amount for lists (doc.total or doc.amount), 0 if none
    configId: t.u64(), // configuration version the document was created and posted under
    createdBy: t.identity(),
    createdByRole: t.string(),
    approvedBy: t.option(t.identity()),
    approvedByRole: t.string(), // "" until posted
    createdAt: t.timestamp(),
    postedAt: t.option(t.timestamp()),
    reversalOf: t.u64(), // 0 if not a reversal
    reversedBy: t.u64(), // 0 if not reversed
    note: t.string(),
  },
);

const journalLine = table(
  { name: "journal_line", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    documentId: t.u64().index("btree"),
    accountCode: t.string(),
    period: t.string(),
    debitCents: t.i64(),
    creditCents: t.i64(),
    ruleId: t.string(),
    memo: t.string(),
    lineIndex: t.i32(), // -1 for document-scope rules
    postedAt: t.timestamp(),
  },
);

const registerMovement = table(
  { name: "register_movement", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    documentId: t.u64().index("btree"),
    registerId: t.string(),
    dimsKey: t.string(), // canonical "item=choc_chip_cookie"
    kind: t.string(), // "in" | "out"
    qty: t.i64(),
    amountCents: t.i64(),
    period: t.string(),
    postedAt: t.timestamp(),
  },
);

/** Running balances, updated in the same transaction as movements (invariant 3 is checked here). */
const registerBalance = table(
  { name: "register_balance", public: true },
  {
    key: t.string().primaryKey(), // `${businessId}|${registerId}|${dimsKey}`
    businessId: t.string().index("btree"),
    registerId: t.string(),
    dimsKey: t.string(),
    qty: t.i64(),
    amountCents: t.i64(),
  },
);

const period = table(
  { name: "period", public: true },
  {
    key: t.string().primaryKey(), // `${businessId}|YYYY-MM`
    businessId: t.string().index("btree"),
    month: t.string(),
    status: t.string(), // "open" | "closed"
    closedBy: t.option(t.identity()),
    closedAt: t.option(t.timestamp()),
  },
);

/** Customer-facing order state (storefront order page subscribes to one row by id). */
const customerOrder = table(
  { name: "customer_order", public: true },
  {
    id: t.string().primaryKey(), // e.g. "MC-7K2Q9"
    businessId: t.string().index("btree"),
    status: t.string(), // "pending_payment" | "paid" | "ready" | "picked_up" | "refunded" | "partially_refunded" | "cancelled"
    saleDocumentId: t.u64(),
    totalCents: t.i64(),
    paidCents: t.i64(),
    refundedCents: t.i64(),
    customerName: t.string(), // first name only
    channel: t.string(), // "storefront" | "phone" | "agent"
    createdAt: t.timestamp(),
    paidAt: t.option(t.timestamp()),
  },
);

/** Exactly-once payments, step 1: one intent per order, keyed for Stripe idempotency. Private. */
const paymentIntentLog = table(
  { name: "payment_intent_log" },
  {
    orderId: t.string().primaryKey(),
    idempotencyKey: t.string().unique(),
    checkoutSessionId: t.string(),
    checkoutUrl: t.string(),
    status: t.string(), // "created" | "session_attached" | "paid" | "expired"
    createdAt: t.timestamp(),
  },
);

/** Exactly-once payments, step 2: webhook de-duplication. eventId is unique, so a replay is a no-op. */
const processorEvent = table(
  { name: "processor_event", public: true },
  {
    eventId: t.string().primaryKey(),
    businessId: t.string(),
    kind: t.string(), // "payment_succeeded" | "fee" | "refund_succeeded" | "payout"
    orderId: t.string(),
    amountCents: t.i64(),
    documentId: t.u64(), // document it produced, 0 if none
    receivedAt: t.timestamp(),
  },
);

/** Exactly-once payments, step 3: side effects are queued in the same transaction and drained by the brain. */
const outbox = table(
  { name: "outbox", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    kind: t.string(), // "stripe_refund" | "sms" | ...
    payloadJson: t.string(),
    idempotencyKey: t.string().unique(),
    status: t.string(), // "pending" | "claimed" | "done" | "failed"
    attempts: t.u32(),
    createdAt: t.timestamp(),
    claimedAt: t.option(t.timestamp()),
    resultJson: t.string(),
  },
);

const decisionRecord = table(
  { name: "decision_record", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    actorKind: t.string(), // "agent" | "owner" | "system"
    actorId: t.string(), // role name taken from the caller's actor row, never from arguments
    action: t.string(),
    documentRef: t.string(),
    ruleIds: t.array(t.string()),
    evidenceRefs: t.array(t.string()),
    inputsHash: t.string(),
    outcome: t.string(), // "allowed" | "refused" | "escalated" | "executed" | "failed"
    reason: t.string(),
    wouldChangeIf: t.string(),
    timestamp: t.timestamp(),
  },
);

const inboxItem = table(
  { name: "inbox_item", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    fromRole: t.string(),
    question: t.string(),
    contextJson: t.string(),
    documentRef: t.string(),
    status: t.string(), // "open" | "answered"
    answer: t.string(),
    createdAt: t.timestamp(),
    answeredAt: t.option(t.timestamp()),
  },
);

/** Owner answers that agents must follow next time. */
const precedent = table(
  { name: "precedent", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    agentRole: t.string(),
    rule: t.string(),
    conditionJson: t.string(),
    sourceInboxId: t.u64(),
    createdAt: t.timestamp(),
  },
);

/** Owner instructions from any channel; phone ones stay queued until confirmed in the owner app (invariant 6). */
const ownerStatement = table(
  { name: "owner_statement", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    channel: t.string(), // "app" | "phone"
    text: t.string(),
    diffJson: t.string(),
    status: t.string(), // "queued" | "confirmed" | "rejected" | "applied"
    createdAt: t.timestamp(),
    decidedAt: t.option(t.timestamp()),
  },
);

const auditLog = table(
  { name: "audit_log", public: true },
  {
    id: t.u64().primaryKey().autoInc(),
    businessId: t.string().index("btree"),
    actorRole: t.string(),
    reducer: t.string(),
    summary: t.string(),
    ok: t.bool(),
    timestamp: t.timestamp(),
  },
);

const spacetimedb = schema({
  business,
  configVersion,
  actor,
  roleGrant,
  catalogItem,
  document,
  journalLine,
  registerMovement,
  registerBalance,
  period,
  customerOrder,
  paymentIntentLog,
  processorEvent,
  outbox,
  decisionRecord,
  inboxItem,
  precedent,
  ownerStatement,
  auditLog,
});
export default spacetimedb;
