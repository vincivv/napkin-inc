// Deterministic helpers for payment identifiers and money conversion. No floats anywhere.

import crypto from "node:crypto";
import { Rational } from "@napkin/ledger-core";

/** Crockford base32 (no I, L, O, U): easy to read aloud on the phone line. */
export const ORDER_ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ORDER_ID_RE = /^[A-Z]{1,4}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** Prefix from the business slug: "maya-cookies" -> "MC". */
export function orderPrefix(businessId: string): string {
  const p = businessId
    .split("-")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .replace(/[^A-Z]/g, "");
  return p || "NP";
}

/** "MC-7K2Q9": prefix + 5 base32 chars from the CSPRNG (32 divides 256, so `byte & 31` is unbiased). */
export function newOrderId(businessId: string, random: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = random(5);
  let s = "";
  for (let i = 0; i < 5; i++) s += ORDER_ID_ALPHABET[bytes[i]! & 31];
  return `${orderPrefix(businessId)}-${s}`;
}

/** Stripe idempotency key for an order's checkout session. Generation 0 is the one logged with the platform. */
export function checkoutIdempotencyKey(orderId: string, generation = 0): string {
  return generation === 0 ? `napkin-checkout-${orderId}` : `napkin-checkout-${orderId}-g${generation}`;
}

/** Exact decimal dollars ("3.00") -> integer cents. Throws on fractional cents or junk. */
export function decimalToCents(value: string): bigint {
  return Rational.parse(value).toCents();
}

/** Strict positive integer from a decimal string ("2" or "2.0"), for quantities. */
export function parseQty(value: string): bigint {
  const r = Rational.parse(value);
  if (!r.isInteger()) throw new RangeError(`quantity is not a whole number: ${value}`);
  return r.floor();
}

/**
 * DEV SIMULATOR ONLY: Stripe's US card list price, round(2.9% x amount) + 30 cents, half-up, in integer cents.
 * Real test-mode fees always come from the balance transaction, never from this formula.
 */
export function simulatedFeeCents(amountCents: bigint): bigint {
  if (amountCents <= 0n) return 0n;
  return (amountCents * 29n + 500n) / 1000n + 30n;
}

export const feeEventId = (balanceTransactionId: string) => `fee:${balanceTransactionId}`;
export const refundEventId = (refundId: string) => `refund:${refundId}`;

export const SIM = {
  eventId: (orderId: string) => `sim_evt_${orderId}`,
  paymentIntentId: (orderId: string) => `sim_pi_${orderId}`,
  balanceTransactionId: (orderId: string) => `sim_bt_${orderId}`,
  sessionId: (orderId: string) => `sim_cs_${orderId}`,
  refundId: (outboxId: bigint | string) => `sim_re_${outboxId}`,
  orderIdFromPaymentIntent: (pi: string) => (pi.startsWith("sim_pi_") ? pi.slice("sim_pi_".length) : undefined),
};
