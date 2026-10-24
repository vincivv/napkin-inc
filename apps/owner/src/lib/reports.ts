// Pure report computations over subscribed rows. Integer cents (bigint) throughout.
// The trial balance itself comes from @napkin/ledger-core so the app and the platform agree.

import { Rational, trialBalance, type TrialBalanceRow } from "@napkin/ledger-core";
import type { CustomerOrderRow, DocumentRow, JournalLineRow, RegisterBalanceRow, RegisterMovementRow, FieldValue } from "@/data/types";
import { parseDims } from "./config";

export const ACCOUNTS = {
  bank: "1000",
  clearing: "1010",
  receivables: "1200",
  inventory: "1300",
  payables: "2000",
  revenue: "4000",
  discounts: "4100",
  refunds: "4200",
  cogs: "5000",
  fees: "5100",
} as const;

export function fieldMap(fields: readonly FieldValue[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) out[f.name] = f.value;
  return out;
}

export function tb(lines: readonly JournalLineRow[]): TrialBalanceRow[] {
  return trialBalance(lines.map((l) => ({ account: l.accountCode, debitCents: l.debitCents, creditCents: l.creditCents })));
}

/** debit - credit for one account. */
export function balanceOf(lines: readonly JournalLineRow[], code: string): bigint {
  let b = 0n;
  for (const l of lines) if (l.accountCode === code) b += l.debitCents - l.creditCents;
  return b;
}

export interface BooksCheck {
  debitCents: bigint;
  creditCents: bigint;
  balanced: boolean;
  lineCount: number;
  documentCount: number;
  /** documents whose own lines do not balance (should never exist) */
  unbalancedDocuments: { documentId: bigint; diffCents: bigint }[];
  /** journal lines with a negative side (should never exist) */
  negativeLines: number;
}

export function booksCheck(lines: readonly JournalLineRow[]): BooksCheck {
  let d = 0n;
  let c = 0n;
  let negativeLines = 0;
  const perDoc = new Map<bigint, bigint>();
  for (const l of lines) {
    d += l.debitCents;
    c += l.creditCents;
    if (l.debitCents < 0n || l.creditCents < 0n) negativeLines++;
    perDoc.set(l.documentId, (perDoc.get(l.documentId) ?? 0n) + l.debitCents - l.creditCents);
  }
  const unbalancedDocuments = [...perDoc].filter(([, diff]) => diff !== 0n).map(([documentId, diffCents]) => ({ documentId, diffCents }));
  return { debitCents: d, creditCents: c, balanced: d === c && unbalancedDocuments.length === 0 && negativeLines === 0, lineCount: lines.length, documentCount: perDoc.size, unbalancedDocuments, negativeLines };
}

export interface Pnl {
  revenueCents: bigint; // 4000 credit balance
  discountsCents: bigint; // 4100 debit balance
  refundsCents: bigint; // 4200 debit balance
  netRevenueCents: bigint;
  cogsCents: bigint; // 5000
  grossProfitCents: bigint;
  feesCents: bigint; // 5100
  netIncomeCents: bigint;
}

export function pnl(lines: readonly JournalLineRow[]): Pnl {
  const revenueCents = -balanceOf(lines, ACCOUNTS.revenue);
  const discountsCents = balanceOf(lines, ACCOUNTS.discounts);
  const refundsCents = balanceOf(lines, ACCOUNTS.refunds);
  const netRevenueCents = revenueCents - discountsCents - refundsCents;
  const cogsCents = balanceOf(lines, ACCOUNTS.cogs);
  const grossProfitCents = netRevenueCents - cogsCents;
  const feesCents = balanceOf(lines, ACCOUNTS.fees);
  return { revenueCents, discountsCents, refundsCents, netRevenueCents, cogsCents, grossProfitCents, feesCents, netIncomeCents: grossProfitCents - feesCents };
}

/** Calendar day (YYYY-MM-DD) of a micros timestamp in an IANA time zone. */
export function dayIn(micros: bigint, timeZone: string): string {
  const d = new Date(Number(micros / 1000n));
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

export interface AccountMovement {
  id: bigint;
  documentId: bigint;
  accountCode: string;
  postedAtMicros: bigint;
  memo: string;
  inCents: bigint;
  outCents: bigint;
  runningCents: bigint;
}

/** Chronological movements on cash accounts with a running balance per account. */
export function cashFlow(lines: readonly JournalLineRow[], codes: readonly string[] = [ACCOUNTS.clearing, ACCOUNTS.bank]): AccountMovement[] {
  const sorted = lines
    .filter((l) => codes.includes(l.accountCode))
    .slice()
    .sort((a, b) => cmpBig(a.postedAt.microsSinceUnixEpoch, b.postedAt.microsSinceUnixEpoch) || cmpBig(a.id, b.id));
  const running = new Map<string, bigint>();
  return sorted.map((l) => {
    const r = (running.get(l.accountCode) ?? 0n) + l.debitCents - l.creditCents;
    running.set(l.accountCode, r);
    return { id: l.id, documentId: l.documentId, accountCode: l.accountCode, postedAtMicros: l.postedAt.microsSinceUnixEpoch, memo: l.memo, inCents: l.debitCents, outCents: l.creditCents, runningCents: r };
  });
}

export function cmpBig(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface OpenItem {
  key: string; // orderId or document number
  documentIds: bigint[];
  balanceCents: bigint;
  label: string;
}

/** Open balance on an account grouped by the documents' external reference (receivables by order). */
export function openByRef(lines: readonly JournalLineRow[], docs: ReadonlyMap<bigint, DocumentRow>, code: string, sign: 1n | -1n, labelFor: (d: DocumentRow | undefined) => string): OpenItem[] {
  const m = new Map<string, OpenItem>();
  for (const l of lines) {
    if (l.accountCode !== code) continue;
    const d = docs.get(l.documentId);
    const key = d?.externalRef || labelFor(d);
    const it = m.get(key) ?? { key, documentIds: [], balanceCents: 0n, label: labelFor(d) };
    if (!it.documentIds.includes(l.documentId)) it.documentIds.push(l.documentId);
    it.balanceCents += sign * (l.debitCents - l.creditCents);
    m.set(key, it);
  }
  return [...m.values()].filter((i) => i.balanceCents !== 0n).sort((a, b) => cmpBig(b.balanceCents, a.balanceCents));
}

export interface MarginRow {
  productId: string;
  qty: bigint;
  netSalesCents: bigint;
  costCents: bigint | null; // null if a line's cost is not a whole number of cents
  marginCents: bigint | null;
}

/** Margin by item: net sales and quantity from the sales register, cost from the posted sale documents' lines. */
export function marginByItem(movements: readonly RegisterMovementRow[], documents: readonly DocumentRow[], salesRegister = "sales", productDim = "product"): MarginRow[] {
  const m = new Map<string, MarginRow>();
  const get = (p: string) => {
    let r = m.get(p);
    if (!r) m.set(p, (r = { productId: p, qty: 0n, netSalesCents: 0n, costCents: 0n, marginCents: 0n }));
    return r;
  };
  for (const mv of movements) {
    if (mv.registerId !== salesRegister) continue;
    const p = parseDims(mv.dimsKey)[productDim] ?? mv.dimsKey;
    const r = get(p);
    const s = mv.kind === "out" ? -1n : 1n;
    r.qty += s * mv.qty;
    r.netSalesCents += s * mv.amountCents;
  }
  for (const d of documents) {
    if (d.docType !== "sale" || d.status !== "posted") continue;
    for (const line of d.lines) {
      const f = fieldMap(line.values);
      if (!f["productId"]) continue;
      const r = get(f["productId"]);
      if (r.costCents === null) continue;
      try {
        r.costCents += Rational.parse(f["qty"] ?? "0").mul(Rational.parse(f["unitCost"] ?? "0")).toCents();
      } catch {
        r.costCents = null;
      }
    }
  }
  for (const r of m.values()) r.marginCents = r.costCents === null ? null : r.netSalesCents - r.costCents;
  return [...m.values()].sort((a, b) => cmpBig(b.netSalesCents, a.netSalesCents));
}

export interface StockRow {
  key: string;
  item: string;
  qty: bigint;
  amountCents: bigint;
}

export function stockRows(balances: readonly RegisterBalanceRow[], register = "stock", dim = "item"): StockRow[] {
  return balances
    .filter((b) => b.registerId === register)
    .map((b) => ({ key: b.key, item: parseDims(b.dimsKey)[dim] ?? b.dimsKey, qty: b.qty, amountCents: b.amountCents }))
    .sort((a, b) => a.item.localeCompare(b.item));
}

export type StockLevel = "out" | "critical" | "low" | "ok";

/**
 * Display-only stock level (not a business rule): "critical" when the largest pack that uses this item
 * can no longer be filled, "low" below two of the largest pack.
 */
export function stockLevel(qty: bigint, largestPackUnits: bigint | undefined): StockLevel {
  if (qty <= 0n) return "out";
  if (!largestPackUnits || largestPackUnits <= 0n) return "ok";
  if (qty < largestPackUnits) return "critical";
  if (qty < 2n * largestPackUnits) return "low";
  return "ok";
}

export const ORDER_STATUSES = ["pending_payment", "paid", "ready", "picked_up", "refunded", "partially_refunded", "cancelled"] as const;

export function nextOrderAction(o: Pick<CustomerOrderRow, "status">): { status: "ready" | "picked_up"; label: string } | null {
  if (o.status === "paid") return { status: "ready", label: "Mark ready" };
  if (o.status === "ready") return { status: "picked_up", label: "Mark picked up" };
  return null;
}
