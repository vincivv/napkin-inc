// Property test: random sequences of orders, payments (exact, wrong amount, replayed), refunds,
// reversals and stock receipts against the real reducers. After every step, accepted or refused:
//   - the trial balance sums to zero (invariant 1) and stock never goes negative (invariant 3);
//   - a refused call changed nothing (the transaction rolled back);
// and at the end the ledger agrees with the documents (stock, Stripe clearing, outbox exactly once).

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { World, bootMaya, trialBalanceSum, stock, balances, order, docsOf, snapshot, lastDoc, type Biz } from "./helpers";

const BIZ = "maya-cookies";
const PRODUCTS = ["cookie_single", "cookie_box6", "sea_salt"] as const;

const opArb = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant("order" as const),
      lines: fc.array(fc.record({ productId: fc.constantFrom(...PRODUCTS), qty: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 3 }),
      disc: fc.constantFrom("0", "0", "0.05", "0.1", "0.2", "0.25"),
    }),
  },
  { weight: 4, arbitrary: fc.record({ t: fc.constant("pay" as const), i: fc.nat(), mode: fc.constantFrom("exact", "exact", "wrong", "dup") }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("refund" as const), i: fc.nat(), full: fc.boolean(), cents: fc.integer({ min: 1, max: 3000 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant("reverse" as const), i: fc.nat(), what: fc.constantFrom("sale", "sale", "refund", "payment") }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("receipt" as const), qty: fc.integer({ min: 1, max: 24 }) }) },
);
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

function step(b: Biz, op: Op, orders: string[], events: Map<string, string>, k: number) {
  const w = b.w;
  // Mostly target orders in the state the operation needs (so sequences reach deep states), sometimes any order.
  const pick = (i: number, want?: string[]) => {
    const pool = want && i % 4 !== 0 ? orders.filter((o) => want.includes(order(w, o)!.status)) : orders;
    return pool.length ? pool[i % pool.length]! : orders.length ? orders[i % orders.length]! : "none";
  };
  switch (op.t) {
    case "order": {
      const id = `p${k}`;
      w.call(b.actors.storefront, "createOrder", { businessId: BIZ, orderId: id, customerName: "", channel: "storefront", discountRate: op.disc, couponCode: "", lines: op.lines });
      orders.push(id);
      return;
    }
    case "pay": {
      const id = pick(op.i, ["pending_payment"]);
      const o = order(w, id);
      const amount = o ? (op.mode === "wrong" ? o.totalCents + 1n : o.totalCents) : 100n;
      const eventId = op.mode === "dup" && events.has(id) ? events.get(id)! : `evt_${k}`;
      events.set(id, eventId);
      w.call(w.system, "recordProcessorEvent", { eventId, businessId: BIZ, kind: "payment_succeeded", orderId: id, amountCents: amount, processorRef: `pi_${id}` });
      return;
    }
    case "refund": {
      const id = pick(op.i, ["paid", "partially_refunded"]);
      const o = order(w, id);
      const amount: bigint = op.full && o ? (o.totalCents as bigint) - (o.refundedCents as bigint) : BigInt(op.cents);
      const requester = amount <= 1500n ? b.actors.support : b.actors.shopkeeper;
      w.call(requester, "requestRefund", { orderId: id, amountCents: amount, reason: "test" });
      w.call(b.actors.owner, "postDocument", { documentId: lastDoc(w, BIZ, "refund").id });
      return;
    }
    case "reverse": {
      // sale: paid / partially refunded ones must be refused (refund first), fully refunded ones reverse;
      // refund: the order's latest posted refund; payment: always refused (processor document).
      const id = pick(op.i, op.what === "sale" ? ["refunded", "paid", "partially_refunded"] : ["refunded", "partially_refunded", "cancelled"]);
      const o = order(w, id);
      const docType = op.what === "refund" ? "refund" : "payment_received";
      const target = op.what === "sale" ? (o ? o.saleDocumentId : 0n) : (docsOf(w, BIZ, docType).filter((d) => d.externalRef === id && d.status === "posted").at(-1)?.id ?? 0n);
      w.call(b.actors.bookkeeper, "reverseDocument", { documentId: target, reason: "test" });
      return;
    }
    case "receipt": {
      const lines = [{ values: [{ name: "stockItem", value: "choc_chip_cookie" }, { name: "qty", value: String(op.qty) }, { name: "unitCost", value: "0.80" }] }];
      w.call(b.actors.bookkeeper, "createDocument", { businessId: BIZ, docType: "stock_receipt", externalRef: "", fields: [], lines, note: "" });
      w.call(b.actors.owner, "postDocument", { documentId: lastDoc(w, BIZ, "stock_receipt").id });
      return;
    }
  }
}

const num = (v: { name: string; value: string }[], n: string) => BigInt(v.find((x) => x.name === n)!.value);
const live = (d: any) => d.status === "posted" && d.reversalOf === 0n;

describe("property: random order/payment/refund sequences", () => {
  it("keep the trial balance at zero, stock >= 0, refusals atomic, ledger == documents", () => {
    const seen = { sales: 0, refunds: 0, reversals: 0, saleReversals: 0, refused: 0 };
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 40, size: "large" }), (ops) => {
        const w = new World();
        const b = bootMaya(w);
        const orders: string[] = [];
        const events = new Map<string, string>();
        ops.forEach((op, k) => {
          const before = snapshot(w);
          try {
            step(b, op, orders, events, k);
          } catch (e) {
            seen.refused++;
            // refunds/receipts are two calls; a refused second call leaves the first (a draft) in place
            if (op.t !== "refund" && op.t !== "receipt") expect(snapshot(w)).toBe(before);
            expect(String(e)).not.toMatch(/cannot post: |rule error|is not a function|undefined/);
          }
          expect(trialBalanceSum(w, BIZ)).toBe(0n);
          expect(stock(w, BIZ) >= 0n).toBe(true);
        });

        // stock register == opening + receipts - units of live sales
        let expected = 48n;
        for (const d of docsOf(w, BIZ, "stock_receipt").filter(live)) for (const l of d.lines) expected += num(l.values, "qty");
        for (const d of docsOf(w, BIZ, "sale").filter(live)) for (const l of d.lines) expected -= num(l.values, "qty") * num(l.values, "stockUnits");
        expect(stock(w, BIZ)).toBe(expected);

        // Stripe clearing == payments - refunds (no fees or payouts in this run)
        const paid = docsOf(w, BIZ, "payment_received").filter(live).reduce((s, d) => s + d.totalCents, 0n);
        const refunded = docsOf(w, BIZ, "refund").filter(live).reduce((s, d) => s + d.totalCents, 0n);
        expect(balances(w, BIZ)["1010"] ?? 0n).toBe(paid - refunded);

        // one payment per order; refunds never exceed the order; one outbox item per posted refund
        const refundDocs = docsOf(w, BIZ, "refund").filter((d) => d.status !== "draft" && d.reversalOf === 0n);
        expect(w.rows("outbox").length).toBe(refundDocs.length);
        for (const id of orders) {
          const o = order(w, id);
          expect(docsOf(w, BIZ, "payment_received").filter((d) => d.externalRef === id).length).toBeLessThanOrEqual(1);
          expect(o.refundedCents <= o.totalCents).toBe(true);
          if (o.status === "pending_payment") expect(o.paidCents).toBe(0n);
        }
        // processor documents are never reversed; a sale is reversed only once its payment was fully refunded,
        // and it stays that way (the customer's money is always accounted for)
        for (const t of ["payment_received", "processor_fee", "payout"]) {
          expect(docsOf(w, BIZ, t).filter((d) => d.status === "reversed" || d.reversalOf !== 0n)).toHaveLength(0);
        }
        for (const id of orders) {
          const o = order(w, id);
          if (!o || o.saleDocumentId === 0n) continue;
          if (docsOf(w, BIZ, "sale").find((d) => d.id === o.saleDocumentId)!.status !== "reversed") continue;
          expect(o.status).toBe("cancelled");
          const liveRefunds = docsOf(w, BIZ, "refund").filter((d) => live(d) && d.externalRef === id).reduce((s, d) => s + d.totalCents, 0n);
          expect(liveRefunds).toBe(o.paidCents);
        }
        // every posted sale is approved by someone other than its creator (SoD) and respects the 20% cap
        for (const d of docsOf(w, BIZ, "sale").filter(live)) {
          expect(d.approvedBy.toHexString()).not.toBe(d.createdBy.toHexString());
          expect(d.fields.find((f: any) => f.name === "discountRate").value).not.toBe("0.25");
        }
        seen.sales += docsOf(w, BIZ, "sale").filter(live).length;
        seen.refunds += docsOf(w, BIZ, "refund").filter(live).length;
        seen.reversals += docsOf(w, BIZ).filter((d) => d.reversalOf !== 0n).length;
        seen.saleReversals += docsOf(w, BIZ, "sale").filter((d) => d.reversalOf !== 0n).length;
      }),
      { numRuns: 80 },
    );
    process.stdout.write(`\nproperty runs exercised: ${JSON.stringify(seen)}\n`);
    // the generator must actually reach the interesting states, not just refusals
    expect(seen.sales).toBeGreaterThan(100);
    expect(seen.refunds).toBeGreaterThan(10);
    expect(seen.reversals).toBeGreaterThan(10);
    expect(seen.saleReversals).toBeGreaterThan(5);
  });
});
