// Napkin Inc. platform reducers. CONTRACT FILE: signatures here are frozen for M1 (client bindings
// are generated from them). Every reducer:
//   1. resolves the caller's role from the actor table via ctx.sender (never from arguments),
//   2. checks the role's permission and the invariants, throwing SenderError on violation
//      (the whole transaction rolls back),
//   3. writes an audit_log row.
// Business with enforce=false is the red-team BASELINE: role/policy/margin/SoD checks are skipped,
// caller-supplied prices are accepted. Balance (invariant 1) and dedupe are never skipped.
//
// Implementation notes (see platform/README.md):
//   - All posting math is @napkin/ledger-core post()/computeDocument()/reversalOf(); this module only moves rows.
//   - Baseline (enforce=false) skips every role check of business reducers (the caller must still be an
//     actor of the business), SoD, policy checks and role limits. Platform administration
//     (claimSystem, registerBusiness, role grants) is always enforced, and so are invariants 1, 3, 7, 8.

import { t } from "spacetimedb/server";
import spacetimedb, { FieldValue, DocLine } from "./schema";
import { Rational } from "@napkin/ledger-core";
import {
  GRANTABLE_ROLES,
  activeConfig,
  audit,
  callerFor,
  catalogData,
  centsToDecimal,
  checkCanApprove,
  declaredFields,
  docDef,
  fail,
  fieldOf,
  fillSaleLine,
  getBusiness,
  hasOwner,
  hoursBetween,
  insertDraft,
  loadConfig,
  makeTimestamp,
  openInboxItem,
  openingLines,
  ownerOnly,
  parseConfigurationJson,
  parseExact,
  planBalances,
  postDraft,
  processorRefFor,
  rationalToString,
  refundFacts,
  requireJson,
  requireRole,
  requireSystemActor,
  reversePosted,
  roleLimit,
  run,
  systemOnly,
  validateProofReport,
  actorOf,
  type BusinessRow,
  type Caller,
  type Ctx,
  type DocLineT,
  type DocRow,
  type FieldValueT,
  type OrderRow,
} from "./core";

export default spacetimedb;

const OrderLine = t.object("OrderLine", { productId: t.string(), qty: t.u32() });

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[a-z0-9-]{1,64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const CHANNELS = ["storefront", "phone", "agent"];
const OUTCOMES = ["allowed", "refused", "escalated", "executed", "failed"];
const PROCESSOR_KINDS = ["payment_succeeded", "fee", "refund_succeeded", "payout"];
const STALE_CLAIM_MICROS = 5n * 60n * 1_000_000n;
/** Documents that only recordProcessorEvent creates (deduped by processor event id, invariant 7). */
const PROCESSOR_DOC_TYPES = ["payment_received", "processor_fee", "payout"];

// ---------- identity & roles ----------

/** First caller when no system actor exists becomes the platform "system" actor (the brain). */
export const claimSystem = spacetimedb.reducer((ctx) =>
  run("claimSystem", () => {
    for (const a of ctx.db.actor.iter()) if (a.role === "system") fail("a system actor already exists");
    if (actorOf(ctx)) fail("this identity already has a role");
    ctx.db.actor.insert({ identity: ctx.sender, businessId: "*", role: "system", name: "system", grantedAt: ctx.timestamp });
    audit(ctx, "*", "system", "claimSystem", `system actor claimed by ${ctx.sender.toHexString().slice(0, 16)}…`);
  }),
);

/** system or owner: mint a one-time code that lets another identity claim `role` for `businessId`. */
export const createRoleGrant = spacetimedb.reducer(
  { code: t.string(), businessId: t.string(), role: t.string(), name: t.string(), ttlSeconds: t.u32() },
  (ctx, args) =>
    run("createRoleGrant", () => {
      // Platform administration: always enforced, also for baseline businesses.
      const biz = getBusiness(ctx, args.businessId);
      const caller = callerFor(ctx, biz.id);
      if (caller.role !== "system" && caller.role !== "owner") fail(`permission denied: role "${caller.role}" cannot grant roles`);
      if (!(GRANTABLE_ROLES as readonly string[]).includes(args.role)) fail(`role "${args.role}" cannot be granted (grantable: ${GRANTABLE_ROLES.join(", ")})`);
      if (args.role === "owner" && caller.role !== "system") fail("only the system actor (after owner authentication) can grant the owner role");
      if (args.code.length < 8 || args.code.length > 128) fail("grant code must be 8-128 characters");
      if (args.ttlSeconds === 0) fail("ttlSeconds must be positive");
      if (ctx.db.roleGrant.code.find(args.code)) fail("grant code already exists");
      ctx.db.roleGrant.insert({
        code: args.code,
        businessId: biz.id,
        role: args.role,
        name: args.name,
        createdBy: ctx.sender,
        expiresAt: makeTimestamp(ctx, ctx.timestamp.microsSinceUnixEpoch + BigInt(args.ttlSeconds) * 1_000_000n),
        used: false,
      });
      audit(ctx, biz.id, caller.role, "createRoleGrant", `grant for ${args.role} "${args.name}" (ttl ${args.ttlSeconds}s)`);
    }),
);

/** any identity: claim the role behind an unexpired, unused code. */
export const redeemRoleGrant = spacetimedb.reducer({ code: t.string() }, (ctx, args) =>
  run("redeemRoleGrant", () => {
    const g = ctx.db.roleGrant.code.find(args.code) ?? fail("unknown grant code");
    if (g.used) fail("grant code already used");
    if (g.expiresAt.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) fail("grant code expired");
    const existing = actorOf(ctx);
    if (existing && !(existing.businessId === g.businessId && existing.role === g.role)) {
      fail(`this identity already has role "${existing.role}" for "${existing.businessId}"`);
    }
    if (!existing) ctx.db.actor.insert({ identity: ctx.sender, businessId: g.businessId, role: g.role, name: g.name, grantedAt: ctx.timestamp });
    ctx.db.roleGrant.code.update({ ...g, used: true });
    audit(ctx, g.businessId, g.role, "redeemRoleGrant", `${g.role} "${g.name}" claimed`);
  }),
);

// ---------- business & configuration ----------

/** system: create a business. enforce=false creates a red-team baseline business (immutable after creation). */
export const registerBusiness = spacetimedb.reducer({ id: t.string(), name: t.string(), enforce: t.bool() }, (ctx, args) =>
  run("registerBusiness", () => {
    requireSystemActor(ctx);
    if (!SLUG.test(args.id)) fail("business id must be a slug: a-z, 0-9 and -");
    if (args.name.trim() === "") fail("business name is required");
    if (ctx.db.business.id.find(args.id)) fail(`business "${args.id}" already exists`);
    ctx.db.business.insert({ id: args.id, name: args.name, activeConfigId: 0n, enforce: args.enforce, createdAt: ctx.timestamp });
    audit(ctx, args.id, "system", "registerBusiness", `${args.name}${args.enforce ? "" : " (BASELINE: enforce=false)"}`);
  }),
);

/**
 * system: store a compiled Configuration as "pending". Rejects JSON that does not parse, documents whose
 * expressions do not compile, and any proof report containing a "failed" proof (never accept failed proofs).
 */
export const submitConfiguration = spacetimedb.reducer({ businessId: t.string(), json: t.string(), proofReportJson: t.string() }, (ctx, args) =>
  run("submitConfiguration", () => {
    const biz = getBusiness(ctx, args.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "submit configurations");
    const cfg = parseConfigurationJson(args.json);
    if (cfg.businessId !== biz.id) fail(`configuration is for "${cfg.businessId}", not "${biz.id}"`);
    validateProofReport(args.proofReportJson);
    if (cfg.proofReport) validateProofReport(JSON.stringify(cfg.proofReport));
    openingLines(cfg); // initialStock must be valued from the catalog (fails early, never assumed)
    let version = 0;
    for (const c of ctx.db.configVersion.businessId.filter(biz.id)) if (c.version > version) version = c.version;
    const row = ctx.db.configVersion.insert({
      id: 0n,
      businessId: biz.id,
      version: version + 1,
      json: args.json,
      proofReportJson: args.proofReportJson,
      status: "pending",
      submittedBy: ctx.sender,
      submittedAt: ctx.timestamp,
      activatedBy: undefined,
      activatedAt: undefined,
    });
    audit(ctx, biz.id, caller.role, "submitConfiguration", `config ${row.id} (v${row.version}, "${cfg.id}") pending`);
  }),
);

/**
 * owner: make a pending configuration active (prices/policies change ONLY here, invariant 6).
 * Exception: system may activate when the business has no active config and no owner yet (bootstrap).
 * Syncs catalog_item rows; on first activation posts an opening_balance document from initialStock.
 */
export const activateConfiguration = spacetimedb.reducer({ configId: t.u64() }, (ctx, args) =>
  run("activateConfiguration", () => {
    const row = ctx.db.configVersion.id.find(args.configId) ?? fail(`unknown configuration ${args.configId}`);
    const biz = getBusiness(ctx, row.businessId);
    const caller = callerFor(ctx, biz.id);
    const bootstrap = caller.role === "system" && biz.activeConfigId === 0n && !hasOwner(ctx, biz.id);
    if (!bootstrap) ownerOnly(biz, caller, "activate configurations (prices and policies change only through the owner)");
    if (row.status !== "pending") fail(`configuration ${row.id} is ${row.status}, not pending`);
    const { cfg } = loadConfig(ctx, row.id);
    const first = biz.activeConfigId === 0n;

    if (!first) {
      const prev = ctx.db.configVersion.id.find(biz.activeConfigId);
      if (prev) ctx.db.configVersion.id.update({ ...prev, status: "superseded" });
    }
    ctx.db.configVersion.id.update({ ...row, status: "active", activatedBy: ctx.sender, activatedAt: ctx.timestamp });
    const updatedBiz = ctx.db.business.id.update({ ...biz, activeConfigId: row.id });

    for (const item of ctx.db.catalogItem.businessId.filter(biz.id)) if (item.active) ctx.db.catalogItem.id.update({ ...item, active: false });
    let items = 0;
    for (const c of cfg.catalogs) {
      for (const e of c.entries) {
        ctx.db.catalogItem.insert({ id: 0n, businessId: biz.id, catalog: c.id, entryId: e.id, data: catalogData(e.data), active: true, configId: row.id });
        items++;
      }
    }

    let opening = "";
    const lines = openingLines(cfg);
    if (first && lines.length > 0) {
      let already = false;
      for (const d of ctx.db.document.by_business_type.filter([biz.id, "opening_balance"])) if (d.status === "posted") already = true;
      if (!already) {
        const def = docDef(cfg, "opening_balance");
        requireRole(updatedBiz, caller, def.approval.creatorRoles, "post opening stock");
        const { row: draft } = insertDraft(ctx, updatedBiz, row.id, caller, { docType: "opening_balance", externalRef: "", fields: [], lines, note: "opening stock from the configuration's initialStock" });
        checkCanApprove(updatedBiz, def, draft, caller);
        const posted = postDraft(ctx, updatedBiz, draft, caller);
        opening = `; opening stock posted as document ${posted.id}`;
      }
    }
    audit(ctx, biz.id, caller.role, "activateConfiguration", `config ${row.id} (v${row.version}) active; ${items} catalog items${opening}`);
  }),
);

/** owner: reject a pending configuration. */
export const rejectConfiguration = spacetimedb.reducer({ configId: t.u64(), reason: t.string() }, (ctx, args) =>
  run("rejectConfiguration", () => {
    const row = ctx.db.configVersion.id.find(args.configId) ?? fail(`unknown configuration ${args.configId}`);
    const biz = getBusiness(ctx, row.businessId);
    const caller = callerFor(ctx, biz.id);
    ownerOnly(biz, caller, "reject configurations");
    if (row.status !== "pending") fail(`configuration ${row.id} is ${row.status}, not pending`);
    ctx.db.configVersion.id.update({ ...row, status: "rejected" });
    audit(ctx, biz.id, caller.role, "rejectConfiguration", `config ${row.id} rejected: ${args.reason}`);
  }),
);

// ---------- orders & documents ----------

interface SaleRequest {
  orderId: string;
  customerName: string;
  channel: string;
  discountRate: string;
  couponCode: string;
  lines: DocLineT[];
  note: string;
}

/** Shared by createOrder and createDocument(sale): sale draft + customer_order, checked now. */
function createSale(ctx: Ctx, biz: BusinessRow, caller: Caller, req: SaleRequest): { order: OrderRow; sale: DocRow } {
  const cc = activeConfig(ctx, biz);
  const def = docDef(cc.cfg, "sale");
  if (def.approval.postOn !== "payment") fail(`sale documents must post on payment (configuration says "${def.approval.postOn}")`);
  requireRole(biz, caller, def.approval.creatorRoles, "create sales");
  if (!ID.test(req.orderId)) fail("orderId must be 1-64 characters of A-Z a-z 0-9 _ -");
  if (ctx.db.customerOrder.id.find(req.orderId)) fail(`order ${req.orderId} already exists`);
  if (!CHANNELS.includes(req.channel)) fail(`channel must be one of ${CHANNELS.join(", ")}`);
  if (req.customerName.length > 64) fail("customerName is too long (first name only)");
  if (req.lines.length === 0) fail("an order needs at least one line");
  const rate = parseExact(req.discountRate, "discountRate");
  if (biz.enforce && caller.role !== "owner") {
    const lim = roleLimit(cc.cfg, caller.role, "maxDiscount");
    if (lim && rate.gt(lim)) fail(`role limit: ${caller.role} may give at most ${lim.toDecimal()} discount, asked ${rate.toDecimal()}`);
  }
  if (biz.enforce && req.couponCode !== "" && !cc.cfg.policies.couponsAllowed) fail("invariant 4 (policy): coupons are not allowed");

  const fields = declaredFields(def, { orderId: req.orderId, customerRef: req.customerName, discountRate: req.discountRate, couponCode: req.couponCode });
  // Dry-run post() (policy checks: discount cap, margin floor) happens inside insertDraft; refused orders roll back.
  const { row: sale, result } = insertDraft(ctx, biz, biz.activeConfigId, caller, { docType: "sale", externalRef: req.orderId, fields, lines: req.lines, note: req.note });
  planBalances(ctx, biz, cc.cfg, result.movements); // invariant 3: stock available now (nothing written)
  if (biz.enforce && sale.totalCents <= 0n) fail("order total must be positive");
  const order = ctx.db.customerOrder.insert({
    id: req.orderId,
    businessId: biz.id,
    status: "pending_payment",
    saleDocumentId: sale.id,
    totalCents: sale.totalCents,
    paidCents: 0n,
    refundedCents: 0n,
    customerName: req.customerName,
    channel: req.channel,
    createdAt: ctx.timestamp,
    paidAt: undefined,
  });
  return { order, sale };
}

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
  (ctx, args) =>
    run("createOrder", () => {
      const biz = getBusiness(ctx, args.businessId);
      const caller = callerFor(ctx, biz.id);
      const cc = activeConfig(ctx, biz);
      const lines = args.lines.map((l) => fillSaleLine(cc.cfg, l.productId, String(l.qty)));
      const { order } = createSale(ctx, biz, caller, {
        orderId: args.orderId,
        customerName: args.customerName,
        channel: args.channel,
        discountRate: args.discountRate === "" ? "0" : args.discountRate,
        couponCode: args.couponCode,
        lines,
        note: "",
      });
      audit(ctx, biz.id, caller.role, "createOrder", `order ${order.id} (${args.channel}) total ${centsToDecimal(order.totalCents)}, discount ${args.discountRate || "0"}`);
    }),
);

const NEXT_STATUS: Record<string, string[]> = {
  ready: ["paid", "partially_refunded"],
  picked_up: ["paid", "ready", "partially_refunded"],
};

/** owner | shopkeeper: move a paid order to "ready" or "picked_up". */
export const updateOrderStatus = spacetimedb.reducer({ orderId: t.string(), status: t.string() }, (ctx, args) =>
  run("updateOrderStatus", () => {
    const order = ctx.db.customerOrder.id.find(args.orderId) ?? fail(`unknown order ${args.orderId}`);
    const biz = getBusiness(ctx, order.businessId);
    const caller = callerFor(ctx, biz.id);
    requireRole(biz, caller, ["shopkeeper"], "update order status");
    const from = NEXT_STATUS[args.status] ?? fail(`status must be "ready" or "picked_up"`);
    if (!from.includes(order.status)) fail(`order ${order.id} is ${order.status}; cannot move to ${args.status}`);
    ctx.db.customerOrder.id.update({ ...order, status: args.status });
    audit(ctx, biz.id, caller.role, "updateOrderStatus", `order ${order.id}: ${order.status} -> ${args.status}`);
  }),
);

/**
 * role in the doc type's creatorRoles: create a draft (or post immediately when postOn = "create").
 * payment_received, processor_fee and payout are refused for every role: only recordProcessorEvent creates them.
 */
export const createDocument = spacetimedb.reducer(
  { businessId: t.string(), docType: t.string(), externalRef: t.string(), fields: t.array(FieldValue), lines: t.array(DocLine), note: t.string() },
  (ctx, args) =>
    run("createDocument", () => {
      const biz = getBusiness(ctx, args.businessId);
      const caller = callerFor(ctx, biz.id);
      // Invariant 7, for every role and also for the baseline: processor documents exist only through
      // recordProcessorEvent, so a payment, fee or payout can never be booked twice or without an event.
      if (PROCESSOR_DOC_TYPES.includes(args.docType)) {
        fail(`invariant 7 (exactly-once payments): ${args.docType} documents are created only by recordProcessorEvent (deduplicated by processor event id), never directly with createDocument`);
      }
      const cc = activeConfig(ctx, biz);
      const def = docDef(cc.cfg, args.docType);
      requireRole(biz, caller, def.approval.creatorRoles, `create ${def.id} documents`);

      if (def.approval.postOn === "payment") {
        // A payment-posted (sale) document is an order: it gets a customer_order so a payment can post it.
        const orderId = fieldOf(args.fields, "orderId") || args.externalRef;
        if (args.externalRef !== "" && orderId !== args.externalRef) fail("externalRef must equal the orderId field");
        const lines = args.lines.map((l, i) => {
          const vals = Object.fromEntries(l.values.map((v) => [v.name, v.value]));
          const productId = vals["productId"] ?? fail(`line ${i}: productId is required`);
          const qty = vals["qty"] ?? fail(`line ${i}: qty is required`);
          if (!biz.enforce) return fillSaleLine(cc.cfg, productId, qty, vals); // BASELINE: caller-supplied prices accepted
          const filled = fillSaleLine(cc.cfg, productId, qty);
          for (const fv of filled.values) {
            const given = vals[fv.name];
            if (given !== undefined && !parseSame(given, fv.value)) {
              fail(`invariant 6: line ${i} ${fv.name} comes from the active catalog (${fv.value}), not the caller (${given})`);
            }
          }
          return filled;
        });
        const { order, sale } = createSale(ctx, biz, caller, {
          orderId,
          customerName: fieldOf(args.fields, "customerRef"),
          channel: "agent",
          discountRate: fieldOf(args.fields, "discountRate") || "0",
          couponCode: fieldOf(args.fields, "couponCode"),
          lines,
          note: args.note,
        });
        audit(ctx, biz.id, caller.role, "createDocument", `sale #${sale.number} for order ${order.id}, total ${centsToDecimal(order.totalCents)}`);
        return;
      }

      if (biz.enforce && def.id === "refund") fail("refunds are created with requestRefund (the platform fills the sale facts, never the caller)");
      const { row } = insertDraft(ctx, biz, biz.activeConfigId, caller, { docType: def.id, externalRef: args.externalRef, fields: args.fields, lines: args.lines, note: args.note });
      let summary = `${def.id} #${row.number} draft`;
      if (def.approval.postOn === "create") {
        checkCanApprove(biz, def, row, caller);
        const posted = postDraft(ctx, biz, row, caller);
        summary = `${def.id} #${posted.number} posted, ${centsToDecimal(posted.totalCents)}`;
      }
      audit(ctx, biz.id, caller.role, "createDocument", summary);
    }),
);

function parseSame(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return Rational.parse(a).eq(Rational.parse(b));
  } catch {
    return false;
  }
}

function refundFieldValues(ctx: Ctx, order: OrderRow, amountCents: bigint, reason: string, hoursSinceSale: string): FieldValueT[] {
  const f = refundFacts(ctx, order);
  return [
    { name: "orderId", value: order.id },
    { name: "amount", value: centsToDecimal(amountCents) },
    { name: "reason", value: reason },
    { name: "saleTotal", value: rationalToString(f.saleTotal) },
    { name: "saleNet", value: rationalToString(f.saleNet) },
    { name: "saleCost", value: rationalToString(f.saleCost) },
    { name: "refundedSoFar", value: centsToDecimal(f.refundedSoFarCents) },
    { name: "hoursSinceSale", value: hoursSinceSale },
  ];
}

/** After a refund posts: queue the processor refund (exactly once) and update the order. */
function afterRefundPosted(ctx: Ctx, biz: BusinessRow, doc: DocRow): string {
  const orderId = fieldOf(doc.fields, "orderId");
  const order = ctx.db.customerOrder.id.find(orderId) ?? fail(`refund ${doc.id}: unknown order ${orderId}`);
  const key = `refund:${doc.id}`;
  if (ctx.db.outbox.idempotencyKey.find(key)) fail(`outbox item ${key} already exists`);
  const payload = {
    businessId: biz.id,
    orderId,
    documentId: doc.id.toString(),
    amountCents: Number(doc.totalCents),
    processorRef: processorRefFor(ctx, biz.id, orderId),
    reason: fieldOf(doc.fields, "reason"),
  };
  ctx.db.outbox.insert({ id: 0n, businessId: biz.id, kind: "stripe_refund", payloadJson: JSON.stringify(payload), idempotencyKey: key, status: "pending", attempts: 0, createdAt: ctx.timestamp, claimedAt: undefined, resultJson: "" });
  const refunded = order.refundedCents + doc.totalCents;
  ctx.db.customerOrder.id.update({ ...order, refundedCents: refunded, status: refunded >= order.totalCents ? "refunded" : "partially_refunded" });
  return key;
}

/**
 * role in approverRoles, and not the creator when cannotApproveOwn (invariant 5): post a draft.
 * Runs ledger-core post() (policy checks + balance, invariants 1 and 4), checks the period is open (8)
 * and that no balance register goes negative (3), then writes journal lines, movements and balances.
 */
export const postDocument = spacetimedb.reducer({ documentId: t.u64() }, (ctx, args) =>
  run("postDocument", () => {
    let doc = ctx.db.document.id.find(args.documentId) ?? fail(`unknown document ${args.documentId}`);
    const biz = getBusiness(ctx, doc.businessId);
    const caller = callerFor(ctx, biz.id);
    if (doc.status !== "draft") fail(`invariant 8 (immutable): document ${doc.id} is ${doc.status}; only drafts can be posted`);
    const { cfg } = loadConfig(ctx, doc.configId);
    const def = docDef(cfg, doc.docType);
    checkCanApprove(biz, def, doc, caller);
    if (def.approval.postOn === "payment") {
      const order = ctx.db.customerOrder.id.find(doc.externalRef);
      if (!order || order.paidCents < order.totalCents) fail(`${def.id} #${doc.number} posts when its payment arrives (order is not paid)`);
    }
    if (def.id === "refund") {
      if (biz.enforce && caller.role !== "owner") {
        const lim = roleLimit(cfg, caller.role, "maxRefundCents");
        if (lim && Rational.fromCents(doc.totalCents).gt(lim.div(Rational.of(100n)))) fail(`role limit: ${caller.role} may approve refunds up to ${lim.toDecimal()} cents`);
      }
      // Re-derive the sale facts now: another refund may have posted since this one was requested.
      const order = ctx.db.customerOrder.id.find(fieldOf(doc.fields, "orderId")) ?? fail("refund for an unknown order");
      const fresh = refundFieldValues(ctx, order, doc.totalCents, fieldOf(doc.fields, "reason"), fieldOf(doc.fields, "hoursSinceSale"));
      doc = ctx.db.document.id.update({ ...doc, fields: fresh });
    }
    const posted = postDraft(ctx, biz, doc, caller);
    let extra = "";
    if (def.id === "refund") extra = `; queued ${afterRefundPosted(ctx, biz, posted)}`;
    audit(ctx, biz.id, caller.role, "postDocument", `${def.id} #${posted.number} posted, ${centsToDecimal(posted.totalCents)}${extra}`);
  }),
);

/**
 * owner | bookkeeper: post a reversal document; the original becomes "reversed" (never edited).
 * Refused for processor documents (payment_received, processor_fee, payout), for a sale whose order is paid
 * and not fully refunded (refund first via requestRefund), for a refund whose order's sale was reversed, and
 * for a refund whose processor refund is in flight or sent.
 */
export const reverseDocument = spacetimedb.reducer({ documentId: t.u64(), reason: t.string() }, (ctx, args) =>
  run("reverseDocument", () => {
    const doc = ctx.db.document.id.find(args.documentId) ?? fail(`unknown document ${args.documentId}`);
    const biz = getBusiness(ctx, doc.businessId);
    const caller = callerFor(ctx, biz.id);
    requireRole(biz, caller, ["bookkeeper"], "reverse documents");
    if (args.reason.trim() === "") fail("a reversal needs a reason");
    // Money that the processor moved cannot be un-moved in the ledger (also on the baseline): reversing a
    // payment, fee or payout would make the books disagree with the processor. A wrong amount is an inbox item.
    if (PROCESSOR_DOC_TYPES.includes(doc.docType)) {
      fail(`${doc.docType} #${doc.number} records money the processor moved; processor documents cannot be reversed (refund the customer with requestRefund instead)`);
    }
    if (doc.docType === "sale" && doc.status === "posted") {
      const order = ctx.db.customerOrder.id.find(doc.externalRef);
      if (order && order.saleDocumentId === doc.id && order.paidCents > 0n && order.refundedCents < order.paidCents) {
        fail(`sale #${doc.number}: order ${order.id} is paid ($${centsToDecimal(order.paidCents)}, refunded $${centsToDecimal(order.refundedCents)}); refund first via requestRefund; reversing a paid sale would leave the customer's money unaccounted`);
      }
    }
    if (doc.docType === "refund") {
      const order = ctx.db.customerOrder.id.find(fieldOf(doc.fields, "orderId"));
      if (order && order.status === "cancelled") {
        // The sale was reversed after this refund: undoing the refund now would leave the payment unaccounted.
        fail(`refund #${doc.number}: order ${order.id} is cancelled (its sale was reversed); reversing the refund would leave the customer's money unaccounted`);
      }
      // Once the processor refund is in flight or done the money has (or may have) left: reversing the
      // ledger entry would make the books disagree with the processor (invariant 2). Ask the owner instead.
      const ob = ctx.db.outbox.idempotencyKey.find(`refund:${doc.id}`);
      if (ob && (ob.status === "claimed" || ob.status === "done")) {
        fail(`refund #${doc.number}: the processor refund is already ${ob.status === "done" ? "sent" : "in flight"}; it cannot be reversed in the ledger`);
      }
    }
    const rev = reversePosted(ctx, biz, doc, caller, args.reason);
    let extra = "";
    if (doc.docType === "sale") {
      const order = ctx.db.customerOrder.id.find(doc.externalRef);
      if (order && order.saleDocumentId === doc.id) {
        ctx.db.customerOrder.id.update({ ...order, status: "cancelled" });
        extra = `; order ${order.id} cancelled`;
      }
    } else if (doc.docType === "refund") {
      const order = ctx.db.customerOrder.id.find(fieldOf(doc.fields, "orderId"));
      if (order) {
        const refunded = order.refundedCents - doc.totalCents;
        ctx.db.customerOrder.id.update({ ...order, refundedCents: refunded, status: refunded <= 0n ? "paid" : "partially_refunded" });
      }
      const ob = ctx.db.outbox.idempotencyKey.find(`refund:${doc.id}`);
      if (ob && (ob.status === "pending" || ob.status === "failed")) {
        ctx.db.outbox.id.update({ ...ob, status: "cancelled", resultJson: JSON.stringify({ cancelled: `refund reversed by document ${rev.id}` }) });
        extra = "; pending processor refund cancelled";
      }
    }
    audit(ctx, biz.id, caller.role, "reverseDocument", `${doc.docType} #${doc.number} reversed by document ${rev.id}: ${args.reason}${extra}`);
  }),
);

/** owner | bookkeeper: close a month; nothing can post into it afterwards. */
export const closePeriod = spacetimedb.reducer({ businessId: t.string(), month: t.string() }, (ctx, args) =>
  run("closePeriod", () => {
    const biz = getBusiness(ctx, args.businessId);
    const caller = callerFor(ctx, biz.id);
    requireRole(biz, caller, ["bookkeeper"], "close periods");
    if (!MONTH.test(args.month)) fail('month must be "YYYY-MM"');
    const key = `${biz.id}|${args.month}`;
    const p = ctx.db.period.key.find(key);
    if (p?.status === "closed") fail(`period ${args.month} is already closed`);
    const row = { key, businessId: biz.id, month: args.month, status: "closed", closedBy: ctx.sender, closedAt: ctx.timestamp };
    if (p) ctx.db.period.key.update(row);
    else ctx.db.period.insert(row);
    audit(ctx, biz.id, caller.role, "closePeriod", `period ${args.month} closed`);
  }),
);

/**
 * support | shopkeeper | owner: create a refund draft for an order. saleTotal, saleNet, saleCost,
 * refundedSoFar and hoursSinceSale are filled by the platform from the order's posted sale.
 * Posting it (by a different role) queues a "stripe_refund" outbox item in the same transaction.
 */
export const requestRefund = spacetimedb.reducer({ orderId: t.string(), amountCents: t.i64(), reason: t.string() }, (ctx, args) =>
  run("requestRefund", () => {
    const order = ctx.db.customerOrder.id.find(args.orderId) ?? fail(`unknown order ${args.orderId}`);
    const biz = getBusiness(ctx, order.businessId);
    const caller = callerFor(ctx, biz.id);
    const cc = activeConfig(ctx, biz);
    const def = docDef(cc.cfg, "refund");
    requireRole(biz, caller, def.approval.creatorRoles, "request refunds");
    if (args.amountCents <= 0n) fail("refund amount must be positive");
    if (biz.enforce && caller.role !== "owner") {
      const lim = roleLimit(cc.cfg, caller.role, "maxRefundCents");
      if (lim && Rational.of(args.amountCents).gt(lim)) fail(`role limit: ${caller.role} may request refunds up to ${lim.toDecimal()} cents`);
    }
    const facts = refundFacts(ctx, order);
    const hours = rationalToString(hoursBetween(facts.sale.postedAt ?? fail("sale has no posting time"), ctx.timestamp));
    const fields = refundFieldValues(ctx, order, args.amountCents, args.reason, hours);
    // Dry-run post(): refund window, not over the sale, full-or-floor (D4) are refused now.
    const { row } = insertDraft(ctx, biz, biz.activeConfigId, caller, { docType: "refund", externalRef: order.id, fields, lines: [], note: args.reason });
    audit(ctx, biz.id, caller.role, "requestRefund", `refund #${row.number} draft for order ${order.id}: ${centsToDecimal(args.amountCents)} (${hours} h after sale)`);
  }),
);

// ---------- payments (exactly-once) ----------

/** system: record the intent before calling Stripe. Unique orderId + idempotencyKey. */
export const logPaymentIntent = spacetimedb.reducer({ orderId: t.string(), idempotencyKey: t.string() }, (ctx, args) =>
  run("logPaymentIntent", () => {
    const order = ctx.db.customerOrder.id.find(args.orderId) ?? fail(`unknown order ${args.orderId}`);
    const biz = getBusiness(ctx, order.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "log payment intents");
    if (args.idempotencyKey.trim() === "") fail("idempotencyKey is required");
    const existing = ctx.db.paymentIntentLog.orderId.find(order.id);
    if (existing) {
      if (existing.idempotencyKey !== args.idempotencyKey) fail(`order ${order.id} already has a payment intent with a different idempotency key`);
      audit(ctx, biz.id, caller.role, "logPaymentIntent", `intent for ${order.id} already logged (idempotent)`);
      return;
    }
    if (order.status !== "pending_payment") fail(`order ${order.id} is ${order.status}, not pending_payment`);
    if (ctx.db.paymentIntentLog.idempotencyKey.find(args.idempotencyKey)) fail("idempotencyKey is already used by another order");
    ctx.db.paymentIntentLog.insert({ orderId: order.id, idempotencyKey: args.idempotencyKey, checkoutSessionId: "", checkoutUrl: "", status: "created", createdAt: ctx.timestamp });
    audit(ctx, biz.id, caller.role, "logPaymentIntent", `intent for ${order.id}`);
  }),
);

/** system: attach the Stripe Checkout Session to the intent. */
export const attachCheckoutSession = spacetimedb.reducer({ orderId: t.string(), checkoutSessionId: t.string(), checkoutUrl: t.string() }, (ctx, args) =>
  run("attachCheckoutSession", () => {
    const order = ctx.db.customerOrder.id.find(args.orderId) ?? fail(`unknown order ${args.orderId}`);
    const biz = getBusiness(ctx, order.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "attach checkout sessions");
    const intent = ctx.db.paymentIntentLog.orderId.find(order.id) ?? fail(`no payment intent logged for ${order.id}`);
    if (intent.status === "paid") fail(`order ${order.id} is already paid`);
    ctx.db.paymentIntentLog.orderId.update({ ...intent, checkoutSessionId: args.checkoutSessionId, checkoutUrl: args.checkoutUrl, status: "session_attached" });
    audit(ctx, biz.id, caller.role, "attachCheckoutSession", `session attached to ${order.id}`);
  }),
);

function processPayment(ctx: Ctx, biz: BusinessRow, caller: Caller, args: { eventId: string; orderId: string; amountCents: bigint; processorRef: string }): { documentId: bigint; summary: string } {
  const order = ctx.db.customerOrder.id.find(args.orderId);
  const ctxInfo = { eventId: args.eventId, orderId: args.orderId, amountCents: args.amountCents, processorRef: args.processorRef };
  if (!order || order.businessId !== biz.id) {
    openInboxItem(ctx, biz.id, "system", `A payment of $${centsToDecimal(args.amountCents)} arrived for unknown order ${args.orderId}. Nothing was posted.`, ctxInfo, args.orderId);
    return { documentId: 0n, summary: `payment for unknown order ${args.orderId}: inbox, nothing posted` };
  }
  if (order.status !== "pending_payment") {
    openInboxItem(ctx, biz.id, "system", `A payment of $${centsToDecimal(args.amountCents)} arrived for order ${order.id}, which is already ${order.status}. Nothing was posted; check for a double charge.`, ctxInfo, order.id);
    return { documentId: 0n, summary: `payment for ${order.status} order ${order.id}: inbox, nothing posted` };
  }
  if (args.amountCents !== order.totalCents) {
    openInboxItem(ctx, biz.id, "system", `Payment for order ${order.id} was $${centsToDecimal(args.amountCents)} but the order total is $${centsToDecimal(order.totalCents)}. Nothing was posted.`, { ...ctxInfo, orderTotalCents: order.totalCents }, order.id);
    return { documentId: 0n, summary: `amount mismatch on ${order.id}: inbox, nothing posted` };
  }
  const cc = activeConfig(ctx, biz);
  const payDef = docDef(cc.cfg, "payment_received");
  requireRole(biz, caller, payDef.approval.creatorRoles, "record payments");
  const fields = declaredFields(payDef, { orderId: order.id, amount: centsToDecimal(args.amountCents), processorRef: args.processorRef });
  const { row: draft } = insertDraft(ctx, biz, biz.activeConfigId, caller, { docType: "payment_received", externalRef: order.id, fields, lines: [], note: `processor event ${args.eventId}` });
  checkCanApprove(biz, payDef, draft, caller);
  const pay = postDraft(ctx, biz, draft, caller);

  // Post the sale as system (it was created by the storefront/shopkeeper, so SoD holds). If it cannot post
  // now (stock ran out since the order, period closed), the money is still booked and the owner is asked.
  let saleNote = "sale posted";
  const sale = ctx.db.document.id.find(order.saleDocumentId);
  if (!sale) fail(`order ${order.id} has no sale document`);
  else if (sale.status === "draft") {
    ctx.db.customerOrder.id.update({ ...order, paidCents: args.amountCents }); // postOn=payment requires the order paid
    try {
      const saleDef = docDef(loadConfig(ctx, sale.configId).cfg, sale.docType);
      checkCanApprove(biz, saleDef, sale, caller);
      postDraft(ctx, biz, sale, caller);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      openInboxItem(ctx, biz.id, "system", `Order ${order.id} was paid ($${centsToDecimal(args.amountCents)}) but its sale could not post: ${msg}. Restock and post the sale, or refund the customer.`, { ...ctxInfo, saleDocumentId: sale.id }, `document:${sale.id}`);
      saleNote = `sale NOT posted (${msg}); inbox opened`;
    }
  }
  const current = ctx.db.customerOrder.id.find(order.id)!;
  ctx.db.customerOrder.id.update({ ...current, status: "paid", paidCents: args.amountCents, paidAt: ctx.timestamp });
  const intent = ctx.db.paymentIntentLog.orderId.find(order.id);
  if (intent) ctx.db.paymentIntentLog.orderId.update({ ...intent, status: "paid" });
  return { documentId: pay.id, summary: `payment ${centsToDecimal(args.amountCents)} for ${order.id} posted as document ${pay.id}; ${saleNote}` };
}

function processMoneyDoc(ctx: Ctx, biz: BusinessRow, caller: Caller, docType: string, values: Record<string, string>, externalRef: string, eventId: string): DocRow {
  const cc = activeConfig(ctx, biz);
  const def = docDef(cc.cfg, docType);
  requireRole(biz, caller, def.approval.creatorRoles, `record ${docType}`);
  const { row } = insertDraft(ctx, biz, biz.activeConfigId, caller, { docType, externalRef, fields: declaredFields(def, values), lines: [], note: `processor event ${eventId}` });
  if (def.approval.postOn !== "create") return row; // e.g. payout: waits for an approver (SoD)
  checkCanApprove(biz, def, row, caller);
  return postDraft(ctx, biz, row, caller);
}

function processRefundSucceeded(ctx: Ctx, biz: BusinessRow, args: { eventId: string; orderId: string; amountCents: bigint; processorRef: string }): { documentId: bigint; summary: string } {
  const items = [...ctx.db.outbox.businessId.filter(biz.id)].filter((o) => o.kind === "stripe_refund").sort((a, b) => (a.id < b.id ? -1 : 1));
  const payloadOf = (o: (typeof items)[number]) => {
    try {
      return JSON.parse(o.payloadJson) as { orderId?: string; amountCents?: number; documentId?: string };
    } catch {
      return {};
    }
  };
  let match = args.processorRef !== "" ? items.find((o) => o.idempotencyKey === args.processorRef || (o.resultJson !== "" && o.resultJson.includes(args.processorRef))) : undefined;
  match ??= items.find((o) => {
    const p = payloadOf(o);
    return o.status !== "done" && o.status !== "cancelled" && p.orderId === args.orderId && p.amountCents !== undefined && BigInt(p.amountCents) === args.amountCents;
  });
  if (!match) {
    openInboxItem(ctx, biz.id, "system", `The processor reports a refund of $${centsToDecimal(args.amountCents)} on order ${args.orderId} that no approved refund asked for. Was it issued outside Napkin?`, args, args.orderId);
    return { documentId: 0n, summary: `unmatched refund on ${args.orderId}: inbox` };
  }
  const docId = BigInt(payloadOf(match).documentId ?? "0");
  const expected = payloadOf(match).amountCents;
  if (expected === undefined || BigInt(expected) !== args.amountCents) {
    openInboxItem(ctx, biz.id, "system", `The processor reports a refund of $${centsToDecimal(args.amountCents)} for ${match.idempotencyKey}, but the approved refund was $${expected === undefined ? "?" : centsToDecimal(BigInt(expected))}. Nothing was changed.`, args, match.idempotencyKey);
    return { documentId: docId, summary: `refund amount mismatch on ${match.idempotencyKey}: inbox` };
  }
  if (match.status === "cancelled") {
    openInboxItem(ctx, biz.id, "system", `The processor refunded $${centsToDecimal(args.amountCents)} for ${match.idempotencyKey}, but that refund was reversed in the ledger. Check with the customer.`, args, match.idempotencyKey);
    return { documentId: docId, summary: `refund ${match.idempotencyKey} was cancelled: inbox` };
  }
  if (match.status === "done") return { documentId: docId, summary: `refund ${match.idempotencyKey} already complete` };
  ctx.db.outbox.id.update({ ...match, status: "done", resultJson: match.resultJson || JSON.stringify({ processorRef: args.processorRef, via: "webhook", eventId: args.eventId }) });
  return { documentId: docId, summary: `refund ${match.idempotencyKey} completed` };
}

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
  (ctx, args) =>
    run("recordProcessorEvent", () => {
      const biz = getBusiness(ctx, args.businessId);
      const caller = callerFor(ctx, biz.id);
      systemOnly(biz, caller, "record processor events");
      if (args.eventId.trim() === "") fail("eventId is required");
      if (ctx.db.processorEvent.eventId.find(args.eventId)) {
        audit(ctx, biz.id, caller.role, "recordProcessorEvent", `duplicate event ${args.eventId} ignored`);
        return; // invariant 7: a replayed webhook changes nothing
      }
      if (!PROCESSOR_KINDS.includes(args.kind)) fail(`kind must be one of ${PROCESSOR_KINDS.join(", ")}`);
      const ev = ctx.db.processorEvent.insert({ eventId: args.eventId, businessId: biz.id, kind: args.kind, orderId: args.orderId, amountCents: args.amountCents, documentId: 0n, receivedAt: ctx.timestamp });
      let out: { documentId: bigint; summary: string };
      switch (args.kind) {
        case "payment_succeeded":
          out = processPayment(ctx, biz, caller, args);
          break;
        case "fee": {
          const d = processMoneyDoc(ctx, biz, caller, "processor_fee", { orderId: args.orderId, fee: centsToDecimal(args.amountCents), processorRef: args.processorRef }, args.orderId, args.eventId);
          out = { documentId: d.id, summary: `fee ${centsToDecimal(args.amountCents)} for ${args.orderId} ${d.status}` };
          break;
        }
        case "refund_succeeded":
          out = processRefundSucceeded(ctx, biz, args);
          break;
        default: {
          const d = processMoneyDoc(ctx, biz, caller, "payout", { amount: centsToDecimal(args.amountCents), processorRef: args.processorRef }, args.processorRef, args.eventId);
          out = { documentId: d.id, summary: `payout ${centsToDecimal(args.amountCents)} ${d.status === "draft" ? "awaiting approval" : d.status} (document ${d.id})` };
        }
      }
      ctx.db.processorEvent.eventId.update({ ...ev, documentId: out.documentId });
      audit(ctx, biz.id, caller.role, "recordProcessorEvent", `${args.kind} ${args.eventId}: ${out.summary}`);
    }),
);

/** system: claim a pending outbox item (status -> claimed, attempts + 1). */
export const claimOutbox = spacetimedb.reducer({ id: t.u64() }, (ctx, args) =>
  run("claimOutbox", () => {
    const item = ctx.db.outbox.id.find(args.id) ?? fail(`unknown outbox item ${args.id}`);
    const biz = getBusiness(ctx, item.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "claim outbox items");
    const stale = item.status === "claimed" && !!item.claimedAt && ctx.timestamp.microsSinceUnixEpoch - item.claimedAt.microsSinceUnixEpoch > STALE_CLAIM_MICROS;
    if (item.status !== "pending" && item.status !== "failed" && !stale) fail(`outbox item ${item.id} is ${item.status}`);
    ctx.db.outbox.id.update({ ...item, status: "claimed", attempts: item.attempts + 1, claimedAt: ctx.timestamp });
    audit(ctx, biz.id, caller.role, "claimOutbox", `${item.kind} ${item.idempotencyKey} claimed (attempt ${item.attempts + 1})`);
  }),
);

/** system: finish an outbox item. */
export const completeOutbox = spacetimedb.reducer({ id: t.u64(), ok: t.bool(), resultJson: t.string() }, (ctx, args) =>
  run("completeOutbox", () => {
    const item = ctx.db.outbox.id.find(args.id) ?? fail(`unknown outbox item ${args.id}`);
    const biz = getBusiness(ctx, item.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "complete outbox items");
    if (item.status === "done") {
      audit(ctx, biz.id, caller.role, "completeOutbox", `${item.idempotencyKey} already done (idempotent)`);
      return;
    }
    if (item.status !== "claimed") fail(`outbox item ${item.id} is ${item.status}; claim it first`);
    ctx.db.outbox.id.update({ ...item, status: args.ok ? "done" : "failed", resultJson: args.resultJson });
    if (!args.ok && item.kind === "stripe_refund") {
      openInboxItem(ctx, biz.id, "system", `The processor refund ${item.idempotencyKey} failed (attempt ${item.attempts}). The ledger already shows the refund; retry or contact the customer.`, { outboxId: item.id, result: args.resultJson }, item.idempotencyKey);
    }
    audit(ctx, biz.id, caller.role, "completeOutbox", `${item.idempotencyKey} ${args.ok ? "done" : "failed"}`);
  }),
);

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
  (ctx, args) =>
    run("recordDecision", () => {
      const biz = getBusiness(ctx, args.businessId);
      const caller = callerFor(ctx, biz.id);
      if (!OUTCOMES.includes(args.outcome)) fail(`outcome must be one of ${OUTCOMES.join(", ")}`);
      if (args.action.trim() === "") fail("action is required");
      const actorKind = caller.role === "owner" ? "owner" : caller.role === "system" ? "system" : "agent";
      const row = ctx.db.decisionRecord.insert({ id: 0n, businessId: biz.id, actorKind, actorId: caller.role, action: args.action, documentRef: args.documentRef, ruleIds: args.ruleIds, evidenceRefs: args.evidenceRefs, inputsHash: args.inputsHash, outcome: args.outcome, reason: args.reason, wouldChangeIf: args.wouldChangeIf, timestamp: ctx.timestamp });
      audit(ctx, biz.id, caller.role, "recordDecision", `decision ${row.id}: ${args.action} ${args.outcome}`);
    }),
);

/** any actor of the business: escalate a question to the owner inbox. */
export const openInbox = spacetimedb.reducer({ businessId: t.string(), question: t.string(), contextJson: t.string(), documentRef: t.string() }, (ctx, args) =>
  run("openInbox", () => {
    const biz = getBusiness(ctx, args.businessId);
    const caller = callerFor(ctx, biz.id);
    if (args.question.trim() === "") fail("question is required");
    requireJson(args.contextJson, "contextJson");
    const row = ctx.db.inboxItem.insert({ id: 0n, businessId: biz.id, fromRole: caller.role, question: args.question, contextJson: args.contextJson, documentRef: args.documentRef, status: "open", answer: "", createdAt: ctx.timestamp, answeredAt: undefined });
    audit(ctx, biz.id, caller.role, "openInbox", `inbox ${row.id} opened`);
  }),
);

/** owner: answer an inbox item; optionally store the answer as a precedent for the asking role. */
export const answerInbox = spacetimedb.reducer({ id: t.u64(), answer: t.string(), makePrecedent: t.bool(), precedentRule: t.string(), conditionJson: t.string() }, (ctx, args) =>
  run("answerInbox", () => {
    const item = ctx.db.inboxItem.id.find(args.id) ?? fail(`unknown inbox item ${args.id}`);
    const biz = getBusiness(ctx, item.businessId);
    const caller = callerFor(ctx, biz.id);
    ownerOnly(biz, caller, "answer the inbox");
    if (item.status !== "open") fail(`inbox item ${item.id} is already ${item.status}`);
    if (args.answer.trim() === "") fail("answer is required");
    requireJson(args.conditionJson, "conditionJson");
    ctx.db.inboxItem.id.update({ ...item, status: "answered", answer: args.answer, answeredAt: ctx.timestamp });
    let extra = "";
    if (args.makePrecedent) {
      const p = ctx.db.precedent.insert({ id: 0n, businessId: biz.id, agentRole: item.fromRole, rule: args.precedentRule || args.answer, conditionJson: args.conditionJson, sourceInboxId: item.id, createdAt: ctx.timestamp });
      extra = `; precedent ${p.id} for ${item.fromRole}`;
    }
    audit(ctx, biz.id, caller.role, "answerInbox", `inbox ${item.id} answered${extra}`);
  }),
);

/** system (verified phone owner, via the brain) | owner: queue an owner statement with its proposed diff. */
export const queueOwnerStatement = spacetimedb.reducer({ businessId: t.string(), channel: t.string(), text: t.string(), diffJson: t.string() }, (ctx, args) =>
  run("queueOwnerStatement", () => {
    const biz = getBusiness(ctx, args.businessId);
    const caller = callerFor(ctx, biz.id);
    requireRole(biz, caller, ["system"], "queue owner statements");
    if (args.channel !== "app" && args.channel !== "phone") fail('channel must be "app" or "phone"');
    if (args.text.trim() === "") fail("text is required");
    requireJson(args.diffJson, "diffJson");
    const row = ctx.db.ownerStatement.insert({ id: 0n, businessId: biz.id, channel: args.channel, text: args.text, diffJson: args.diffJson, status: "queued", createdAt: ctx.timestamp, decidedAt: undefined });
    audit(ctx, biz.id, caller.role, "queueOwnerStatement", `statement ${row.id} queued (${args.channel})`);
  }),
);

/** owner ONLY (the authenticated app identity): confirm or reject a queued statement. */
export const decideOwnerStatement = spacetimedb.reducer({ id: t.u64(), confirm: t.bool() }, (ctx, args) =>
  run("decideOwnerStatement", () => {
    const st = ctx.db.ownerStatement.id.find(args.id) ?? fail(`unknown owner statement ${args.id}`);
    const biz = getBusiness(ctx, st.businessId);
    const caller = callerFor(ctx, biz.id);
    ownerOnly(biz, caller, "decide owner statements");
    if (st.status !== "queued") fail(`statement ${st.id} is ${st.status}, not queued`);
    ctx.db.ownerStatement.id.update({ ...st, status: args.confirm ? "confirmed" : "rejected", decidedAt: ctx.timestamp });
    audit(ctx, biz.id, caller.role, "decideOwnerStatement", `statement ${st.id} ${args.confirm ? "confirmed" : "rejected"}`);
  }),
);

/** system: mark a confirmed statement applied (after its configuration change was activated by the owner). */
export const markOwnerStatementApplied = spacetimedb.reducer({ id: t.u64() }, (ctx, args) =>
  run("markOwnerStatementApplied", () => {
    const st = ctx.db.ownerStatement.id.find(args.id) ?? fail(`unknown owner statement ${args.id}`);
    const biz = getBusiness(ctx, st.businessId);
    const caller = callerFor(ctx, biz.id);
    systemOnly(biz, caller, "mark statements applied");
    if (st.status !== "confirmed") fail(`statement ${st.id} is ${st.status}; only confirmed statements can be applied`);
    ctx.db.ownerStatement.id.update({ ...st, status: "applied" });
    audit(ctx, biz.id, caller.role, "markOwnerStatementApplied", `statement ${st.id} applied`);
  }),
);
