// Turn text (an owner's answer, an LLM-extracted value) into the exact typed value a Fact at `path` holds.
// Strict on purpose: if the text is ambiguous we throw CoerceError and ask again instead of guessing.

import { normalizePath } from "./paths";

export class CoerceError extends Error {
  override name = "CoerceError";
}

export type ValueKind = "money" | "pct" | "points" | "hours" | "qty" | "int" | "bool" | "fulfillment" | "currency" | "methods" | "list" | "text";

const KINDS: Record<string, ValueKind> = {
  "offerings.*.variants.*.price": "money",
  "offerings.*.variants.*.cost": "money",
  "offerings.*.addOns.*.price": "money",
  "offerings.*.addOns.*.cost": "money",
  "offerings.*.variants.*.stockUnits": "qty",
  "offerings.*.initialStock": "int",
  "offerings.*.stockTracked": "bool",
  "policies.taxRate": "pct",
  // *Pct fields hold percent points ("20" = 20%), as the compiler reads them; taxRate is a fraction ("0.08875").
  "policies.marginFloorPct": "points",
  "policies.maxDiscountPct": "points",
  "policies.refundWindowHours": "hours",
  "policies.couponsAllowed": "bool",
  "policies.currency": "currency",
  "policies.paymentMethods": "methods",
  "operations.fulfillment": "fulfillment",
  "operations.suppliers.*.items": "list",
};

export function kindOf(path: string): ValueKind {
  return KINDS[normalizePath(path)] ?? "text";
}

/** "003.5000" -> "3.50": strips leading zeros, pads to `minDp` decimals, drops trailing zeros beyond that. */
export function normDecimal(s: string, minDp = 0): string {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new CoerceError(`"${s}" is not a number`);
  const int = (m[2] || "0").replace(/^0+(?=\d)/, "");
  let frac = m[3] ?? "";
  while (frac.length > minDp && frac.endsWith("0")) frac = frac.slice(0, -1);
  while (frac.length < minDp) frac += "0";
  return `${m[1]}${int}${frac ? "." + frac : ""}`;
}

/** Exact decimal shift by `places` digits (negative = divide by 10^n). No floats. */
export function shiftDecimal(s: string, places: number): string {
  const [i, f = ""] = normDecimal(s).split(".");
  let digits = i! + f;
  let point = i!.length + places;
  if (point <= 0) {
    digits = "0".repeat(1 - point) + digits;
    point = 1;
  }
  if (point > digits.length) digits += "0".repeat(point - digits.length);
  return normDecimal(`${digits.slice(0, point)}.${digits.slice(point)}`);
}

export function decimalEquals(a: string, b: string): boolean {
  try {
    return normDecimal(a) === normDecimal(b);
  } catch {
    return false;
  }
}

const NUM = /-?\d+(?:,\d{3})*(?:\.\d+)?|-?\.\d+/;

function firstNumber(text: string): string {
  const m = NUM.exec(text.replace(/\$/g, " "));
  if (!m) throw new CoerceError(`no number found in "${text}"`);
  return m[0].replace(/,/g, "");
}

function parseBool(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^(y|yes|yep|yeah|true|on|allowed|ok|okay|sure|correct|right)\b/.test(t)) return true;
  if (/^(n|no|nope|false|off|never|not allowed|none|disallow|don'?t)\b/.test(t)) return false;
  throw new CoerceError(`please answer yes or no (got "${text}")`);
}

export function coerceValue(path: string, current: unknown, text: string): unknown {
  const raw = text.trim();
  if (raw === "") throw new CoerceError("empty answer");
  const kind = kindOf(path);
  switch (kind) {
    case "money": {
      const n = firstNumber(raw);
      if (n.startsWith("-")) throw new CoerceError("money cannot be negative");
      return normDecimal(n, 2);
    }
    case "qty": {
      const n = firstNumber(raw);
      if (n.startsWith("-")) throw new CoerceError("quantity cannot be negative");
      // stock units per sale must be whole (the compiler and ledger count whole units)
      if (!/^\d+$/.test(n) || Number(n) < 1) throw new CoerceError(`"${raw}" is not a whole number of at least 1`);
      return normDecimal(n);
    }
    case "pct": {
      const n = firstNumber(raw);
      if (n.startsWith("-")) throw new CoerceError("a rate cannot be negative");
      const explicit = /%|percent|pct/i.test(raw);
      // "20%" / "20 percent" / bare 20 -> 0.20 ; bare 0.2 or 1 or 0 -> as given (a fraction).
      const asFraction = explicit || Number(n) > 1 ? shiftDecimal(n, -2) : normDecimal(n);
      if (Number(asFraction) > 1) throw new CoerceError("a rate above 100% is not allowed");
      return normDecimal(asFraction, 2);
    }
    case "points": {
      const n = firstNumber(raw);
      if (n.startsWith("-")) throw new CoerceError("a percentage cannot be negative");
      // "20%" / "20 percent" / bare 20 -> "20". A bare value between 0 and 1 ("0.2") could be 0.2% or 20%:
      // ask instead of guessing (the compiler refuses it too).
      const explicit = /%|percent|pct/i.test(raw);
      if (!explicit && Number(n) > 0 && Number(n) < 1) throw new CoerceError(`is that ${n}% or ${shiftDecimal(n, 2)}%? Please answer with a % sign`);
      if (Number(n) > 100) throw new CoerceError("a percentage above 100% is not allowed");
      return normDecimal(n);
    }
    case "hours": {
      const n = firstNumber(raw);
      if (n.startsWith("-")) throw new CoerceError("hours cannot be negative");
      if (/\bdays?\b/i.test(raw)) return normDecimal(String(Number(n) * 24));
      if (/\bweeks?\b/i.test(raw)) return normDecimal(String(Number(n) * 168));
      return normDecimal(n);
    }
    case "int": {
      const n = firstNumber(raw);
      if (!/^\d+$/.test(n)) throw new CoerceError(`"${raw}" is not a whole number`);
      return Number(n);
    }
    case "bool":
      return parseBool(raw);
    case "fulfillment": {
      if (/pick\s*-?up|collect/i.test(raw)) return "pickup";
      if (/deliver/i.test(raw)) return "delivery";
      throw new CoerceError('fulfillment must be "pickup" or "delivery"');
    }
    case "currency":
      if (/^(usd|\$|us dollars?|dollars?)$/i.test(raw)) return "USD";
      throw new CoerceError("only USD is supported");
    case "methods":
      if (/card/i.test(raw)) return ["card"];
      throw new CoerceError('only "card" payments are supported');
    case "list":
      return raw.split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
    case "text":
      if (typeof current === "boolean") return parseBool(raw);
      return raw;
  }
}

/** Display form of a fact value (for questions, candidates and diffs). */
export function showValue(path: string, v: unknown): string {
  const kind = kindOf(path);
  if (typeof v === "boolean") return v ? "yes" : "no";
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "string") {
    if (kind === "money") return `$${v}`;
    if (kind === "pct") return `${shiftDecimal(v, 2)}%`;
    if (kind === "points") return `${v}%`;
    if (kind === "hours") return `${v} hours`;
  }
  return String(v);
}

/** Canonical comparison key so "3" == "3.00" and "Sea Salt" == "sea  salt". */
export function valueKey(path: string, v: unknown): string {
  const kind = kindOf(path);
  if (typeof v === "string" && (kind === "money" || kind === "pct" || kind === "points" || kind === "hours" || kind === "qty")) {
    try {
      return normDecimal(v);
    } catch {
      return v;
    }
  }
  if (typeof v === "string") return v.trim().toLowerCase().replace(/\s+/g, " ");
  return JSON.stringify(v);
}
