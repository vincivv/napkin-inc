// A refund hands back the sale's tax out of Sales tax payable (2100), not into Refunds (4200): after a full
// refund, in one go or in pieces, the tax account is back where it started.

import { describe, expect, it } from "vitest";
import { balances, bootMaya, lastDoc, line, sell, trialBalanceSum, World } from "./helpers";

function taxedShop() {
  const w = new World();
  const b = bootMaya(w, { patch: (c) => (c.policies.taxRate = "0.0825") });
  const o = sell(b, "r1", [line("cookie_box6", 1)]); // net 15.00 + tax 1.24 = 16.24
  expect(o.totalCents).toBe(1624n);
  return { w, b };
}

function refund(w: World, b: ReturnType<typeof bootMaya>, amountCents: bigint) {
  w.call(b.actors.shopkeeper, "requestRefund", { orderId: "r1", amountCents, reason: "test" });
  w.call(b.actors.owner, "postDocument", { documentId: lastDoc(w, b.id, "refund").id });
}

describe("refund sales tax", () => {
  it("a full refund returns the whole tax to 2100 and only the sale to 4200", () => {
    const { w, b } = taxedShop();
    expect(balances(w, b.id)["2100"]).toBe(-124n);
    refund(w, b, 1624n);
    const bal = balances(w, b.id);
    expect(bal["2100"] ?? 0n).toBe(0n);
    expect(bal["4200"]).toBe(1500n);
    expect(trialBalanceSum(w, b.id)).toBe(0n);
  });

  it("partial refunds return the tax share, and refunding the rest leaves no stray cent", () => {
    const { w, b } = taxedShop();
    refund(w, b, 800n); // tax share round2(8.00 × 1.24 / 16.24) = 0.61
    let bal = balances(w, b.id);
    expect(bal["2100"]).toBe(-63n);
    expect(bal["4200"]).toBe(739n);
    refund(w, b, 824n);
    bal = balances(w, b.id);
    expect(bal["2100"] ?? 0n).toBe(0n);
    expect(bal["4200"]).toBe(1500n);
    expect(trialBalanceSum(w, b.id)).toBe(0n);
  });

  it("with no tax nothing posts to 2100 (Maya's live setup)", () => {
    const w = new World();
    const b = bootMaya(w);
    sell(b, "r1", [line("cookie_box6", 1)]);
    refund(w, b, 1500n);
    expect(balances(w, b.id)["2100"] ?? 0n).toBe(0n);
    expect(balances(w, b.id)["4200"]).toBe(1500n);
  });
});
