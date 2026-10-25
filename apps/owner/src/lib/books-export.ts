// Sales tax by period and CSV exports for an accountant. Pure functions over subscribed rows (integer cents);
// downloadCsv is the one browser-only helper. Napkin reports what the books say; it does not file or pay tax.

import { Rational, type TrialBalanceRow } from "@napkin/ledger-core";
import type { DocumentRow, JournalLineRow } from "@/data/types";
import type { Names } from "./config";
import { cmpBig, dayIn, fieldMap } from "./reports";

export const SALES_TAX_ACCOUNT = "2100";
const REVENUE = "4000";
const DISCOUNTS = "4100";
const REFUNDS = "4200";

export type TaxPeriodKind = "month" | "quarter";

export interface TaxPeriod {
  period: string; // "2026-10" or "2026-Q4"
  /** sales before tax, after discounts (4000 credits - 4100 debits on posted documents) */
  salesCents: bigint;
  /** the tax part of refunds, worked out from each refunded sale's own tax share */
  refundedSalesCents: bigint;
  taxableSalesCents: bigint;
  /** credits to 2100 (tax charged on sales) */
  taxCollectedCents: bigint;
  /** tax handed back with refunds (refunds book to 4200 in full, so 2100 alone overstates what is owed) */
  taxRefundedCents: bigint;
  /** debits to 2100 that are not refunds: tax already paid to the state */
  taxPaidCents: bigint;
  netTaxDueCents: bigint;
}

export function periodOf(micros: bigint, timeZone: string, kind: TaxPeriodKind): string {
  const day = dayIn(micros, timeZone); // YYYY-MM-DD
  if (kind === "month") return day.slice(0, 7);
  return `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
}

/** The tax share of a refund's sale: (saleTotal - saleNet) / saleTotal, from the refund (or the refund it reverses). */
function refundTaxShare(d: DocumentRow | undefined, docs: ReadonlyMap<bigint, DocumentRow>): Rational {
  const src = d && d.reversalOf !== 0n ? (docs.get(d.reversalOf) ?? d) : d;
  if (!src) return Rational.ZERO;
  const f = fieldMap(src.fields);
  try {
    const total = Rational.parse(f["saleTotal"] ?? "0");
    const net = Rational.parse(f["saleNet"] ?? "0");
    if (total.isZero() || net.ge(total)) return Rational.ZERO;
    return total.sub(net).div(total);
  } catch {
    return Rational.ZERO;
  }
}

/** Sales tax by period in the business's time zone, newest first. */
export function salesTaxByPeriod(lines: readonly JournalLineRow[], docs: ReadonlyMap<bigint, DocumentRow>, timeZone: string, kind: TaxPeriodKind): TaxPeriod[] {
  const m = new Map<string, TaxPeriod>();
  const get = (p: string) => {
    let r = m.get(p);
    if (!r) m.set(p, (r = { period: p, salesCents: 0n, refundedSalesCents: 0n, taxableSalesCents: 0n, taxCollectedCents: 0n, taxRefundedCents: 0n, taxPaidCents: 0n, netTaxDueCents: 0n }));
    return r;
  };
  for (const l of lines) {
    const code = l.accountCode;
    if (code !== REVENUE && code !== DISCOUNTS && code !== REFUNDS && code !== SALES_TAX_ACCOUNT) continue;
    const r = get(periodOf(l.postedAt.microsSinceUnixEpoch, timeZone, kind));
    if (code === REVENUE || code === DISCOUNTS) r.salesCents += l.creditCents - l.debitCents;
    else if (code === SALES_TAX_ACCOUNT) {
      // credits are tax charged; a reversed sale's debit takes its tax back out of "collected"
      const d = docs.get(l.documentId);
      if (d?.docType === "sale" || (d && docs.get(d.reversalOf)?.docType === "sale")) r.taxCollectedCents += l.creditCents - l.debitCents;
      else if (d?.docType === "refund" || (d && docs.get(d.reversalOf)?.docType === "refund")) r.taxRefundedCents += l.debitCents - l.creditCents;
      else {
        r.taxCollectedCents += l.creditCents;
        r.taxPaidCents += l.debitCents;
      }
    } else {
      // a refund: split what went back to the customer into its sale part and its tax part
      const amount = l.debitCents - l.creditCents;
      const tax = Rational.fromCents(amount).mul(refundTaxShare(docs.get(l.documentId), docs)).round2().toCents();
      r.taxRefundedCents += tax;
      r.refundedSalesCents += amount - tax;
    }
  }
  for (const r of m.values()) {
    r.taxableSalesCents = r.salesCents - r.refundedSalesCents;
    r.netTaxDueCents = r.taxCollectedCents - r.taxRefundedCents - r.taxPaidCents;
  }
  return [...m.values()].sort((a, b) => b.period.localeCompare(a.period));
}

// ---- CSV ----

/** Plain decimal dollars ("-12.50"): what spreadsheets and accounting imports expect. */
export function centsCsv(cents: bigint): string {
  const neg = cents < 0n;
  const s = (neg ? -cents : cents).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${s.slice(0, -2)}.${s.slice(-2)}`;
}

function cell(v: string | number | bigint): string {
  const s = String(v);
  // quote anything with a separator, and defuse spreadsheet formulas
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly (readonly (string | number | bigint)[])[]): string {
  return rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsv(filename: string, rows: readonly (readonly (string | number | bigint)[])[]): void {
  const blob = new Blob(["﻿" + toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Asset / Liability / Equity / Income / Expense from the account number's first digit. */
export function accountClass(code: string): string {
  return { "1": "Asset", "2": "Liability", "3": "Equity", "4": "Income" }[code[0] ?? ""] ?? "Expense";
}

/** Every posted journal line, oldest first: one row per line, documents grouped by their number. */
export function journalRows(lines: readonly JournalLineRow[], docs: ReadonlyMap<bigint, DocumentRow>, names: Names, timeZone: string): string[][] {
  const sorted = lines.slice().sort((a, b) => cmpBig(a.postedAt.microsSinceUnixEpoch, b.postedAt.microsSinceUnixEpoch) || cmpBig(a.documentId, b.documentId) || cmpBig(a.id, b.id));
  const out = [["Date", "Document", "Document type", "Number", "Reference", "Account", "Account name", "Account type", "Debit", "Credit", "Memo", "Reverses"]];
  for (const l of sorted) {
    const d = docs.get(l.documentId);
    const reverses = d && d.reversalOf !== 0n ? docs.get(d.reversalOf) : undefined;
    out.push([
      dayIn(l.postedAt.microsSinceUnixEpoch, timeZone),
      String(l.documentId),
      d ? names.docType(d.docType) : "",
      d ? String(d.number) : "",
      d?.externalRef ?? "",
      l.accountCode,
      names.account(l.accountCode),
      accountClass(l.accountCode),
      centsCsv(l.debitCents),
      centsCsv(l.creditCents),
      l.memo,
      reverses ? `${names.docType(reverses.docType)} #${reverses.number}` : "",
    ]);
  }
  return out;
}

export function trialBalanceRows(rows: readonly TrialBalanceRow[], names: Names): string[][] {
  const out = [["Account", "Account name", "Account type", "Debits", "Credits", "Balance (Dr - Cr)"]];
  let d = 0n;
  let c = 0n;
  for (const r of rows) {
    d += r.debitCents;
    c += r.creditCents;
    out.push([r.account, names.account(r.account), accountClass(r.account), centsCsv(r.debitCents), centsCsv(r.creditCents), centsCsv(r.balanceCents)]);
  }
  out.push(["", "Total", "", centsCsv(d), centsCsv(c), centsCsv(d - c)]);
  return out;
}

export function salesTaxRows(periods: readonly TaxPeriod[], taxRate: string): string[][] {
  return [
    ["Period", "Sales after discounts", "Refunded sales", "Taxable sales", "Tax collected", "Tax refunded", "Tax already paid", "Tax due", "Rate in settings"],
    ...periods.map((p) => [p.period, centsCsv(p.salesCents), centsCsv(p.refundedSalesCents), centsCsv(p.taxableSalesCents), centsCsv(p.taxCollectedCents), centsCsv(p.taxRefundedCents), centsCsv(p.taxPaidCents), centsCsv(p.netTaxDueCents), taxRate]),
  ];
}
