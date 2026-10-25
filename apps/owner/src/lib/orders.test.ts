import { describe, expect, it } from "vitest";
import type { RegisterMovementRow } from "@/data/types";
import { initial, orderItems, paymentWords, shortTime } from "./orders";
import { fullLevel } from "./stock";

const TZ = "America/Los_Angeles";
// Sunday 2026-10-25 15:30 in Los Angeles.
const NOW = BigInt(Date.parse("2026-10-25T22:30:00Z")) * 1000n;
const micros = (iso: string) => BigInt(Date.parse(iso)) * 1000n;
const line = (productId: string, qty: string) => ({ values: [{ name: "productId", value: productId }, { name: "qty", value: qty }] });

describe("order rows", () => {
  it("sums each product's quantity in the order it first appears", () => {
    const names: Record<string, string> = { pack5: "Pack of 5", holo: "Holo sticker" };
    const sale = { lines: [line("pack5", "1"), line("holo", "1"), line("pack5", "1"), { values: [] }] };
    expect(orderItems(sale, (id) => names[id] ?? id)).toBe("2 × Pack of 5, 1 × Holo sticker");
    expect(orderItems(undefined, (id) => id)).toBe("");
  });

  it("says how the order was paid", () => {
    const o = { totalCents: 1500n, paidCents: 1500n, refundedCents: 0n };
    expect(paymentWords({ ...o, status: "paid" })).toBe("paid by card");
    expect(paymentWords({ ...o, status: "picked_up" })).toBe("paid by card");
    expect(paymentWords({ ...o, paidCents: 0n, status: "pending_payment" })).toBe("awaiting payment");
    expect(paymentWords({ ...o, refundedCents: 300n, status: "partially_refunded" })).toBe("refunded $3.00 of $15.00");
    expect(paymentWords({ ...o, status: "cancelled" })).toBe("cancelled");
  });

  it("initial and short time", () => {
    expect(initial(" marcus")).toBe("M");
    expect(initial("")).toBe("?");
    expect(shortTime(micros("2026-10-25T23:30:00Z"), TZ, NOW)).toBe("4:30pm");
    expect(shortTime(micros("2026-10-24T16:05:00Z"), TZ, NOW)).toBe("Yesterday");
    expect(shortTime(micros("2026-10-22T16:05:00Z"), TZ, NOW)).toBe("Thu");
    expect(shortTime(micros("2026-10-12T16:05:00Z"), TZ, NOW)).toBe("Oct 12");
  });
});

describe("fullLevel", () => {
  let id = 0n;
  const mv = (kind: "in" | "out", qty: number, doc: bigint, at: number) =>
    ({ id: ++id, kind, qty: BigInt(qty), documentId: doc, postedAt: { microsSinceUnixEpoch: BigInt(at) } }) as unknown as RegisterMovementRow;
  const types: Record<string, string> = { "1": "opening_balance", "2": "sale", "3": "stock_receipt", "4": "stock_adjustment", "5": "stock_receipt" };
  // document 5 reverses delivery 3
  const typeOf = (d: bigint) => ({ docType: types[String(d)] ?? "", reversalOf: d === 5n ? 3n : 0n });
  const newestFirst = (ms: RegisterMovementRow[]) => [...ms].reverse();

  it("is the count right after stock last came in; sales only use it up", () => {
    const ms = [mv("in", 100, 1n, 1), mv("out", 6, 2n, 2)];
    expect(fullLevel(newestFirst(ms), 94n, typeOf)).toBe(100n);
    // restock to 110 after selling down to 10
    const restocked = [...ms, mv("out", 84, 2n, 3), mv("in", 100, 3n, 4), mv("out", 4, 2n, 5)];
    expect(fullLevel(newestFirst(restocked), 106n, typeOf)).toBe(110n);
  });

  it("goes back to the earlier fill when a delivery is reversed", () => {
    const ms = [mv("in", 48, 1n, 1), mv("out", 9, 2n, 2), mv("in", 240, 3n, 3), mv("out", 240, 5n, 4), mv("out", 14, 2n, 5)];
    expect(fullLevel(newestFirst(ms), 25n, typeOf)).toBe(48n);
  });

  it("drops by stock removed by hand", () => {
    const ms = [mv("in", 100, 1n, 1), mv("out", 5, 4n, 2), mv("out", 10, 2n, 3)];
    expect(fullLevel(newestFirst(ms), 85n, typeOf)).toBe(95n);
    expect(fullLevel([], 7n, typeOf)).toBe(7n);
  });
});
