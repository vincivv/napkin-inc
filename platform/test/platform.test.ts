// Reducer tests against the real module, in-process (spacetimedb/server/test-utils + vitest).
// Each test builds a fresh database; identities are separate JWT subjects per actor.

import { describe, it, expect, beforeEach } from "vitest";
import {
  World,
  bootMaya,
  grant,
  mayaConfig,
  trialBalanceSum,
  balances,
  stock,
  order,
  doc,
  docsOf,
  openInbox,
  snapshot,
  line,
  createOrder,
  pay,
  sell,
  lastDoc,
  HOUR,
  type Biz,
} from "./helpers";

const BIZ = "maya-cookies";

describe("bootstrap", () => {
  it("claims system, registers, activates Maya's config, grants roles, posts opening stock", () => {
    const w = new World();
    const b = bootMaya(w);

    const actors = w.rows("actor");
    expect(actors.map((a) => a.role).sort()).toEqual(["bookkeeper", "owner", "shopkeeper", "storefront", "support", "system"]);
    expect(actors.find((a) => a.role === "system")!.businessId).toBe("*");

    const biz = w.db.business.id.find(BIZ);
    expect(biz.enforce).toBe(true);
    expect(biz.activeConfigId).toBe(b.configId);
    expect(w.db.configVersion.id.find(b.configId).status).toBe("active");
    expect(w.rows("catalogItem").filter((c) => c.active).map((c) => c.entryId).sort()).toEqual(["choc_chip_cookie", "cookie_box6", "cookie_single", "sea_salt"]);

    const opening = docsOf(w, BIZ, "opening_balance");
    expect(opening).toHaveLength(1);
    expect(opening[0].status).toBe("posted");
    expect(stock(w, BIZ)).toBe(48n);
    expect(balances(w, BIZ)).toEqual({ "1300": 3840n, "3000": -3840n }); // 48 x 0.80 (placeholder cost)
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });

  it("only the first caller can claim system; only system registers businesses", () => {
    const w = new World();
    w.call(w.system, "claimSystem", {} as never);
    const other = w.identity("intruder");
    expect(() => w.call(other, "claimSystem", {} as never)).toThrow(/system actor already exists/);
    expect(() => w.call(other, "registerBusiness", { id: "evil", name: "Evil", enforce: true })).toThrow(/only the platform system actor/);
  });

  it("role grants: one-time, expiring, owner only via system, unknown identities have no role", () => {
    const w = new World();
    const b = bootMaya(w);
    const x = w.identity("x");
    expect(() => w.call(x, "createOrder", { businessId: BIZ, orderId: "o1", customerName: "", channel: "storefront", discountRate: "0", couponCode: "", lines: [line("cookie_single", 1)] })).toThrow(/no role/);

    w.call(w.system, "createRoleGrant", { code: "code-once-123", businessId: BIZ, role: "support", name: "s2", ttlSeconds: 60 });
    w.call(x, "redeemRoleGrant", { code: "code-once-123" });
    expect(() => w.call(w.identity("y"), "redeemRoleGrant", { code: "code-once-123" })).toThrow(/already used/);
    expect(() => w.call(w.identity("y"), "redeemRoleGrant", { code: "nope-nope-nope" })).toThrow(/unknown grant code/);

    w.call(w.system, "createRoleGrant", { code: "code-expire-1", businessId: BIZ, role: "support", name: "s3", ttlSeconds: 60 });
    w.advance(61n * 1_000_000n);
    expect(() => w.call(w.identity("z"), "redeemRoleGrant", { code: "code-expire-1" })).toThrow(/expired/);

    expect(() => w.call(b.actors.owner, "createRoleGrant", { code: "code-owner-1", businessId: BIZ, role: "owner", name: "o2", ttlSeconds: 60 })).toThrow(/only the system actor/);
    expect(() => w.call(b.actors.support, "createRoleGrant", { code: "code-supp-1", businessId: BIZ, role: "support", name: "s4", ttlSeconds: 60 })).toThrow(/cannot grant roles/);
    expect(() => w.call(b.actors.owner, "createRoleGrant", { code: "code-sys-1", businessId: BIZ, role: "system", name: "s", ttlSeconds: 60 })).toThrow(/cannot be granted/);
    grant(w, b.actors.owner, w.identity("shop2"), BIZ, "shopkeeper");
  });

  it("submitConfiguration rejects bad JSON, wrong business, failed proofs, and non-system callers", () => {
    const w = new World();
    const b = bootMaya(w);
    const sub = (json: string, proofReportJson = "", who = w.system) => w.call(who, "submitConfiguration", { businessId: BIZ, json, proofReportJson });
    expect(() => sub("{not json")).toThrow(/does not parse/);
    expect(() => sub(mayaConfig("someone-else"))).toThrow(/not "maya-cookies"/);
    expect(() => sub(mayaConfig(BIZ, (c) => (c.documents[0].derived[0].expr = "line.qty *")))).toThrow(/semantic issue|does not parse/);
    const failed = { balanceProof: { status: "failed", details: [] }, discountProof: { status: "proved", details: [] }, flowCheck: { status: "proved", details: [] }, synthesisLog: [], generatedAt: "now" };
    expect(() => sub(mayaConfig(BIZ), JSON.stringify(failed))).toThrow(/balanceProof failed/);
    expect(() => sub(mayaConfig(BIZ), "", b.actors.owner)).toThrow(/permission denied/);
  });

  it("shopkeeper/support cannot activate configurations; the owner can; system cannot once an owner exists", () => {
    const w = new World();
    const b = bootMaya(w);
    w.call(w.system, "submitConfiguration", { businessId: BIZ, json: mayaConfig(BIZ, (c) => (c.catalogs[0].entries[0].data.price = "3.50")), proofReportJson: "" });
    const v2 = w.rows("configVersion").find((c) => c.version === 2)!;
    for (const r of ["shopkeeper", "support", "storefront", "bookkeeper"] as const) {
      expect(() => w.call(b.actors[r], "activateConfiguration", { configId: v2.id })).toThrow(/permission denied/);
    }
    expect(() => w.call(w.system, "activateConfiguration", { configId: v2.id })).toThrow(/permission denied/);
    w.call(b.actors.owner, "activateConfiguration", { configId: v2.id });
    expect(w.db.configVersion.id.find(v2.id).status).toBe("active");
    expect(w.db.configVersion.id.find(b.configId).status).toBe("superseded");
    expect(docsOf(w, BIZ, "opening_balance")).toHaveLength(1); // opening stock only on first activation
    const o = createOrder(b, b.actors.storefront, "o-v2", [line("cookie_single", 2)]);
    expect(o.totalCents).toBe(700n); // new price applies
    expect(() => w.call(b.actors.owner, "activateConfiguration", { configId: v2.id })).toThrow(/not pending/);
  });
});

describe("sales and payments", () => {
  let w: World;
  let b: Biz;
  beforeEach(() => {
    w = new World();
    b = bootMaya(w);
  });

  it("createOrder -> payment_succeeded posts sale + payment, balances, decreases stock", () => {
    const o = createOrder(b, b.actors.storefront, "o1", [line("cookie_box6", 1), line("cookie_single", 2), line("sea_salt", 1)]);
    expect(o.status).toBe("pending_payment");
    expect(o.totalCents).toBe(2200n); // 15 + 2x3 + 1
    const sale = doc(w, o.saleDocumentId);
    expect(sale.status).toBe("draft");
    expect(sale.lines.find((l: any) => l.values[0].value === "cookie_box6").values.find((v: any) => v.name === "unitPrice").value).toBe("15.00");
    expect(stock(w, BIZ)).toBe(48n); // nothing moves before payment

    pay(b, "o1", 2200n);
    const paid = order(w, "o1");
    expect(paid.status).toBe("paid");
    expect(paid.paidCents).toBe(2200n);
    const posted = doc(w, o.saleDocumentId);
    expect(posted.status).toBe("posted");
    expect(posted.approvedByRole).toBe("system");
    expect(posted.createdByRole).toBe("storefront");
    const payment = lastDoc(w, BIZ, "payment_received");
    expect(payment.status).toBe("posted");
    expect(payment.totalCents).toBe(2200n);

    expect(trialBalanceSum(w, BIZ)).toBe(0n);
    const bal = balances(w, BIZ);
    expect(bal["1010"]).toBe(2200n);
    expect(bal["1200"] ?? 0n).toBe(0n);
    expect(bal["4000"]).toBe(-2200n);
    expect(bal["5000"]).toBe(480n + 160n + 20n);
    // Inventory (1300) is credited with every line's cost, including the sea-salt add-on (0.20), which has
    // no stock item: the fixture's sale.inventory rule, not the platform (see README open questions).
    expect(bal["1300"]).toBe(3840n - 660n);
    expect(stock(w, BIZ)).toBe(48n - 8n);
    const ev = w.rows("processorEvent");
    expect(ev).toHaveLength(1);
    expect(ev[0].documentId).toBe(payment.id);
  });

  it("a duplicate payment event is a no-op", () => {
    const o = createOrder(b, b.actors.storefront, "o1", [line("cookie_box6", 1)]);
    pay(b, "o1", o.totalCents, "evt_dup");
    const before = snapshot(w);
    pay(b, "o1", o.totalCents, "evt_dup");
    expect(snapshot(w)).toBe(before);
    expect(docsOf(w, BIZ, "payment_received")).toHaveLength(1);
    expect(stock(w, BIZ)).toBe(42n);
  });

  it("a second payment (new event id) for a paid order posts nothing and asks the owner", () => {
    const o = sell(b, "o1", [line("cookie_box6", 1)]);
    const journalBefore = w.rows("journalLine").length;
    pay(b, "o1", o.totalCents, "evt_other");
    expect(w.rows("journalLine").length).toBe(journalBefore);
    expect(openInbox(w, BIZ).map((i) => i.question).join()).toMatch(/already paid.*double charge/);
  });

  it("an amount mismatch opens an inbox item and posts nothing", () => {
    createOrder(b, b.actors.storefront, "o2", [line("cookie_single", 1)]);
    const journalBefore = w.rows("journalLine").length;
    pay(b, "o2", 250n);
    expect(w.rows("journalLine").length).toBe(journalBefore);
    expect(docsOf(w, BIZ, "payment_received")).toHaveLength(0);
    expect(order(w, "o2").status).toBe("pending_payment");
    expect(doc(w, order(w, "o2").saleDocumentId).status).toBe("draft");
    const inbox = openInbox(w, BIZ);
    expect(inbox).toHaveLength(1);
    expect(inbox[0].question).toMatch(/\$2\.50 but the order total is \$3\.00/);
    expect(w.rows("processorEvent")).toHaveLength(1); // recorded, so a replay stays a no-op
    // the correct payment (new event) still works
    pay(b, "o2", 300n);
    expect(order(w, "o2").status).toBe("paid");
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });

  it("a payment for an unknown order opens an inbox item", () => {
    pay(b, "ghost", 500n);
    expect(openInbox(w, BIZ)[0].question).toMatch(/unknown order ghost/);
    expect(w.rows("journalLine").filter((j) => j.accountCode === "1010")).toHaveLength(0);
  });

  it("refuses a 25% discount (policy cap 20%) for every role; 20% is allowed", () => {
    for (const r of ["storefront", "shopkeeper", "owner"] as const) {
      const before = snapshot(w);
      expect(() => createOrder(b, b.actors[r], `d25-${r}`, [line("cookie_box6", 1)], "0.25")).toThrow(/discount/);
      expect(snapshot(w)).toBe(before);
    }
    expect(() => createOrder(b, b.actors.shopkeeper, "d21", [line("cookie_box6", 1)], "0.21")).toThrow(/role limit|discount/);
    const o = createOrder(b, b.actors.shopkeeper, "d20", [line("cookie_box6", 1)], "0.20");
    expect(o.totalCents).toBe(1200n);
    pay(b, "d20", 1200n);
    expect(balances(w, BIZ)["4100"]).toBe(300n); // discount booked to contra-revenue
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });

  it("refuses selling more than stock (and refuses negative discounts)", () => {
    const before = snapshot(w);
    expect(() => createOrder(b, b.actors.storefront, "big", [line("cookie_box6", 9)])).toThrow(/invariant 3 \(stock\)/); // 54 > 48
    expect(() => createOrder(b, b.actors.storefront, "big2", [line("cookie_box6", 7), line("cookie_single", 7)])).toThrow(/invariant 3/); // 49
    expect(() => createOrder(b, b.actors.storefront, "neg", [line("cookie_single", 1)], "-0.1")).toThrow(/discount/);
    expect(snapshot(w)).toBe(before);
    createOrder(b, b.actors.storefront, "exact", [line("cookie_box6", 8)]); // exactly 48
  });

  it("if stock ran out between order and payment: money is booked, the sale waits, the owner is asked", () => {
    const a = createOrder(b, b.actors.storefront, "a", [line("cookie_box6", 5)]); // 30 cookies, $75
    const c = createOrder(b, b.actors.storefront, "c", [line("cookie_box6", 5)]); // 30 more, still <= 48 at order time
    pay(b, "a", a.totalCents);
    pay(b, "c", c.totalCents);
    expect(order(w, "c").status).toBe("paid");
    expect(doc(w, c.saleDocumentId).status).toBe("draft");
    expect(openInbox(w, BIZ).map((i) => i.question).join()).toMatch(/sale could not post/);
    expect(stock(w, BIZ)).toBe(18n);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
    expect(balances(w, BIZ)["1200"]).toBe(-7500n); // customer prepaid, sale pending
  });

  it("the storefront cannot post its own sale; the owner cannot approve a sale it created (SoD)", () => {
    const o = createOrder(b, b.actors.storefront, "s1", [line("cookie_single", 1)]);
    expect(() => w.call(b.actors.storefront, "postDocument", { documentId: o.saleDocumentId })).toThrow(/permission denied.*cannot approve sale/);
    expect(() => w.call(b.actors.storefront, "recordProcessorEvent", { eventId: "fake", businessId: BIZ, kind: "payment_succeeded", orderId: "s1", amountCents: 300n, processorRef: "x" })).toThrow(/permission denied/);
    const o2 = createOrder(b, b.actors.owner, "s2", [line("cookie_single", 1)]);
    expect(() => w.call(b.actors.owner, "postDocument", { documentId: o2.saleDocumentId })).toThrow(/invariant 5/);
    // a sale cannot be posted before its payment, even by a valid approver
    expect(() => w.call(b.actors.bookkeeper, "postDocument", { documentId: o.saleDocumentId })).toThrow(/order is not paid/);
  });

  it("prices come from the catalog: createDocument(sale) with a caller price is refused", () => {
    const fields = [{ name: "orderId", value: "cd1" }, { name: "discountRate", value: "0" }];
    const lines = [{ values: [{ name: "productId", value: "cookie_box6" }, { name: "qty", value: "1" }, { name: "unitPrice", value: "0.01" }] }];
    expect(() => w.call(b.actors.shopkeeper, "createDocument", { businessId: BIZ, docType: "sale", externalRef: "cd1", fields, lines, note: "" })).toThrow(/invariant 6/);
    lines[0]!.values[2]!.value = "15";
    w.call(b.actors.shopkeeper, "createDocument", { businessId: BIZ, docType: "sale", externalRef: "cd1", fields, lines, note: "" });
    expect(order(w, "cd1").totalCents).toBe(1500n);
  });

  it("order status moves paid -> ready -> picked_up (owner/shopkeeper only)", () => {
    sell(b, "st", [line("cookie_single", 1)]);
    expect(() => w.call(b.actors.support, "updateOrderStatus", { orderId: "st", status: "ready" })).toThrow(/permission denied/);
    w.call(b.actors.shopkeeper, "updateOrderStatus", { orderId: "st", status: "ready" });
    w.call(b.actors.owner, "updateOrderStatus", { orderId: "st", status: "picked_up" });
    expect(order(w, "st").status).toBe("picked_up");
    expect(() => w.call(b.actors.shopkeeper, "updateOrderStatus", { orderId: "st", status: "paid" })).toThrow(/ready.*picked_up/);
  });

  it("fee events post processor fees; payouts wait for owner approval (SoD)", () => {
    sell(b, "f1", [line("cookie_box6", 1)]);
    w.call(w.system, "recordProcessorEvent", { eventId: "fee1", businessId: BIZ, kind: "fee", orderId: "f1", amountCents: 74n, processorRef: "txn_1" });
    expect(balances(w, BIZ)["5100"]).toBe(74n);
    w.call(w.system, "recordProcessorEvent", { eventId: "po1", businessId: BIZ, kind: "payout", orderId: "", amountCents: 1426n, processorRef: "po_1" });
    const payout = lastDoc(w, BIZ, "payout");
    expect(payout.status).toBe("draft");
    expect(() => w.call(w.system, "postDocument", { documentId: payout.id })).toThrow(/invariant 5/);
    w.call(b.actors.owner, "postDocument", { documentId: payout.id });
    const bal = balances(w, BIZ);
    expect(bal["1000"]).toBe(1426n);
    expect(bal["1010"] ?? 0n).toBe(0n);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });
});

describe("refunds", () => {
  let w: World;
  let b: Biz;
  beforeEach(() => {
    w = new World();
    b = bootMaya(w);
    sell(b, "r1", [line("cookie_box6", 1)]); // net 15.00, cost 4.80, floor retained >= 6.24
  });

  const refundDraft = () => lastDoc(w, BIZ, "refund");

  it("a partial refund below the margin floor is refused; above the floor is allowed", () => {
    const before = snapshot(w);
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 900n, reason: "broken" })).toThrow(/margin floor/); // retains 6.00 < 6.24
    expect(snapshot(w)).toBe(before);
    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 800n, reason: "broken" }); // retains 7.00
    w.call(b.actors.bookkeeper, "postDocument", { documentId: refundDraft().id });
    expect(order(w, "r1").status).toBe("partially_refunded");
    // a second partial that would take it below the floor is refused at request time
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 100n, reason: "more" })).toThrow(/margin floor/);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });

  it("a full refund is allowed; posting queues exactly one outbox item; the creator cannot approve it", () => {
    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "wrong order" });
    const r = refundDraft();
    expect(r.status).toBe("draft");
    expect(r.fields.find((f: any) => f.name === "saleNet").value).toBe("15");
    expect(w.rows("outbox")).toHaveLength(0);
    expect(() => w.call(b.actors.support, "postDocument", { documentId: r.id })).toThrow(/permission denied/);
    expect(() => w.call(b.actors.shopkeeper, "postDocument", { documentId: r.id })).toThrow(/permission denied/);

    w.call(b.actors.bookkeeper, "postDocument", { documentId: r.id });
    expect(doc(w, r.id).status).toBe("posted");
    expect(order(w, "r1").status).toBe("refunded");
    expect(order(w, "r1").refundedCents).toBe(1500n);
    const ob = w.rows("outbox");
    expect(ob).toHaveLength(1);
    expect(ob[0].kind).toBe("stripe_refund");
    expect(ob[0].idempotencyKey).toBe(`refund:${r.id}`);
    expect(JSON.parse(ob[0].payloadJson)).toMatchObject({ orderId: "r1", amountCents: 1500, processorRef: "pi_r1" });
    const bal = balances(w, BIZ);
    expect(bal["4200"]).toBe(1500n);
    expect(bal["1010"] ?? 0n).toBe(0n);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);

    // exactly once: re-posting is refused, the outbox drains once, the webhook confirmation is idempotent
    expect(() => w.call(b.actors.bookkeeper, "postDocument", { documentId: r.id })).toThrow(/only drafts/);
    w.call(w.system, "claimOutbox", { id: ob[0].id });
    expect(() => w.call(w.system, "claimOutbox", { id: ob[0].id })).toThrow(/is claimed/);
    w.call(w.system, "completeOutbox", { id: ob[0].id, ok: true, resultJson: JSON.stringify({ refundId: "re_123" }) });
    w.call(w.system, "completeOutbox", { id: ob[0].id, ok: true, resultJson: "{}" }); // idempotent
    w.call(w.system, "recordProcessorEvent", { eventId: "evt_re", businessId: BIZ, kind: "refund_succeeded", orderId: "r1", amountCents: 1500n, processorRef: "re_123" });
    expect(w.rows("outbox")).toHaveLength(1);
    expect(w.rows("outbox")[0].status).toBe("done");
    expect(openInbox(w, BIZ)).toHaveLength(0);

    // nothing left to refund
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1n, reason: "again" })).toThrow(/exceed/);
  });

  it("refund limits: support may request at most $15; a refund over the sale is refused", () => {
    sell(b, "r2", [line("cookie_box6", 2)]); // 30.00
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "r2", amountCents: 1600n, reason: "x" })).toThrow(/role limit/);
    w.call(b.actors.shopkeeper, "requestRefund", { orderId: "r2", amountCents: 3000n, reason: "owner decides" });
    const big = lastDoc(w, BIZ, "refund");
    expect(() => w.call(b.actors.bookkeeper, "postDocument", { documentId: big.id })).toThrow(/role limit: bookkeeper/);
    w.call(b.actors.owner, "postDocument", { documentId: big.id });
    expect(order(w, "r2").status).toBe("refunded");
    expect(() => w.call(b.actors.owner, "requestRefund", { orderId: "r1", amountCents: 1501n, reason: "x" })).toThrow(/exceed/);
  });

  it("the refund window (24h) is enforced", () => {
    w.advance(25n * HOUR);
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "late" })).toThrow(/refund window/);
  });

  it("an unmatched processor refund opens an inbox item", () => {
    w.call(w.system, "recordProcessorEvent", { eventId: "evt_x", businessId: BIZ, kind: "refund_succeeded", orderId: "r1", amountCents: 500n, processorRef: "re_unknown" });
    expect(openInbox(w, BIZ)[0].question).toMatch(/no approved refund asked for/);
  });

  it("a processor refund with the wrong amount, or for a reversed refund, opens an inbox item", () => {
    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "a" });
    const r = refundDraft();
    w.call(b.actors.bookkeeper, "postDocument", { documentId: r.id });
    const key = `refund:${r.id}`;
    w.call(w.system, "recordProcessorEvent", { eventId: "evt_amt", businessId: BIZ, kind: "refund_succeeded", orderId: "r1", amountCents: 1400n, processorRef: key });
    expect(w.rows("outbox")[0].status).toBe("pending");
    expect(openInbox(w, BIZ)[0].question).toMatch(/approved refund was \$15\.00/);
    w.call(b.actors.bookkeeper, "reverseDocument", { documentId: r.id, reason: "mistake" });
    w.call(w.system, "recordProcessorEvent", { eventId: "evt_cancelled", businessId: BIZ, kind: "refund_succeeded", orderId: "r1", amountCents: 1500n, processorRef: key });
    expect(w.rows("outbox")[0].status).toBe("cancelled");
    expect(openInbox(w, BIZ).map((i) => i.question).join()).toMatch(/reversed in the ledger/);
  });

  it("two pending refunds are re-checked at posting: the second cannot exceed the sale", () => {
    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "a" });
    const first = refundDraft();
    w.call(b.actors.shopkeeper, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "b" });
    const second = refundDraft();
    w.call(b.actors.bookkeeper, "postDocument", { documentId: first.id });
    expect(() => w.call(b.actors.bookkeeper, "postDocument", { documentId: second.id })).toThrow(/exceed/);
    expect(w.rows("outbox")).toHaveLength(1);
  });

  it("reversing a refund whose processor refund is pending cancels it; once sent, it cannot be reversed", () => {
    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "a" });
    const r = refundDraft();
    w.call(b.actors.bookkeeper, "postDocument", { documentId: r.id });
    w.call(b.actors.bookkeeper, "reverseDocument", { documentId: r.id, reason: "approved by mistake" });
    expect(w.rows("outbox")[0].status).toBe("cancelled");
    expect(order(w, "r1").status).toBe("paid");
    expect(order(w, "r1").refundedCents).toBe(0n);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
    expect(balances(w, BIZ)["4200"]).toBe(0n);
    expect(() => w.call(w.system, "claimOutbox", { id: w.rows("outbox")[0].id })).toThrow(/cancelled/);

    w.call(b.actors.support, "requestRefund", { orderId: "r1", amountCents: 1500n, reason: "b" });
    const r2 = refundDraft();
    w.call(b.actors.bookkeeper, "postDocument", { documentId: r2.id });
    const ob = w.rows("outbox").find((o) => o.idempotencyKey === `refund:${r2.id}`)!;
    w.call(w.system, "claimOutbox", { id: ob.id });
    expect(() => w.call(b.actors.bookkeeper, "reverseDocument", { documentId: r2.id, reason: "oops" })).toThrow(/processor refund/);
  });
});

describe("inbox, periods, reversals", () => {
  let w: World;
  let b: Biz;
  beforeEach(() => {
    w = new World();
    b = bootMaya(w);
  });

  it("shopkeeper/support cannot answer the inbox; the owner can and may set a precedent", () => {
    w.call(b.actors.support, "openInbox", { businessId: BIZ, question: "Customer wants 30% off for a party order", contextJson: "{}", documentRef: "" });
    const item = openInbox(w, BIZ)[0];
    expect(item.fromRole).toBe("support");
    for (const r of ["shopkeeper", "support", "storefront", "bookkeeper"] as const) {
      expect(() => w.call(b.actors[r], "answerInbox", { id: item.id, answer: "yes", makePrecedent: true, precedentRule: "", conditionJson: "" })).toThrow(/permission denied/);
    }
    expect(() => w.call(w.system, "answerInbox", { id: item.id, answer: "yes", makePrecedent: false, precedentRule: "", conditionJson: "" })).toThrow(/permission denied/);
    w.call(b.actors.owner, "answerInbox", { id: item.id, answer: "No, max 20%.", makePrecedent: true, precedentRule: "never above 20%", conditionJson: '{"maxDiscount":"0.20"}' });
    expect(w.db.inboxItem.id.find(item.id).status).toBe("answered");
    const p = w.rows("precedent");
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ agentRole: "support", rule: "never above 20%" });
    expect(() => w.call(b.actors.owner, "answerInbox", { id: item.id, answer: "again", makePrecedent: false, precedentRule: "", conditionJson: "" })).toThrow(/already answered/);
  });

  it("owner statements: system queues, only the owner confirms", () => {
    w.call(w.system, "queueOwnerStatement", { businessId: BIZ, channel: "phone", text: "raise box price to $16", diffJson: "{}" });
    const st = w.rows("ownerStatement")[0];
    expect(() => w.call(w.system, "decideOwnerStatement", { id: st.id, confirm: true })).toThrow(/permission denied/);
    expect(() => w.call(b.actors.shopkeeper, "queueOwnerStatement", { businessId: BIZ, channel: "app", text: "x", diffJson: "{}" })).toThrow(/permission denied/);
    expect(() => w.call(w.system, "markOwnerStatementApplied", { id: st.id })).toThrow(/only confirmed/);
    w.call(b.actors.owner, "decideOwnerStatement", { id: st.id, confirm: true });
    w.call(w.system, "markOwnerStatementApplied", { id: st.id });
    expect(w.db.ownerStatement.id.find(st.id).status).toBe("applied");
  });

  it("decision records take actor kind/id from the caller's identity", () => {
    w.call(b.actors.shopkeeper, "recordDecision", { businessId: BIZ, action: "quote", documentRef: "", ruleIds: ["discount_cap"], evidenceRefs: [], inputsHash: "h", outcome: "refused", reason: "25% > 20%", wouldChangeIf: "owner raises maxDiscount" });
    expect(w.rows("decisionRecord")[0]).toMatchObject({ actorKind: "agent", actorId: "shopkeeper", outcome: "refused" });
  });

  it("a closed period refuses posting; the next month is open", () => {
    const o = createOrder(b, b.actors.storefront, "p1", [line("cookie_single", 1)]);
    expect(() => w.call(b.actors.shopkeeper, "closePeriod", { businessId: BIZ, month: "2026-10" })).toThrow(/permission denied/);
    w.call(b.actors.bookkeeper, "closePeriod", { businessId: BIZ, month: "2026-10" });
    expect(() => w.call(b.actors.bookkeeper, "closePeriod", { businessId: BIZ, month: "2026-10" })).toThrow(/already closed/);

    const before = snapshot(w);
    expect(() => pay(b, "p1", o.totalCents)).toThrow(/invariant 8/);
    const receipt = { businessId: BIZ, docType: "stock_receipt", externalRef: "", fields: [], lines: [{ values: [{ name: "stockItem", value: "choc_chip_cookie" }, { name: "qty", value: "12" }, { name: "unitCost", value: "0.80" }] }], note: "" };
    w.call(b.actors.bookkeeper, "createDocument", receipt);
    const rec = lastDoc(w, BIZ, "stock_receipt");
    expect(() => w.call(b.actors.owner, "postDocument", { documentId: rec.id })).toThrow(/invariant 8/);
    expect(doc(w, rec.id).status).toBe("draft");
    void before;

    w.setTime(1_793_577_600_000_000n); // 2026-11-02T00:00Z
    w.call(b.actors.owner, "postDocument", { documentId: rec.id });
    expect(doc(w, rec.id).period).toBe("2026-11");
    expect(stock(w, BIZ)).toBe(60n);
    pay(b, "p1", o.totalCents);
    expect(order(w, "p1").status).toBe("paid");
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
  });

  it("stock receipts: creator cannot approve their own (SoD)", () => {
    const receipt = { businessId: BIZ, docType: "stock_receipt", externalRef: "", fields: [{ name: "supplier", value: "Maya's kitchen" }], lines: [{ values: [{ name: "stockItem", value: "choc_chip_cookie" }, { name: "qty", value: "24" }, { name: "unitCost", value: "0.80" }] }], note: "" };
    w.call(b.actors.bookkeeper, "createDocument", receipt);
    const rec = lastDoc(w, BIZ, "stock_receipt");
    expect(() => w.call(b.actors.bookkeeper, "postDocument", { documentId: rec.id })).toThrow(/invariant 5/);
    w.call(b.actors.owner, "postDocument", { documentId: rec.id });
    expect(stock(w, BIZ)).toBe(72n);
    expect(balances(w, BIZ)["2000"]).toBe(-1920n);
  });

  it("reversing a sale cancels the order, restores stock and nets the sale out", () => {
    const o = sell(b, "rv", [line("cookie_box6", 2)]);
    const sale = doc(w, o.saleDocumentId);
    expect(stock(w, BIZ)).toBe(36n);
    expect(() => w.call(b.actors.shopkeeper, "reverseDocument", { documentId: sale.id, reason: "no-show" })).toThrow(/permission denied/);
    expect(() => w.call(b.actors.bookkeeper, "reverseDocument", { documentId: sale.id, reason: " " })).toThrow(/needs a reason/);
    w.call(b.actors.bookkeeper, "reverseDocument", { documentId: sale.id, reason: "no-show" });
    const orig = doc(w, sale.id);
    expect(orig.status).toBe("reversed");
    const rev = doc(w, orig.reversedBy);
    expect(rev.reversalOf).toBe(sale.id);
    expect(rev.status).toBe("posted");
    expect(order(w, "rv").status).toBe("cancelled");
    expect(stock(w, BIZ)).toBe(48n);
    const bal = balances(w, BIZ);
    expect(bal["4000"]).toBe(0n);
    expect(bal["5000"]).toBe(0n);
    expect(bal["1300"]).toBe(3840n);
    expect(trialBalanceSum(w, BIZ)).toBe(0n);
    expect(() => w.call(b.actors.bookkeeper, "reverseDocument", { documentId: sale.id, reason: "again" })).toThrow(/only posted/);
    expect(() => w.call(b.actors.owner, "reverseDocument", { documentId: rev.id, reason: "undo" })).toThrow(/itself a reversal/);
    expect(() => w.call(b.actors.support, "requestRefund", { orderId: "rv", amountCents: 100n, reason: "x" })).toThrow(/nothing to refund/);
  });

  it("a reversal that would make stock negative is refused", () => {
    sell(b, "all", [line("cookie_box6", 8)]); // stock 0
    const opening = docsOf(w, BIZ, "opening_balance")[0];
    expect(() => w.call(b.actors.owner, "reverseDocument", { documentId: opening.id, reason: "x" })).toThrow(/invariant 3/);
  });
});

describe("red-team baseline (enforce=false)", () => {
  it("accepts a 25% discount and caller-supplied prices, but still balances, dedupes and checks stock", () => {
    const w = new World();
    const real = bootMaya(w);
    const base = bootMaya(w, { id: "maya-baseline", enforce: false, claim: false });
    expect(w.db.business.id.find("maya-baseline").enforce).toBe(false);

    // same request: refused on the enforced business, accepted on the baseline
    expect(() => createOrder(real, real.actors.storefront, "x25", [line("cookie_box6", 1)], "0.25")).toThrow(/discount/);
    const o = createOrder(base, base.actors.storefront, "b25", [line("cookie_box6", 1)], "0.25");
    expect(o.totalCents).toBe(1125n);
    pay(base, "b25", 1125n, "evt_b25");
    expect(order(w, "b25").status).toBe("paid");
    expect(balances(w, "maya-baseline")["4100"]).toBe(375n);
    expect(trialBalanceSum(w, "maya-baseline")).toBe(0n);

    // caller-supplied price is accepted in the baseline
    const fields = [{ name: "orderId", value: "b-cheap" }, { name: "discountRate", value: "0" }];
    const lines = [{ values: [{ name: "productId", value: "cookie_box6" }, { name: "qty", value: "1" }, { name: "unitPrice", value: "0.01" }] }];
    w.call(base.actors.shopkeeper, "createDocument", { businessId: "maya-baseline", docType: "sale", externalRef: "b-cheap", fields, lines, note: "" });
    expect(order(w, "b-cheap").totalCents).toBe(1n);

    // role checks are off: support may answer the inbox in the baseline
    w.call(base.actors.support, "openInbox", { businessId: "maya-baseline", question: "q", contextJson: "", documentRef: "" });
    const item = openInbox(w, "maya-baseline")[0];
    w.call(base.actors.support, "answerInbox", { id: item.id, answer: "a", makePrecedent: false, precedentRule: "", conditionJson: "" });

    // never skipped: dedupe, stock, platform administration, cross-business isolation
    const before = snapshot(w);
    pay(base, "b25", 1125n, "evt_b25");
    expect(snapshot(w)).toBe(before);
    expect(() => createOrder(base, base.actors.storefront, "b-big", [line("cookie_box6", 9)])).toThrow(/invariant 3/);
    expect(() => w.call(base.actors.support, "createRoleGrant", { code: "baseline-code", businessId: "maya-baseline", role: "owner", name: "x", ttlSeconds: 60 })).toThrow(/cannot grant roles/);
    expect(() => createOrder(real, base.actors.storefront, "cross", [line("cookie_single", 1)])).toThrow(/not an actor of business/);
  });
});

describe("invariant 7: processor documents only through recordProcessorEvent", () => {
  const processorDocs = (orderId: string) => ({
    payment_received: [{ name: "orderId", value: orderId }, { name: "amount", value: "3.00" }, { name: "processorRef", value: "pi_x" }],
    processor_fee: [{ name: "orderId", value: orderId }, { name: "fee", value: "0.10" }, { name: "processorRef", value: "txn_x" }],
    payout: [{ name: "amount", value: "1.00" }, { name: "processorRef", value: "po_x" }],
  });

  it("createDocument refuses payment_received, processor_fee and payout for every role, also on the baseline", () => {
    const w = new World();
    const real = bootMaya(w);
    const base = bootMaya(w, { id: "maya-baseline", enforce: false, claim: false });
    for (const b of [real, base]) {
      const orderId = `${b.id}-o`;
      createOrder(b, b.actors.storefront, orderId, [line("cookie_single", 1)]);
      for (const [docType, fields] of Object.entries(processorDocs(orderId))) {
        for (const who of [w.system, ...Object.values(b.actors)]) {
          const before = snapshot(w);
          expect(() => w.call(who, "createDocument", { businessId: b.id, docType, externalRef: orderId, fields, lines: [], note: "" })).toThrow(/invariant 7.*only by recordProcessorEvent/);
          expect(snapshot(w)).toBe(before);
        }
      }
      // the processor path still works and still dedupes
      pay(b, orderId, 300n, `evt-${b.id}`);
      pay(b, orderId, 300n, `evt-${b.id}`);
      expect(docsOf(w, b.id, "payment_received")).toHaveLength(1);
      expect(order(w, orderId).status).toBe("paid");
    }
  });
});
