// Owner expenses through the UNCHANGED generic createDocument reducer: the config-defined "expense" document
// type (creatorRoles [owner], postOn create) posts immediately; AI staff are refused; a non-expense account
// or paying side is refused by the policy checks, and with the checks off (baseline) by the balance check.

import { describe, expect, it } from "vitest";
import { balances, bootMaya, docsOf, mayaConfig, snapshot, trialBalanceSum, World } from "./helpers";

const fields = (paidFrom: string, vendor = "Landlord LLC") => [
  { name: "vendor", value: vendor },
  { name: "date", value: "2026-10-01" },
  { name: "paidFrom", value: paidFrom },
  { name: "receiptRef", value: "" },
];
const expenseLine = (account: string, amount: string, description = "") => ({ values: [{ name: "account", value: account }, { name: "amount", value: amount }, { name: "description", value: description }] });
const args = (businessId: string, lines: ReturnType<typeof expenseLine>[], paidFrom = "1000") => ({ businessId, docType: "expense", externalRef: "", fields: fields(paidFrom), lines, note: "" });

describe("expense documents on the platform", () => {
  it("the owner records an expense; it posts at once and the books stay balanced", () => {
    const w = new World();
    const b = bootMaya(w);
    w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("6000", "1200.00", "October rent"), expenseLine("6300", "84.17", "power")]));
    w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("6100", "35.50")], "2000"));
    const docs = docsOf(w, b.id, "expense");
    expect(docs.map((d) => [d.status, d.totalCents])).toEqual([
      ["posted", 128417n],
      ["posted", 3550n],
    ]);
    expect(balances(w, b.id)).toMatchObject({ "6000": 120000n, "6300": 8417n, "6100": 3550n, "1000": -128417n, "2000": -3550n });
    expect(trialBalanceSum(w, b.id)).toBe(0n);
  });

  it("AI staff and the storefront cannot create expenses", () => {
    const w = new World();
    const b = bootMaya(w);
    const before = snapshot(w);
    for (const role of ["bookkeeper", "shopkeeper", "support", "storefront"] as const) {
      expect(() => w.call(b.actors[role], "createDocument", args(b.id, [expenseLine("6100", "10.00")])), role).toThrow(/permission denied/);
    }
    expect(snapshot(w)).toBe(before);
  });

  it("refuses booking an expense into revenue, tax, equity or cash, or paying it from a non-paying account", () => {
    const w = new World();
    const b = bootMaya(w);
    const before = snapshot(w);
    for (const acct of ["4000", "2100", "3000", "1000", "5000"]) {
      expect(() => w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine(acct, "10.00")])), acct).toThrow(/expense_account/);
    }
    expect(() => w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("6000", "10.00")], "4000"))).toThrow(/paid_from/);
    expect(() => w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("6000", "0")]))).toThrow(/amount_positive/);
    expect(() => w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("6000", "1.005")]))).toThrow();
    expect(snapshot(w)).toBe(before);
  });

  it("baseline (checks off) still cannot book an expense into a foreign account: the balance check refuses it", () => {
    const w = new World();
    const b = bootMaya(w, { enforce: false });
    expect(() => w.call(b.actors.owner, "createDocument", args(b.id, [expenseLine("4000", "10.00")]))).toThrow(/invariant 1|debits/);
  });

  it("a business on a configuration from before expenses refuses the document type", () => {
    const w = new World();
    w.call(w.system, "claimSystem", {} as never);
    w.call(w.system, "registerBusiness", { id: "old-shop", name: "Old", enforce: true });
    w.call(w.system, "submitConfiguration", { businessId: "old-shop", json: mayaConfig("old-shop", (c) => (c.documents = c.documents.filter((d: { id: string }) => d.id !== "expense"))), proofReportJson: "" });
    w.call(w.system, "activateConfiguration", { configId: w.rows("configVersion").find((c) => c.businessId === "old-shop")!.id });
    const owner = w.identity("old-owner");
    const code = "grant-old-owner-1-xyz";
    w.call(w.system, "createRoleGrant", { code, businessId: "old-shop", role: "owner", name: "owner", ttlSeconds: 600 });
    w.call(owner, "redeemRoleGrant", { code });
    expect(() => w.call(owner, "createDocument", args("old-shop", [expenseLine("6000", "10.00")]))).toThrow(/expense/);
  });
});
