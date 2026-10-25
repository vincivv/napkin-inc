// Net sales over time for the dashboard chart: one bucket per day for the last 14 days, or one per hour of the latest
// sales day while the shop has fewer than 3 days of history. Same accounts as pnl().netRevenueCents, so the chart
// and the "Net sales today" tile agree. Pure; the component does the drawing.

import type { CustomerOrderRow, JournalLineRow } from "@/data/types";
import { ACCOUNTS, dayIn } from "./reports";

export interface SalesBucket {
  key: string;
  /** under the bar: "19" for a day, "9a" for an hour */
  short: string;
  /** in the detail line: "Mon, Oct 19" or "9–10 AM" */
  long: string;
  netCents: bigint;
  orders: number;
  /** today, or the current hour */
  current: boolean;
}

export interface SalesSeries {
  mode: "day" | "hour";
  /** hour mode: the day shown (YYYY-MM-DD); day mode: today */
  day: string;
  buckets: SalesBucket[];
  totalCents: bigint;
  totalOrders: number;
}

export const CHART_DAYS = 14;
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
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

function dayLabel(day: string, opts: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(`${day}T12:00:00Z`));
}

function hourLabel(h: number): string {
  const ap = (x: number) => (x % 24 < 12 ? "AM" : "PM");
  const h12 = (x: number) => (x % 12 === 0 ? 12 : x % 12);
  return ap(h) === ap(h + 1) ? `${h12(h)}–${h12(h + 1)} ${ap(h)}` : `${h12(h)} ${ap(h)}–${h12(h + 1)} ${ap(h + 1)}`;
}

/** Long label for the day a series covers, relative to today: "Today", "Yesterday", or "Fri, Oct 24". */
export function relativeDay(day: string, today: string): string {
  const back = daysBetween(day, today);
  if (back === 0) return "Today";
  if (back === 1) return "Yesterday";
  return dayLabel(day, { weekday: "short", month: "short", day: "numeric" });
}

export function salesSeries(lines: readonly JournalLineRow[], orders: readonly CustomerOrderRow[], timeZone: string, nowMicros: bigint): SalesSeries {
  const today = dayIn(nowMicros, timeZone);
  const sales = lines
    .filter((l) => NET_SALES.has(l.accountCode))
    .map((l) => ({ at: l.postedAt.microsSinceUnixEpoch, cents: l.creditCents - l.debitCents }));
  const sold = orders.filter((o) => !NOT_SOLD.has(o.status)).map((o) => o.createdAt.microsSinceUnixEpoch);

  const saleDays = sales.map((s) => dayIn(s.at, timeZone)).filter((d) => d <= today).sort();
  const first = saleDays[0];
  const history = first ? daysBetween(first, today) + 1 : 0;

  if (history >= MIN_DAYS_FOR_DAILY) {
    const start = addDays(today, -(CHART_DAYS - 1));
    const byKey = new Map<string, SalesBucket>();
    for (let i = 0; i < CHART_DAYS; i++) {
      const key = addDays(start, i);
      byKey.set(key, { key, short: String(Number(key.slice(8))), long: dayLabel(key, { weekday: "short", month: "short", day: "numeric" }), netCents: 0n, orders: 0, current: key === today });
    }
    for (const s of sales) {
      const b = byKey.get(dayIn(s.at, timeZone));
      if (b) b.netCents += s.cents;
    }
    for (const at of sold) {
      const b = byKey.get(dayIn(at, timeZone));
      if (b) b.orders += 1;
    }
    return finish("day", today, [...byKey.values()]);
  }

  // Too little history for a daily chart: the latest day with sales (today if there are any), hour by hour.
  const day = saleDays[saleDays.length - 1] ?? today;
  const onDay = (at: bigint) => dayIn(at, timeZone) === day;
  const hourly = new Map<number, { cents: bigint; orders: number }>();
  const slot = (h: number) => hourly.get(h) ?? (hourly.set(h, { cents: 0n, orders: 0 }), hourly.get(h)!);
  for (const s of sales) if (onDay(s.at)) slot(hourIn(s.at, timeZone)).cents += s.cents;
  for (const at of sold) if (onDay(at)) slot(hourIn(at, timeZone)).orders += 1;
  // Shop hours by default (6 AM to 11 PM), widened to take in any hour that had sales.
  const busy = [...hourly.keys()];
  const from = Math.min(6, ...busy);
  const to = Math.max(22, ...busy);
  const nowHour = day === today ? hourIn(nowMicros, timeZone) : -1;
  const buckets: SalesBucket[] = [];
  for (let h = from; h <= to; h++) {
    const v = hourly.get(h);
    buckets.push({ key: `${day}T${String(h).padStart(2, "0")}`, short: h % 12 === 0 ? (h === 0 ? "12a" : "12p") : `${h % 12}${h < 12 ? "a" : "p"}`, long: hourLabel(h), netCents: v?.cents ?? 0n, orders: v?.orders ?? 0, current: h === nowHour });
  }
  return finish("hour", day, buckets);
}

function finish(mode: SalesSeries["mode"], day: string, buckets: SalesBucket[]): SalesSeries {
  return { mode, day, buckets, totalCents: buckets.reduce((a, b) => a + b.netCents, 0n), totalOrders: buckets.reduce((a, b) => a + b.orders, 0) };
}
