import { describe, expect, it } from "vitest";
import type { CustomerOrderRow, JournalLineRow } from "@/data/types";
import { hourIn, pageEnd, periodLabel, relativeDay, salesHistory, salesSeries, windowStart } from "./sales";

const TZ = "America/Los_Angeles";
// Sunday 2026-10-25 15:30 in Los Angeles (PDT, UTC-7).
const NOW = BigInt(Date.parse("2026-10-25T22:30:00Z")) * 1000n;
const TODAY = "2026-10-25";
const at = (iso: string) => ({ microsSinceUnixEpoch: BigInt(Date.parse(iso)) * 1000n });

let id = 0n;
const line = (iso: string, accountCode: string, debit: number, credit: number) =>
  ({ id: ++id, accountCode, debitCents: BigInt(debit), creditCents: BigInt(credit), postedAt: at(iso) }) as unknown as JournalLineRow;
const sale = (iso: string, cents: number) => [line(iso, "1010", cents, 0), line(iso, "4000", 0, cents)];
const order = (iso: string, status = "paid") => ({ id: ++id, status, createdAt: at(iso) }) as unknown as CustomerOrderRow;

describe("salesHistory", () => {
  it("opens by day once there are 3 days of history", () => {
    const h = salesHistory([...sale("2026-10-20T18:00:00Z", 100), ...sale("2026-10-24T18:00:00Z", 100)], TZ, NOW);
    expect(h).toMatchObject({ today: TODAY, first: "2026-10-20", last: "2026-10-24", view: "day", end: TODAY });
  });

  it("opens by hour on the latest sales day before that", () => {
    expect(salesHistory(sale("2026-10-24T18:00:00Z", 100), TZ, NOW)).toMatchObject({ view: "hour", end: "2026-10-24" });
    expect(salesHistory([], TZ, NOW)).toMatchObject({ view: "hour", end: TODAY, first: undefined });
  });
});

describe("salesSeries", () => {
  const lines = [
    ...sale("2026-10-20T18:00:00Z", 1200),
    ...sale("2026-10-25T06:30:00Z", 500), // 11:30 PM on Oct 24 in LA
    ...sale("2026-10-25T20:00:00Z", 800),
    line("2026-10-25T21:00:00Z", "4200", 300, 0), // refund
    line("2026-10-25T21:00:00Z", "1000", 999, 0), // cash only, not sales
    ...sale("2026-08-03T18:00:00Z", 4000),
  ];
  const orders = [order("2026-10-25T20:00:00Z"), order("2026-10-25T20:05:00Z", "pending_payment"), order("2026-10-25T06:30:00Z")];

  it("by day: 14 days ending on the chosen day, in the shop's time zone", () => {
    const s = salesSeries(lines, orders, TZ, NOW, "day", TODAY);
    expect(s.buckets).toHaveLength(14);
    expect(s.start).toBe("2026-10-12");
    expect(s.buckets.at(-1)).toMatchObject({ key: TODAY, short: "25", long: "Sun, Oct 25", netCents: 500n, orders: 1, current: true });
    expect(s.buckets.find((b) => b.key === "2026-10-24")).toMatchObject({ netCents: 500n, orders: 1 });
    expect(s.totalCents).toBe(2200n);
    expect(s.totalOrders).toBe(2);
    expect(periodLabel(s, TODAY)).toBe("Last 14 days");

    const back = salesSeries(lines, orders, TZ, NOW, "day", "2026-10-11");
    expect(back.totalCents).toBe(0n);
    expect(back.buckets.some((b) => b.current)).toBe(false);
    expect(periodLabel(back, TODAY)).toBe("Sep 28 – Oct 11");
  });

  it("by week: 12 Monday-to-Sunday weeks", () => {
    const s = salesSeries(lines, orders, TZ, NOW, "week", TODAY);
    expect(s.buckets).toHaveLength(12);
    expect(s.start).toBe("2026-08-03");
    expect(s.buckets[0]).toMatchObject({ short: "8/3", long: "Aug 3 – 9", netCents: 4000n });
    expect(s.buckets.at(-1)).toMatchObject({ key: "2026-10-19", long: "Oct 19 – 25", netCents: 2200n, orders: 2, current: true });
    expect(periodLabel(s, TODAY)).toBe("Last 12 weeks");
    expect(periodLabel(salesSeries(lines, orders, TZ, NOW, "week", "2026-08-02"), TODAY)).toBe("May 11 – Aug 2");
  });

  it("by hour: one day, 6 AM to 11 PM widened to any hour with sales", () => {
    const day = [...sale("2026-10-24T09:10:00Z", 1500), ...sale("2026-10-24T17:00:00Z", 700), ...sale("2026-10-24T17:40:00Z", 300)];
    const s = salesSeries(day, [order("2026-10-24T17:00:00Z")], TZ, NOW, "hour", "2026-10-24");
    expect(s.buckets[0]).toMatchObject({ short: "2a", long: "2–3 AM", netCents: 1500n });
    expect(s.buckets.at(-1)!.short).toBe("10p");
    expect(s.buckets.find((b) => b.short === "10a")).toMatchObject({ long: "10–11 AM", netCents: 1000n, orders: 1 });
    expect(s.buckets.some((b) => b.current)).toBe(false);
    expect(periodLabel(s, TODAY)).toBe("Yesterday");

    const now = salesSeries([], [], TZ, NOW, "hour", TODAY);
    expect(now.buckets.find((b) => b.current)!.long).toBe("3–4 PM");
    expect(now.totalCents).toBe(0n);
  });
});

describe("paging", () => {
  it("steps a whole window and stops at today", () => {
    expect(pageEnd("hour", TODAY, -1, TODAY)).toBe("2026-10-24");
    expect(pageEnd("day", TODAY, -1, TODAY)).toBe("2026-10-11");
    expect(pageEnd("day", "2026-10-20", 1, TODAY)).toBe(TODAY);
    expect(pageEnd("week", TODAY, -1, TODAY)).toBe("2026-08-02");
    expect(windowStart("week", "2026-08-02")).toBe("2026-05-11");
  });
});

describe("labels", () => {
  it("hourIn uses the time zone; relativeDay names nearby days", () => {
    expect(hourIn(NOW, TZ)).toBe(15);
    expect(hourIn(NOW, "UTC")).toBe(22);
    expect(relativeDay(TODAY, TODAY)).toBe("Today");
    expect(relativeDay("2026-10-24", TODAY)).toBe("Yesterday");
    expect(relativeDay("2026-10-20", TODAY)).toBe("Tue, Oct 20");
  });
});
