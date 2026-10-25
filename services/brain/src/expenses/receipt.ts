// Receipt reading: a photo of a receipt -> a PRE-FILL for the owner's expense form. The model only reads;
// deterministic code cleans what it read (exact decimals, ISO dates, a known category) and drops anything
// it cannot validate, so an unreadable value stays empty for the owner to fill. Nothing here posts to the
// books: the owner checks the values and saves the expense, which the platform posts (createDocument).

import { Rational } from "@napkin/ledger-core";
import { z, ZodError } from "zod";
import { EXPENSE_CATEGORIES, type ExpenseCategory } from "../compiler/templates/item_seller";
import { MODELS, type Llm } from "../llm";
import { normDecimal } from "../spec/coerce";

export type ReceiptMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

const CATEGORY_IDS = EXPENSE_CATEGORIES.map((c) => c.category) as [ExpenseCategory, ...ExpenseCategory[]];

export const RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: "string", description: "the business that issued the receipt, exactly as printed; omit if not visible" },
    date: { type: "string", description: "purchase date as YYYY-MM-DD; omit if not printed or not fully legible" },
    total: { type: "string", description: "the amount actually paid (grand total incl. tax), digits only like 42.17; omit if not legible" },
    tax: { type: "string", description: "tax amount if printed, digits only; omit otherwise" },
    currency: { type: "string", description: "ISO currency code if shown (USD, EUR...); omit otherwise" },
    category: {
      type: "string",
      enum: CATEGORY_IDS,
      description: `best-fitting expense category: ${EXPENSE_CATEGORIES.map((c) => `${c.category} (${c.name})`).join(", ")}. Omit if unsure.`,
    },
    items: {
      type: "array",
      description: "line items as printed (at most 30)",
      items: {
        type: "object",
        properties: { description: { type: "string" }, amount: { type: "string", description: "digits only; omit if not legible" } },
        required: ["description"],
      },
    },
    notes: { type: "string", description: "anything illegible, ambiguous or unusual (e.g. torn, faded, handwritten amounts)" },
    confidence: { type: "number", description: "0..1, how sure you are of vendor, date and total overall" },
  },
  required: ["confidence"],
} as const;

const Raw = z.object({
  vendor: z.string().optional(),
  date: z.string().optional(),
  total: z.string().optional(),
  tax: z.string().optional(),
  currency: z.string().optional(),
  category: z.string().optional(),
  items: z.array(z.object({ description: z.string(), amount: z.string().optional() })).optional(),
  notes: z.string().optional(),
  confidence: z.number(),
});

/** What the owner's form is pre-filled with. "" means "not read": the owner fills it in. */
export interface ReceiptRead {
  vendor: string;
  date: string;
  total: string;
  tax: string;
  currency: string;
  /** a template category id, or "" when the model was unsure */
  category: ExpenseCategory | "";
  /** the suggested category's expense account code (what the expense line's `account` holds), or "" */
  account: string;
  items: { description: string; amount: string }[];
  notes: string;
  confidence: number;
  /** true/false when every item has an amount and a total was read; null otherwise */
  itemsMatchTotal: boolean | null;
  /** values the model returned that failed validation and were dropped (shown to the owner) */
  dropped: string[];
}

const SYSTEM = `You read a photo of a purchase receipt or bill for a small business owner who is recording an expense.
Rules (never assume):
- Only record what is printed on the receipt. If a value is missing, cut off or not clearly legible, OMIT it. Never estimate or compute a total.
- Money values are digits with an optional decimal point (42.17): no currency symbols, no thousands separators.
- The date is YYYY-MM-DD. If the year or day is ambiguous, omit the date and say why in notes.
- category is only a suggestion for the owner; omit it if no category clearly fits.
- If the image is not a receipt or bill, omit everything and say so in notes with confidence 0.`;

/** "$1,234.50" -> "1234.50". Exact decimal text, at most 2 decimals; undefined when it is not a clean amount. */
export function cleanMoney(s: string | undefined, allowNegative = false): string | undefined {
  if (s === undefined) return undefined;
  let t = s.trim().replace(/^\$\s*/, "").replace(/\s*(usd|\$)$/i, "");
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t) && !/^-?\.\d+$/.test(t)) return undefined;
  if (t.startsWith("-") && !allowNegative) return undefined;
  const n = normDecimal(t, 2);
  if ((n.split(".")[1] ?? "").length > 2) return undefined;
  return n;
}

/** A real calendar date in YYYY-MM-DD, else undefined. */
export function cleanDate(s: string | undefined): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s?.trim() ?? "");
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? m[0] : undefined;
}

const clip = (s: string | undefined, n: number) => (s ?? "").trim().slice(0, n);

/** Deterministic cleanup of the model's raw output. Exported for tests. */
export function cleanReceipt(raw: z.infer<typeof Raw>): ReceiptRead {
  const dropped: string[] = [];
  const money = (label: string, v: string | undefined, allowNegative = false) => {
    if (v === undefined || v.trim() === "") return "";
    const c = cleanMoney(v, allowNegative);
    if (c === undefined) {
      dropped.push(`${label} "${v.slice(0, 40)}" is not a clean amount`);
      return "";
    }
    return c;
  };
  let total = money("total", raw.total);
  if (total && !Rational.parse(total).gt(Rational.ZERO)) {
    dropped.push(`total ${total} is not positive`);
    total = "";
  }
  let date = "";
  if (raw.date !== undefined && raw.date.trim() !== "") {
    date = cleanDate(raw.date) ?? "";
    if (!date) dropped.push(`date "${raw.date.slice(0, 40)}" is not a YYYY-MM-DD calendar date`);
  }
  let category: ReceiptRead["category"] = "";
  if (raw.category) {
    if ((CATEGORY_IDS as string[]).includes(raw.category)) category = raw.category as ExpenseCategory;
    else dropped.push(`category "${raw.category.slice(0, 40)}" is not one of ${CATEGORY_IDS.join(", ")}`);
  }
  const items = (raw.items ?? []).slice(0, 30).map((it, i) => ({ description: clip(it.description, 200), amount: money(`item ${i + 1}`, it.amount, true) }));
  let itemsMatchTotal: boolean | null = null;
  if (total && items.length > 0 && items.every((it) => it.amount !== "")) {
    const sum = items.reduce((a, it) => a.add(Rational.parse(it.amount)), Rational.ZERO);
    const tax = raw.tax ? cleanMoney(raw.tax) : undefined;
    const t = Rational.parse(total);
    itemsMatchTotal = sum.eq(t) || (tax !== undefined && sum.add(Rational.parse(tax)).eq(t));
  }
  const currency = clip(raw.currency, 8).toUpperCase();
  return {
    vendor: clip(raw.vendor, 200),
    date,
    total,
    tax: money("tax", raw.tax),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : "",
    category,
    account: EXPENSE_CATEGORIES.find((c) => c.category === category)?.code ?? "",
    items,
    notes: clip(raw.notes, 1000),
    confidence: Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0,
    itemsMatchTotal,
    dropped,
  };
}

export class ReceiptUnreadable extends Error {
  override name = "ReceiptUnreadable";
}

/** Read one receipt image (one retry on invalid output). Throws ReceiptUnreadable after two invalid outputs. */
export async function readReceipt(llm: Llm, img: { base64: string; mediaType: ReceiptMediaType }): Promise<ReceiptRead> {
  let feedback = "";
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await llm.tool({
      model: MODELS.opus,
      system: SYSTEM,
      content: [
        { type: "image", mediaType: img.mediaType, base64: img.base64 },
        { type: "text", text: `Read this receipt.${feedback}` },
      ],
      toolName: "record_receipt",
      toolDescription: "Record what the receipt shows.",
      schema: RECEIPT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
    });
    try {
      return cleanReceipt(Raw.parse(out));
    } catch (e) {
      if (!(e instanceof ZodError)) throw e;
      last = e;
      feedback = `\n\nYour previous output was invalid: ${e.message.slice(0, 400)}. Call the tool again with valid output.`;
    }
  }
  throw new ReceiptUnreadable(`the model's receipt output was invalid twice: ${(last as Error).message.slice(0, 200)}`);
}
