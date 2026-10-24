// Small deterministic helpers for the phone line. No floats in money paths.

import crypto from "node:crypto";
import { ORDER_ID_RE } from "../payments/ids";

/**
 * Normalize a phone number to E.164, or undefined when it is not one.
 * Accepts "+<country><number>" with common formatting (spaces, dashes, dots, parentheses).
 * Bare 10-digit numbers and 11-digit numbers starting with 1 are read as North American (+1): Cartesia
 * numbers are US-only (docs: line/integrations/telephony/cartesia-numbers). Anything else is rejected.
 */
export function normalizeE164(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const s = raw.trim().replace(/[\s\-().]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(s)) return s;
  if (/^1\d{10}$/.test(s)) return `+${s}`;
  if (/^[2-9]\d{9}$/.test(s)) return `+1${s}`;
  return undefined;
}

/** "+14155550123" -> "…0123" (for logs and the owner inbox; never the full number of a customer). */
export function maskPhone(e164: string | undefined): string {
  if (!e164) return "unknown";
  return `…${e164.slice(-4)}`;
}

/** Integer cents -> "$6.00" (bigint arithmetic only). */
export function formatCents(cents: bigint): string {
  const neg = cents < 0n;
  const a = neg ? -cents : cents;
  const dollars = a / 100n;
  const rest = (a % 100n).toString().padStart(2, "0");
  return `${neg ? "-" : ""}$${dollars.toString()}.${rest}`;
}

/**
 * Spoken order ids: "mc 7k2q9", "MC-7K2Q9", "M C dash 7 K 2 Q 9" (as typed by the model) -> "MC-7K2Q9".
 * Crockford look-alikes in the code part are mapped (O->0, I/L->1). Returns undefined if it is not an order id.
 */
export function normalizeOrderId(raw: string): string | undefined {
  const s = raw.toUpperCase().replace(/\bDASH\b/g, "-").replace(/[\s_]/g, "");
  const m = /^([A-Z]{1,4})-?([0-9A-Z]{5})$/.exec(s);
  if (!m) return undefined;
  const code = m[2]!.replace(/O/g, "0").replace(/[IL]/g, "1");
  const id = `${m[1]}-${code}`;
  return ORDER_ID_RE.test(id) ? id : undefined;
}

/** Constant-time string comparison (hash first so lengths are equal and do not leak). */
export function constantTimeEqual(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** Spoken PIN as passed by the model ("2468", "2 4 6 8", "24-68") -> digits only; anything else is kept as is (and fails). */
export function normalizePin(raw: string): string {
  const s = raw.trim();
  return /^[\d\s\-.]+$/.test(s) ? s.replace(/[\s\-.]/g, "") : s;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** "YYYY-MM-DD" of `ms` in an IANA time zone; falls back to UTC for an unknown zone. */
export function localDay(ms: number, timeZone: string): { day: string; timeZone: string } {
  try {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
    return { day, timeZone };
  } catch {
    return { day: new Date(ms).toISOString().slice(0, 10), timeZone: "UTC" };
  }
}
