// The owner changes stock by hand through the UNCHANGED generic createDocument reducer: "stock_added" (paid now,
// owed to the supplier or put in by the owner) and "stock_removed" (written off). Owner-only, post on create;
// the stock register never goes negative, so taking out more than is on hand is refused.

import { describe, expect, it } from "vitest";
import { balances, bootMaya, docsOf, snapshot, stock, trialBalanceSum, World } from "./helpers";

const ITEM = "choc_chip_cookie";
const line = (qty: string, unitCost = "0.80", item = ITEM) => ({ values: [{ name: "stockItem", value: item }, { name: "qty", value: qty }, { name: "unitCost", value: unitCost }] });
const added = (businessId: string, qty: string, paidFrom = "1000") => ({
  businessId,
  docType: "stock_added",
  externalRef: "",
  fields: [{ name: "supplier", value: "Costco" }, { name: "paidFrom", value: paidFrom }],
  lines: [line(qty)],
  note: "",
});
const removed = (businessId: string, qty: string) => ({ businessId, docType: "stock_removed", externalRef: "", fields: [{ name: "reason", value: "Spoiled or expired" }], lines: [line(qty)], note: "" });

describe("owner stock changes on the platform", () => {
  it("adding stock posts at once to inventory and the paying side; removing writes it off", () => {
    const w = new World();
    const b = bootMaya(w);
    const start = stock(w, b.id);
    const before = balances(w, b.id);
    w.call(b.actors.owner, "createDocument", added(b.id, "24"));
    w.call(b.actors.owner, "createDocument", added(b.id, "10", "2000"));
    w.call(b.actors.owner, "createDocument", added(b.id, "5", "3000"));
    w.call(b.actors.owner, "createDocument", removed(b.id, "3"));
    expect(docsOf(w, b.id, "stock_added").map((d) => d.status)).toEqual(["posted", "posted", "posted"]);
    expect(docsOf(w, b.id, "stock_removed").map((d) => d.status)).toEqual(["posted"]);
    expect(stock(w, b.id)).toBe(start + 24n + 10n + 5n - 3n);
    const after = balances(w, b.id);
    const delta = (code: string) => (after[code] ?? 0n) - (before[code] ?? 0n);
    expect(delta("1300")).toBe(1920n + 800n + 400n - 240n);
    expect(delta("1000")).toBe(-1920n);
    expect(delta("2000")).toBe(-800n);
    expect(delta("3000")).toBe(-400n);
    expect(delta("5200")).toBe(240n);
    expect(trialBalanceSum(w, b.id)).toBe(0n);
  });

  it("refuses taking out more than is on hand, a zero quantity, or a paying side that isn't allowed", () => {
    const w = new World();
    const b = bootMaya(w);
    const before = snapshot(w);
    const have = stock(w, b.id);
    expect(() => w.call(b.actors.owner, "createDocument", removed(b.id, String(have + 1n)))).toThrow();
    expect(() => w.call(b.actors.owner, "createDocument", added(b.id, "0"))).toThrow(/qty_positive/);
    expect(() => w.call(b.actors.owner, "createDocument", added(b.id, "5", "4000"))).toThrow(/paid_from/);
    expect(snapshot(w)).toBe(before);
  });

  it("AI staff and the storefront cannot change stock by hand", () => {
    const w = new World();
    const b = bootMaya(w);
    const before = snapshot(w);
    for (const role of ["bookkeeper", "shopkeeper", "support", "storefront"] as const) {
      expect(() => w.call(b.actors[role], "createDocument", added(b.id, "5")), role).toThrow(/permission denied/);
      expect(() => w.call(b.actors[role], "createDocument", removed(b.id, "1")), role).toThrow(/permission denied/);
    }
    expect(snapshot(w)).toBe(before);
  });
});
