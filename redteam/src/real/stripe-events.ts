// Stripe-shaped webhook events and Stripe-Signature headers, built locally. No Stripe account or key is
// involved: the signature is the documented scheme (HMAC-SHA256 over "<t>.<raw body>" with the endpoint
// secret, header "t=<unix>,v1=<hex>"), and the brain verifies it with the real Stripe library
// (verifyStripeEvent). The secret is generated per run and never leaves the process.

import { createHmac, randomBytes } from "node:crypto";
import type { z } from "zod";
import type { WebhookEvent } from "../types";

type ChaosEvent = z.infer<typeof WebhookEvent>;

export const newWebhookSecret = (): string => `whsec_redteam_${randomBytes(18).toString("hex")}`;

/** Stripe-Signature header for `rawBody` signed with `secret` at unix time `t`. */
export function stripeSignature(rawBody: string, secret: string, t: number = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Signature header for an attack's `setup.webhook.signature` variant (undefined = header missing). */
export function signatureFor(variant: "valid" | "missing" | "wrong_secret" | "stale_timestamp", rawBody: string, secret: string, nowSec = Math.floor(Date.now() / 1000)): string | undefined {
  switch (variant) {
    case "valid":
      return stripeSignature(rawBody, secret, nowSec);
    case "missing":
      return undefined;
    case "wrong_secret":
      return stripeSignature(rawBody, newWebhookSecret(), nowSec);
    case "stale_timestamp":
      return stripeSignature(rawBody, secret, nowSec - 3600); // Stripe's default tolerance is 300 s
  }
}

/**
 * A chaos case's processor event as the Stripe event the brain's webhook would receive:
 *   payment_succeeded -> checkout.session.completed (metadata.orderId/businessId as our checkout sets them)
 *   fee               -> charge.updated with an expanded balance_transaction carrying the fee
 *   refund_succeeded  -> refund.updated (status succeeded)
 *   payout            -> payout.paid (the brain ignores it today: it has no payout handler)
 */
export function stripeEventFor(e: ChaosEvent, businessId: string, created = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const meta = { orderId: e.orderId, businessId };
  const base = { id: e.eventId, object: "event", api_version: "2026-09-30.endive", created, livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null } };
  switch (e.kind) {
    case "payment_succeeded":
      return {
        ...base,
        type: "checkout.session.completed",
        data: {
          object: {
            id: `cs_${e.eventId}`,
            object: "checkout.session",
            payment_status: "paid",
            status: "complete",
            client_reference_id: e.orderId,
            metadata: meta,
            payment_intent: e.processorRef,
            amount_total: e.amountCents,
            currency: "usd",
          },
        },
      };
    case "fee":
      return {
        ...base,
        type: "charge.updated",
        data: {
          object: {
            id: `ch_${e.processorRef}`,
            object: "charge",
            metadata: meta,
            payment_intent: e.processorRef,
            balance_transaction: { id: `txn_${e.eventId}`, object: "balance_transaction", fee: e.amountCents },
          },
        },
      };
    case "refund_succeeded":
      return {
        ...base,
        type: "refund.updated",
        data: { object: { id: `re_${e.eventId}`, object: "refund", status: "succeeded", amount: e.amountCents, metadata: meta, payment_intent: e.processorRef } },
      };
    case "payout":
      return { ...base, type: "payout.paid", data: { object: { id: e.processorRef, object: "payout", amount: e.amountCents, status: "paid" } } };
  }
}
