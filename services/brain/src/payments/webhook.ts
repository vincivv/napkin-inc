// Stripe webhook: verify the signature over the RAW body, map the event to internal events, and run
// the shared handlers. Ids passed to the platform are always Stripe's own (event id, balance
// transaction id, refund id), so duplicate or replayed deliveries are no-ops in the platform.

import Stripe from "stripe";
import type { PlatformPort } from "../platform";
import { log } from "../log";
import { handleFeeSettled, handlePaymentSucceeded, handleRefundSucceeded, type Recorded } from "./events";
import type { ProcessorGateway } from "./gateway";

export class WebhookSignatureError extends Error {
  override name = "WebhookSignatureError";
}

/** Verify `stripe-signature` against the raw payload bytes. Throws WebhookSignatureError. */
export function verifyStripeEvent(rawBody: Buffer | string, signature: string | undefined, secret: string): Stripe.Event {
  if (!signature) throw new WebhookSignatureError("missing stripe-signature header");
  try {
    return Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch (e) {
    throw new WebhookSignatureError((e as Error).message);
  }
}

export type DispatchOutcome =
  | { status: "processed"; recorded: Recorded[]; note?: string }
  | { status: "ignored"; reason: string };

export interface WebhookDeps {
  platform: PlatformPort;
  gateway: ProcessorGateway;
}

const idOf = (x: string | { id: string } | null | undefined): string | undefined => (typeof x === "string" ? x : x?.id);

function businessFor(platform: PlatformPort, orderId: string, metadataBusinessId: string | undefined): string | undefined {
  const order = platform.order(orderId);
  if (order && metadataBusinessId && order.businessId !== metadataBusinessId) {
    log.warn("webhook", `order ${orderId}: metadata businessId ${metadataBusinessId} != platform ${order.businessId}; using the platform's`);
  }
  return order?.businessId ?? metadataBusinessId;
}

async function orderIdForCharge(ch: Stripe.Charge, gateway: ProcessorGateway): Promise<string | undefined> {
  if (ch.metadata?.orderId) return ch.metadata.orderId;
  const pi = idOf(ch.payment_intent);
  return pi ? gateway.orderIdForPaymentIntent(pi) : undefined;
}

export async function dispatchStripeEvent(event: Stripe.Event, deps: WebhookDeps): Promise<DispatchOutcome> {
  const { platform, gateway } = deps;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object;
      if (s.payment_status !== "paid") return { status: "ignored", reason: `payment_status=${s.payment_status}` };
      const orderId = s.metadata?.orderId ?? s.client_reference_id ?? undefined;
      if (!orderId) return { status: "ignored", reason: "session has no orderId (not a Napkin checkout)" };
      const businessId = businessFor(platform, orderId, s.metadata?.businessId);
      const paymentIntentId = idOf(s.payment_intent);
      if (!businessId || !paymentIntentId || s.amount_total == null) {
        return { status: "ignored", reason: `incomplete session (business=${businessId}, pi=${paymentIntentId}, amount=${s.amount_total})` };
      }
      const r = await handlePaymentSucceeded(
        { eventId: event.id, businessId, orderId, amountCents: BigInt(s.amount_total), paymentIntentId },
        { platform, fees: gateway },
      );
      return { status: "processed", recorded: r.recorded, ...(r.feePending ? { note: "fee not settled yet; will post on charge.updated" } : {}) };
    }

    case "charge.succeeded":
    case "charge.updated": {
      const ch = event.data.object;
      const btId = idOf(ch.balance_transaction);
      if (!btId) return { status: "ignored", reason: "balance transaction not available yet" };
      const orderId = await orderIdForCharge(ch, gateway);
      if (!orderId) return { status: "ignored", reason: "charge has no orderId (not a Napkin checkout)" };
      const order = platform.order(orderId);
      // The fee posts only after the payment: checkout.session.completed looks the fee up itself, so a
      // charge event that arrives first is safely ignored here (no fee can be lost or doubled).
      if (!order || order.status === "pending_payment") {
        return { status: "ignored", reason: `order ${orderId} payment not recorded yet; checkout.session.completed posts the fee` };
      }
      const bt = ch.balance_transaction;
      const fee =
        typeof bt === "object" && bt !== null
          ? { balanceTransactionId: bt.id, feeCents: BigInt(bt.fee), simulated: false }
          : await gateway.balanceTransactionFee(btId);
      return { status: "processed", recorded: [await handleFeeSettled({ businessId: order.businessId, orderId, fee }, { platform })] };
    }

    case "charge.refunded": {
      const ch = event.data.object;
      const orderId = await orderIdForCharge(ch, gateway);
      if (!orderId) return { status: "ignored", reason: "charge has no orderId (not a Napkin checkout)" };
      const businessId = businessFor(platform, orderId, ch.metadata?.businessId);
      if (!businessId) return { status: "ignored", reason: `unknown order ${orderId}` };
      // A charge can carry several refunds; each one is recorded once, keyed by its own refund id.
      const refunds = (await gateway.refundsForCharge(ch.id)).filter((r) => r.status === "succeeded");
      const recorded: Recorded[] = [];
      for (const r of refunds) {
        recorded.push(await handleRefundSucceeded({ businessId, orderId, amountCents: r.amountCents, refundId: r.id }, { platform }));
      }
      return { status: "processed", recorded };
    }

    case "refund.created":
    case "refund.updated": {
      const r = event.data.object;
      if (r.status !== "succeeded") return { status: "ignored", reason: `refund status=${r.status}` };
      const orderId = r.metadata?.orderId ?? (idOf(r.payment_intent) ? await gateway.orderIdForPaymentIntent(idOf(r.payment_intent)!) : undefined);
      if (!orderId) return { status: "ignored", reason: "refund has no orderId (not a Napkin refund)" };
      const businessId = businessFor(platform, orderId, r.metadata?.businessId);
      if (!businessId) return { status: "ignored", reason: `unknown order ${orderId}` };
      return {
        status: "processed",
        recorded: [await handleRefundSucceeded({ businessId, orderId, amountCents: BigInt(r.amount), refundId: r.id }, { platform })],
      };
    }

    default:
      return { status: "ignored", reason: `unhandled event type ${event.type}` };
  }
}
