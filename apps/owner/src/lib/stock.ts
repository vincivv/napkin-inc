// Stock page model: one row per stock item, read only from the books (stock register balances and movements)
// and the active configuration's catalogs. Nothing here estimates or invents a quantity.

import type { Configuration } from "@napkin/schema";
import type { DocLine, DocumentRow, FieldValue, RegisterBalanceRow, RegisterMovementRow } from "@/data/types";
import { parseDims, productsUsingStock } from "./config";
import { normalizeAmount } from "./expenses";
import { dayIn, stockLevel, type StockLevel } from "./reports";

export const STOCK_REGISTER = "stock";
export const STOCK_DIM = "item";

export interface StockItemView {
  item: string;
  name: string;
  qty: bigint;
  /**
   * What "full" means for the bar ("94 / 100"): the count right after stock last came in (starting stock or a
   * delivery), less anything taken off by hand since (a removal, or reversing a delivery). Never below qty.
   */
  full: bigint;
  valueCents: bigint;
  /** catalog unit cost, else value ÷ quantity; undefined when neither is known */
  unitCostCents: bigint | undefined;
  level: StockLevel;
  /** the largest pack that draws on this item (what "critical" is measured against) */
  largest: { name: string; units: bigint } | undefined;
  /** how many of each product the current quantity can still fill */
  fills: { productId: string; name: string; units: bigint; count: bigint }[];
  /** units sold (sales only: stock removed by hand is not "used") */
  usedToday: bigint;
  used7d: bigint;
  /** last 7 calendar days (oldest first) of units sold, in the business's time zone */
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
  docOf: (documentId: bigint) => Pick<DocumentRow, "docType" | "reversalOf"> | undefined,
  nowMs = Date.now(),
): StockItemView[] {
  const docTypeOf = (id: bigint) => docOf(id)?.docType;
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
        if (m.kind !== "out" || docTypeOf(m.documentId) !== "sale") continue;
        const d = dayIn(m.postedAt.microsSinceUnixEpoch, timeZone);
        byDay.set(d, (byDay.get(d) ?? 0n) + (m.qty < 0n ? -m.qty : m.qty));
      }
      const daily = days.map((day) => ({ day, used: byDay.get(day) ?? 0n }));
      return {
        item,
        name: String(entry?.data["name"] ?? item),
        qty,
        full: fullLevel(ms, qty, docOf),
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

/** "Out", "Can’t fill Pack of 5", "Running low" or "OK". */
export function stockLevelLabel(v: Pick<StockItemView, "level" | "largest">): string {
  if (v.level === "out") return "Out";
  if (v.level === "critical") return `Can’t fill ${v.largest?.name ?? "one"}`;
  if (v.level === "low") return "Running low";
  return "OK";
}

/** See StockItemView.full. `newestFirst` is the item's movements, newest first. */
export function fullLevel(
  newestFirst: readonly RegisterMovementRow[],
  qty: bigint,
  docOf: (documentId: bigint) => Pick<DocumentRow, "docType" | "reversalOf"> | undefined,
): bigint {
  let balance = 0n;
  let full = 0n;
  // Each time stock came in, what "full" was before, so reversing that delivery puts it back.
  const fills: { doc: bigint; before: bigint }[] = [];
  for (let i = newestFirst.length - 1; i >= 0; i--) {
    const m = newestFirst[i]!;
    const units = m.qty < 0n ? -m.qty : m.qty;
    const doc = docOf(m.documentId);
    balance += m.kind === "in" ? units : -units;
    if (doc?.docType === "sale") continue;
    if (m.kind === "in") {
      fills.push({ doc: m.documentId, before: full });
      full = balance;
    } else if (doc?.reversalOf && fills.at(-1)?.doc === doc.reversalOf) {
      full = fills.pop()!.before;
    } else {
      full -= units;
    }
  }
  return full > qty ? full : qty;
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

// ---------- changing stock by hand (the "stock_added" / "stock_removed" document types) ----------

export const STOCK_ADDED = "stock_added";
export const STOCK_REMOVED = "stock_removed";
export type StockChange = "add" | "remove";

/** How added stock was paid for: doc.paidFrom is an account code (the template's checks refuse anything else). */
export const PAID_FROM = [
  { code: "1000", label: "Paid now", hint: "from the business’s money" },
  { code: "2000", label: "I owe the supplier", hint: "pay them later" },
  { code: "3000", label: "Out of my own pocket", hint: "or made it myself" },
] as const;

export const REMOVE_REASONS = ["Spoiled or expired", "Broken or damaged", "Given away", "Recount: I have fewer than this shows", "Used for myself"] as const;

/** True when the active configuration has the hand stock-change documents (older ones need a recompile). */
export function canChangeStock(config: Configuration | undefined): boolean {
  const ids = new Set(config?.documents.map((d) => d.id) ?? []);
  return ids.has(STOCK_ADDED) && ids.has(STOCK_REMOVED);
}

export interface StockDraft {
  item: string;
  qty: string;
  unitCost: string;
  paidFrom: string;
  supplier: string;
  reason: string;
}

/** Validate a draft and build the createDocument payload, or say what is wrong in plain words. */
export function buildStockChange(kind: StockChange, d: StockDraft, onHand: bigint | undefined): { docType: string; fields: FieldValue[]; lines: DocLine[]; valueCents: bigint } | { error: string } {
  if (!d.item) return { error: "Pick an item." };
  const qty = d.qty.trim();
  if (!/^\d+$/.test(qty) || BigInt(qty) < 1n) return { error: "Enter how many, as a whole number (at least 1)." };
  const n = BigInt(qty);
  if (n > 100000n) return { error: "That’s more than 100,000 at once. Check the number." };
  const unitCost = normalizeAmount(d.unitCost);
  if (!unitCost) return { error: "Enter the cost of one, in dollars and cents, like 2.50." };
  const valueCents = n * (dollarsToCents(unitCost) ?? 0n);
  const lines: DocLine[] = [{ values: [{ name: "stockItem", value: d.item }, { name: "qty", value: qty }, { name: "unitCost", value: unitCost }] }];
  if (kind === "add") {
    if (!PAID_FROM.some((p) => p.code === d.paidFrom)) return { error: "Say how you paid for it." };
    return { docType: STOCK_ADDED, fields: [{ name: "supplier", value: d.supplier.trim().slice(0, 200) }, { name: "paidFrom", value: d.paidFrom }], lines, valueCents };
  }
  if (onHand !== undefined && n > onHand) return { error: `You only have ${onHand} on the books, so you can’t take out ${n}.` };
  const reason = d.reason.trim();
  if (!reason) return { error: "Say why it’s being taken out." };
  return { docType: STOCK_REMOVED, fields: [{ name: "reason", value: reason.slice(0, 200) }], lines, valueCents };
}
