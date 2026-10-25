// Owner expenses: read the "expense" document type from the ACTIVE configuration (categories = the accounts its
// debit rules post to, paying sides = its credit rules) and turn posted expense documents into list rows.
// Convention (services/brain/src/compiler/templates/item_seller.ts): line.account holds the expense account
// code and doc.paidFrom the paying account code. Integer cents throughout.

import type { Configuration } from "@napkin/schema";
import type { DocLine, DocumentRow, FieldValue } from "@/data/types";
import { parseDollars } from "./money";
import { cmpBig, fieldMap } from "./reports";

export const EXPENSE_DOC = "expense";

export interface ExpenseSetup {
  categories: { code: string; name: string }[];
  paidFrom: { code: string; name: string }[];
}

/** undefined when the business was compiled before expenses existed (the owner recompiles on the Build page). */
export function expenseSetup(config: Configuration | undefined): ExpenseSetup | undefined {
  const d = config?.documents.find((x) => x.id === EXPENSE_DOC);
  if (!config || !d) return undefined;
  const name = (code: string) => config.chartOfAccounts.find((a) => a.code === code)?.name ?? `Account ${code}`;
  const codes = (side: "debit" | "credit") => [...new Set(d.postingRules.flatMap((r) => (r.target.kind === "account" && r.side === side ? [r.target.code] : [])))];
  return { categories: codes("debit").map((code) => ({ code, name: name(code) })), paidFrom: codes("credit").map((code) => ({ code, name: name(code) })) };
}

export interface ExpenseLine {
  account: string;
  amountCents: bigint;
  description: string;
}
export interface ExpenseRow {
  doc: DocumentRow;
  date: string;
  vendor: string;
  paidFrom: string;
  receiptRef: string;
  lines: ExpenseLine[];
  totalCents: bigint;
  /** reversed expenses stay listed (struck through) but count nowhere */
  reversed: boolean;
}

function cents(text: string | undefined): bigint {
  try {
    return parseDollars(text ?? "0");
  } catch {
    return 0n;
  }
}

/** Posted (and reversed) expense documents, newest date first. Reversal documents themselves are not listed. */
export function expenseRows(docs: readonly DocumentRow[]): ExpenseRow[] {
  return docs
    .filter((d) => d.docType === EXPENSE_DOC && d.reversalOf === 0n && (d.status === "posted" || d.status === "reversed"))
    .map((doc) => {
      const f = fieldMap(doc.fields);
      const lines = doc.lines.map((l) => {
        const v = fieldMap(l.values);
        return { account: v["account"] ?? "", amountCents: cents(v["amount"]), description: v["description"] ?? "" };
      });
      return { doc, date: f["date"] ?? "", vendor: f["vendor"] ?? "", paidFrom: f["paidFrom"] ?? "", receiptRef: f["receiptRef"] ?? "", lines, totalCents: doc.totalCents, reversed: doc.status === "reversed" };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || cmpBig(b.doc.id, a.doc.id));
}

/** Total per expense account over the rows that count (not reversed), largest first. */
export function totalsByCategory(rows: readonly ExpenseRow[]): { account: string; cents: bigint }[] {
  const m = new Map<string, bigint>();
  for (const r of rows) if (!r.reversed) for (const l of r.lines) m.set(l.account, (m.get(l.account) ?? 0n) + l.amountCents);
  return [...m].map(([account, c]) => ({ account, cents: c })).sort((a, b) => cmpBig(b.cents, a.cents));
}

/** "$1,234.5" / "1234.50" -> "1234.50"; undefined when it is not an exact amount with at most 2 decimals. */
export function normalizeAmount(text: string): string | undefined {
  let t = text.trim().replace(/^\$\s*/, "");
  if (/^\d{1,3}(,\d{3})+(\.\d*)?$/.test(t)) t = t.replace(/,/g, "");
  const m = /^(\d+)(?:\.(\d{0,2}))?$/.exec(t);
  if (!m) return undefined;
  const whole = m[1]!.replace(/^0+(?=\d)/, "");
  return `${whole}.${(m[2] ?? "").padEnd(2, "0")}`;
}

export interface ExpenseDraft {
  vendor: string;
  date: string;
  paidFrom: string;
  receiptRef: string;
  note: string;
  lines: { account: string; amount: string; description: string }[];
}

/** Validate a draft and build the createDocument payload. Returns an error message instead when something is off. */
export function buildExpense(d: ExpenseDraft, setup: ExpenseSetup): { fields: FieldValue[]; lines: DocLine[]; totalCents: bigint } | { error: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return { error: "Pick the date of the expense." };
  if (!setup.paidFrom.some((p) => p.code === d.paidFrom)) return { error: "Say whether it was paid now or is still owed." };
  if (d.lines.length === 0) return { error: "Add at least one amount." };
  const lines: DocLine[] = [];
  let totalCents = 0n;
  for (const [i, l] of d.lines.entries()) {
    const n = d.lines.length > 1 ? ` on line ${i + 1}` : "";
    if (!setup.categories.some((c) => c.code === l.account)) return { error: `Pick a category${n}.` };
    const amount = normalizeAmount(l.amount);
    if (!amount) return { error: `Enter the amount${n} as dollars and cents, like 42.17.` };
    const c = parseDollars(amount);
    if (c <= 0n) return { error: `The amount${n} must be more than zero.` };
    totalCents += c;
    lines.push({ values: [{ name: "account", value: l.account }, { name: "amount", value: amount }, { name: "description", value: l.description.trim().slice(0, 200) }] });
  }
  const fields: FieldValue[] = [
    { name: "vendor", value: d.vendor.trim().slice(0, 200) },
    { name: "date", value: d.date },
    { name: "paidFrom", value: d.paidFrom },
    { name: "receiptRef", value: d.receiptRef },
  ];
  return { fields, lines, totalCents };
}
