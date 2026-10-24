import { Rational } from "@napkin/ledger-core";

/** Exact decimal string ("3.00") -> integer cents, or null if it is not a whole number of cents. */
export function decimalToCents(text: string | undefined): bigint | null {
  if (!text) return null;
  try {
    return Rational.parse(text.trim()).toCents();
  } catch {
    return null;
  }
}

/** Integer cents -> "$3.00" (display only; no floating point). */
export function formatCents(cents: bigint | number, currency = "USD"): string {
  const c = BigInt(cents);
  const neg = c < 0n;
  const abs = neg ? -c : c;
  const whole = (abs / 100n).toLocaleString("en-US");
  const frac = (abs % 100n).toString().padStart(2, "0");
  const symbol = currency === "USD" ? "$" : `${currency} `;
  return `${neg ? "-" : ""}${symbol}${whole}.${frac}`;
}

/** "$1" for whole dollars, "$1.50" otherwise: for compact "+$1" add-on badges. */
export function formatCentsShort(cents: bigint, currency = "USD"): string {
  const full = formatCents(cents, currency);
  return cents % 100n === 0n ? full.replace(/\.00$/, "") : full;
}
