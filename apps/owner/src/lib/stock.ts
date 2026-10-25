// Stock page model: one row per stock item, read only from the books (stock register balances and movements)
// and the active configuration's catalogs. Nothing here estimates or invents a quantity.

import type { Configuration } from "@napkin/schema";
import type { DocumentRow, RegisterBalanceRow, RegisterMovementRow } from "@/data/types";
import { parseDims, productsUsingStock } from "./config";
import { dayIn, stockLevel, type StockLevel } from "./reports";

export const STOCK_REGISTER = "stock";
export const STOCK_DIM = "item";

export interface StockItemView {
  item: string;
  name: string;
  qty: bigint;
  valueCents: bigint;
  /** catalog unit cost, else value ÷ quantity; undefined when neither is known */
  unitCostCents: bigint | undefined;
  level: StockLevel;
  /** the largest pack that draws on this item (what "critical" is measured against) */
  largest: { name: string; units: bigint } | undefined;
  /** how many of each product the current quantity can still fill */
  fills: { productId: string; name: string; units: bigint; count: bigint }[];
  usedToday: bigint;
  used7d: bigint;
  /** last 7 calendar days (oldest first) of units used, in the business's time zone */
  daily: { day: string; used: bigint }[];
  lastIn: RegisterMovementRow | undefined;
  movements: RegisterMovementRow[];
}

const dollarsToCents = (v: unknown): bigint | undefined => {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(v ?? "").trim());
  return m ? BigInt(m[1]!) * 100n + BigInt((m[2] ?? "").padEnd(2, "0")) : undefined;
};

/** The last `n` calendar days ending today, as YYYY-MM-DD in `timeZone`. */
export function lastDays(n: number, timeZone: string, nowMs = Date.now()): string[] {
  const out = new Set<string>();
  // walk back in 12-hour steps so DST shifts never skip a day
  for (let t = nowMs; out.size < n; t -= 12 * 3600_000) out.add(dayIn(BigInt(t) * 1000n, timeZone));
  return [...out].reverse();
}

export function stockItems(
  config: Configuration | undefined,
  balances: readonly RegisterBalanceRow[],
  movements: readonly RegisterMovementRow[],
  packs: Map<string, { productId: string; name: string; units: bigint }[]>,
  timeZone: string,
  nowMs = Date.now(),
): StockItemView[] {
  const catalog = config?.catalogs.find((c) => c.lineKey === "stockItem")?.entries ?? [];
  const bal = new Map<string, RegisterBalanceRow>();
  for (const b of balances) if (b.registerId === STOCK_REGISTER) bal.set(parseDims(b.dimsKey)[STOCK_DIM] ?? b.dimsKey, b);
  const mov = new Map<string, RegisterMovementRow[]>();
  for (const m of movements) {
    if (m.registerId !== STOCK_REGISTER) continue;
    const item = parseDims(m.dimsKey)[STOCK_DIM] ?? m.dimsKey;
    mov.set(item, [...(mov.get(item) ?? []), m]);
  }
  const ids = [...new Set([...catalog.map((e) => e.id), ...bal.keys(), ...mov.keys()])];
  const days = lastDays(7, timeZone, nowMs);
  const today = days[days.length - 1]!;

  return ids
    .map((item) => {
      const entry = catalog.find((e) => e.id === item);
      const b = bal.get(item);
      const qty = b?.qty ?? 0n;
      const valueCents = b?.amountCents ?? 0n;
      const ms = (mov.get(item) ?? []).slice().sort((x, y) => (y.postedAt.microsSinceUnixEpoch > x.postedAt.microsSinceUnixEpoch ? 1 : -1));
      const usedBy = packs.get(item) ?? [];
      const largest = usedBy.reduce<(typeof usedBy)[number] | undefined>((m, p) => (!m || p.units > m.units ? p : m), undefined);
      const byDay = new Map<string, bigint>();
      for (const m of ms) {
        if (m.kind !== "out") continue;
        const d = dayIn(m.postedAt.microsSinceUnixEpoch, timeZone);
        byDay.set(d, (byDay.get(d) ?? 0n) + (m.qty < 0n ? -m.qty : m.qty));
      }
      const daily = days.map((day) => ({ day, used: byDay.get(day) ?? 0n }));
      return {
        item,
        name: String(entry?.data["name"] ?? item),
        qty,
        valueCents,
        unitCostCents: dollarsToCents(entry?.data["unitCost"]) ?? (qty > 0n ? valueCents / qty : undefined),
        level: stockLevel(qty, largest?.units),
        largest: largest && { name: largest.name, units: largest.units },
        fills: usedBy.map((p) => ({ ...p, count: qty > 0n ? qty / p.units : 0n })),
        usedToday: byDay.get(today) ?? 0n,
        used7d: daily.reduce((s, d) => s + d.used, 0n),
        daily,
        lastIn: ms.find((m) => m.kind === "in"),
        movements: ms,
      };
    })
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] || a.name.localeCompare(b.name));
}

const LEVEL_ORDER: Record<StockLevel, number> = { out: 0, critical: 1, low: 2, ok: 3 };

/** Rough days of stock left at the last 7 days' pace; undefined when nothing was used. */
export function daysLeft(v: Pick<StockItemView, "qty" | "used7d">): number | undefined {
  if (v.used7d <= 0n || v.qty <= 0n) return undefined;
  return Math.floor((Number(v.qty) * 7) / Number(v.used7d));
}

/** Deliveries (stock receipts) still waiting for approval: they are not in the counts until posted. */
export function pendingDeliveries(documents: readonly DocumentRow[], docType = "stock_receipt"): DocumentRow[] {
  return documents.filter((d) => d.docType === docType && d.status === "draft");
}

export function lineValue(line: DocumentRow["lines"][number], name: string): string {
  return line.values.find((v) => v.name === name)?.value ?? "";
}

/** Items that are out or can't fill their largest pack (the sidebar badge). */
export function stockAlerts(balances: readonly RegisterBalanceRow[], config: Configuration | undefined): number {
  const packs = productsUsingStock(config);
  const qty = new Map<string, bigint>();
  for (const b of balances) if (b.registerId === STOCK_REGISTER) qty.set(parseDims(b.dimsKey)[STOCK_DIM] ?? b.dimsKey, b.qty);
  let n = 0;
  for (const [item, usedBy] of packs) {
    const largest = usedBy.reduce((m, p) => (p.units > m ? p.units : m), 0n);
    const lvl = stockLevel(qty.get(item) ?? 0n, largest);
    if (lvl === "out" || lvl === "critical") n++;
  }
  return n;
}
