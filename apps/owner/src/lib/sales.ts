// Net sales over time for the dashboard chart, in three views: one day hour by hour, 14 days, or 12 weeks. Each view
// ends on a chosen day so the owner can page back. Same accounts as pnl().netRevenueCents, so the chart and the
// "Net sales today" tile agree. Pure; the component does the drawing.

import type { CustomerOrderRow, JournalLineRow } from "@/data/types";
import { ACCOUNTS, dayIn } from "./reports";

export type SalesView = "hour" | "day" | "week";

export interface SalesBucket {
  key: string;
  /** under the bar: "9a" for an hour, "19" for a day, "10/19" for a week */
  short: string;
  /** in the detail line: "9–10 AM", "Mon, Oct 19" or "Oct 19 – 25" */
  long: string;
  netCents: bigint;
  orders: number;
  /** the current hour, today, or this week */
  current: boolean;
}

export interface SalesSeries {
  view: SalesView;
  /** the last day the series covers (YYYY-MM-DD) */
  end: string;
  /** the first day the series covers */
  start: string;
  buckets: SalesBucket[];
  totalCents: bigint;
  totalOrders: number;
}

export const CHART_DAYS = 14;
export const CHART_WEEKS = 12;
const MIN_DAYS_FOR_DAILY = 3;
const NET_SALES = new Set<string>([ACCOUNTS.revenue, ACCOUNTS.discounts, ACCOUNTS.refunds]);
// Orders that never turned into a sale.
const NOT_SOLD = new Set(["pending_payment", "cancelled"]);

/** Hour of day (0-23) of a micros timestamp in an IANA time zone. */
export function hourIn(micros: bigint, timeZone: string): number {
  const d = new Date(Number(micros / 1000n));
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(d)) % 24;
  } catch {
    return d.getUTCHours();
  }
}

/** "2026-10-25" shifted by n calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The Monday on or before a day. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((dow + 6) % 7));
}

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

/** "Oct 19 – 25", or "Sep 28 – Oct 4" across a month. */
function rangeLabel(from: string, to: string): string {
  const a = dayLabel(from, { month: "short", day: "numeric" });
  return from.slice(0, 7) === to.slice(0, 7) ? `${a} – ${Number(to.slice(8))}` : `${a} – ${dayLabel(to, { month: "short", day: "numeric" })}`;
}

function hourLabel(h: number): string {
  const ap = (x: number) => (x % 24 < 12 ? "AM" : "PM");
  const h12 = (x: number) => (x % 12 === 0 ? 12 : x % 12);
  return ap(h) === ap(h + 1) ? `${h12(h)}–${h12(h + 1)} ${ap(h)}` : `${h12(h)} ${ap(h)}–${h12(h + 1)} ${ap(h + 1)}`;
}

/** Long label for a day relative to today: "Today", "Yesterday", or "Fri, Oct 24". */
export function relativeDay(day: string, today: string): string {
  const back = daysBetween(day, today);
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  return dayLabel(day, { weekday: "short", month: "short", day: "numeric" });
}

/** What a series covers, for the chart header: "Today", "Last 14 days", "Oct 5 – 18", "Last 12 weeks". */
export function periodLabel(s: Pick<SalesSeries, "view" | "start" | "end">, today: string): string {
  if (s.view === "hour") return relativeDay(s.end, today);
  if (s.end === today) return s.view === "day" ? `Last ${CHART_DAYS} days` : `Last ${CHART_WEEKS} weeks`;
  return rangeLabel(s.start, s.view === "week" ? addDays(weekStart(s.end), 6) : s.end);
}

interface Sale {
  at: bigint;
  day: string;
  cents: bigint;
}

function salesOf(lines: readonly JournalLineRow[], timeZone: string): Sale[] {
  return lines
    .filter((l) => NET_SALES.has(l.accountCode))
    .map((l) => ({ at: l.postedAt.microsSinceUnixEpoch, day: dayIn(l.postedAt.microsSinceUnixEpoch, timeZone), cents: l.creditCents - l.debitCents }));
}

export interface SalesHistory {
  today: string;
  /** first and latest day with sales, up to today */
  first?: string;
  last?: string;
  /** the view to open with: by hour (on the latest sales day) until there are 3 days of history, then by day */
  view: SalesView;
  end: string;
}

export function salesHistory(lines: readonly JournalLineRow[], timeZone: string, nowMicros: bigint): SalesHistory {
  const today = dayIn(nowMicros, timeZone);
  const days = salesOf(lines, timeZone).map((s) => s.day).filter((d) => d <= today).sort();
  const first = days[0];
  const last = days[days.length - 1];
  const daily = first !== undefined && daysBetween(first, today) + 1 >= MIN_DAYS_FOR_DAILY;
  return { today, first, last, view: daily ? "day" : "hour", end: daily ? today : (last ?? today) };
}

/** The first day a view ending on `end` covers. */
export function windowStart(view: SalesView, end: string): string {
  if (view === "hour") return end;
  if (view === "day") return addDays(end, -(CHART_DAYS - 1));
  return addDays(weekStart(end), -7 * (CHART_WEEKS - 1));
}

/** Where the ‹ and › arrows go from a view ending on `end`: a whole window back or forward, never past today. */
export function pageEnd(view: SalesView, end: string, dir: -1 | 1, today: string): string {
  const step = view === "hour" ? 1 : view === "day" ? CHART_DAYS : 7 * CHART_WEEKS;
  const next = addDays(end, dir * step);
  return next > today ? today : next;
}

export function salesSeries(lines: readonly JournalLineRow[], orders: readonly CustomerOrderRow[], timeZone: string, nowMicros: bigint, view: SalesView, end: string): SalesSeries {
  const today = dayIn(nowMicros, timeZone);
  const sales = salesOf(lines, timeZone);
  const sold = orders.filter((o) => !NOT_SOLD.has(o.status)).map((o) => ({ at: o.createdAt.microsSinceUnixEpoch, day: dayIn(o.createdAt.microsSinceUnixEpoch, timeZone) }));
  const start = windowStart(view, end);

  if (view === "hour") {
    const hourly = new Map<number, { cents: bigint; orders: number }>();
    const slot = (h: number) => hourly.get(h) ?? (hourly.set(h, { cents: 0n, orders: 0 }), hourly.get(h)!);
    for (const s of sales) if (s.day === end) slot(hourIn(s.at, timeZone)).cents += s.cents;
    for (const o of sold) if (o.day === end) slot(hourIn(o.at, timeZone)).orders += 1;
    // Shop hours by default (6 AM to 11 PM), widened to take in any hour that had sales.
    const busy = [...hourly.keys()];
    const from = Math.min(6, ...busy);
    const to = Math.max(22, ...busy);
    const nowHour = end === today ? hourIn(nowMicros, timeZone) : -1;
    const buckets: SalesBucket[] = [];
    for (let h = from; h <= to; h++) {
      const v = hourly.get(h);
      buckets.push({ key: `${end}T${String(h).padStart(2, "0")}`, short: h % 12 === 0 ? (h === 0 ? "12a" : "12p") : `${h % 12}${h < 12 ? "a" : "p"}`, long: hourLabel(h), netCents: v?.cents ?? 0n, orders: v?.orders ?? 0, current: h === nowHour });
    }
    return finish(view, start, end, buckets);
  }

  const byKey = new Map<string, SalesBucket>();
  if (view === "day") {
    for (let i = 0; i < CHART_DAYS; i++) {
      const key = addDays(start, i);
      byKey.set(key, { key, short: String(Number(key.slice(8))), long: dayLabel(key, { weekday: "short", month: "short", day: "numeric" }), netCents: 0n, orders: 0, current: key === today });
    }
  } else {
    const thisWeek = weekStart(today);
    for (let i = 0; i < CHART_WEEKS; i++) {
      const key = addDays(start, 7 * i);
      byKey.set(key, { key, short: `${Number(key.slice(5, 7))}/${Number(key.slice(8))}`, long: rangeLabel(key, addDays(key, 6)), netCents: 0n, orders: 0, current: key === thisWeek });
    }
  }
  const bucketOf = (day: string) => byKey.get(view === "day" ? day : weekStart(day));
  for (const s of sales) {
    const b = bucketOf(s.day);
    if (b) b.netCents += s.cents;
  }
  for (const o of sold) {
    const b = bucketOf(o.day);
    if (b) b.orders += 1;
  }
  return finish(view, start, end, [...byKey.values()]);
}

function finish(view: SalesView, start: string, end: string, buckets: SalesBucket[]): SalesSeries {
  return { view, start, end, buckets, totalCents: buckets.reduce((a, b) => a + b.netCents, 0n), totalOrders: buckets.reduce((a, b) => a + b.orders, 0) };
}
