import { describe, expect, it } from "vitest";
import type { CustomerOrderRow, JournalLineRow } from "@/data/types";
import { hourIn, relativeDay, salesSeries } from "./sales";

const TZ = "America/Los_Angeles";
// 2026-10-25 15:30 in Los Angeles (PDT, UTC-7).
const NOW = BigInt(Date.parse("2026-10-25T22:30:00Z")) * 1000n;
const at = (iso: string) => ({ microsSinceUnixEpoch: BigInt(Date.parse(iso)) * 1000n });

let id = 0n;
const line = (iso: string, accountCode: string, debit: number, credit: number) =>
  ({ id: ++id, accountCode, debitCents: BigInt(debit), creditCents: BigInt(credit), postedAt: at(iso) }) as unknown as JournalLineRow;
const sale = (iso: string, cents: number) => [line(iso, "1010", cents, 0), line(iso, "4000", 0, cents)];
const order = (iso: string, status = "paid") => ({ id: ++id, status, createdAt: at(iso) }) as unknown as CustomerOrderRow;

describe("salesSeries", () => {
  it("shows the last 14 days once there are 3 days of history, in the shop's time zone", () => {
    const lines = [
      ...sale("2026-10-20T18:00:00Z", 1200),
      ...sale("2026-10-25T06:30:00Z", 500), // 11:30 PM on Oct 24 in LA
      ...sale("2026-10-25T20:00:00Z", 800),
      line("2026-10-25T21:00:00Z", "4200", 300, 0), // refund
      line("2026-10-25T21:00:00Z", "1000", 999, 0), // cash only, not sales
    ];
    const orders = [order("2026-10-25T20:00:00Z"), order("2026-10-25T20:05:00Z", "pending_payment"), order("2026-10-25T06:30:00Z")];
    const s = salesSeries(lines, orders, TZ, NOW);
    expect(s.mode).toBe("day");
    expect(s.buckets).toHaveLength(14);
    expect(s.buckets[0]!.key).toBe("2026-10-12");
    const last = s.buckets.at(-1)!;
    expect(last).toMatchObject({ key: "2026-10-25", short: "25", long: "Sun, Oct 25", netCents: 500n, orders: 1, current: true });
    expect(s.buckets.find((b) => b.key === "2026-10-24")).toMatchObject({ netCents: 500n, orders: 1 });
    expect(s.totalCents).toBe(2200n);
    expect(s.totalOrders).toBe(2);
  });

  it("switches to hours of the latest sales day with fewer than 3 days of history", () => {
    const lines = [...sale("2026-10-24T09:10:00Z", 1500), ...sale("2026-10-24T17:00:00Z", 700), ...sale("2026-10-24T17:40:00Z", 300)];
    const s = salesSeries(lines, [order("2026-10-24T17:00:00Z")], TZ, NOW);
    expect(s.mode).toBe("hour");
    expect(s.day).toBe("2026-10-24");
    // 2 AM sale widens the default 6 AM-11 PM window.
    expect(s.buckets[0]).toMatchObject({ short: "2a", long: "2–3 AM", netCents: 1500n });
    expect(s.buckets.at(-1)!.short).toBe("10p");
    expect(s.buckets.find((b) => b.short === "10a")).toMatchObject({ long: "10–11 AM", netCents: 1000n, orders: 1 });
    expect(s.buckets.some((b) => b.current)).toBe(false);
    expect(s.totalCents).toBe(2500n);
  });

  it("shows today's hours for a shop with no sales yet", () => {
    const s = salesSeries([], [], TZ, NOW);
    expect(s.mode).toBe("hour");
    expect(s.day).toBe("2026-10-25");
    expect(s.buckets.find((b) => b.current)!.long).toBe("3–4 PM");
    expect(s.totalCents).toBe(0n);
  });
});

describe("labels", () => {
  it("hourIn uses the time zone; relativeDay names nearby days", () => {
    expect(hourIn(NOW, TZ)).toBe(15);
    expect(hourIn(NOW, "UTC")).toBe(22);
    expect(relativeDay("2026-10-25", "2026-10-25")).toBe("Today");
    expect(relativeDay("2026-10-24", "2026-10-25")).toBe("Yesterday");
    expect(relativeDay("2026-10-20", "2026-10-25")).toBe("Tue, Oct 20");
  });
});
