// Internal processor events and the ONE set of handlers that turn them into platform calls.
// Both the Stripe webhook and the dev simulator build these objects and call these functions.
//
// Exactly-once (invariant 7): every recordProcessorEvent carries an id that comes from the processor
// (Stripe event id, balance transaction id, refund id; or a deterministic sim_* id), never a fresh one,
// so a replayed delivery hits the platform's unique processor_event.eventId and is a no-op.

import type { PlatformPort } from "../platform";
import { feeEventId, refundEventId } from "./ids";

export interface FeeInfo {
  balanceTransactionId: string;
  feeCents: bigint;
  simulated: boolean;
}

/** What the handlers need from the payment processor. */
export interface FeeSource {
  /** Fee for a payment intent, or null if the balance transaction is not available yet. */
  feeForPaymentIntent(paymentIntentId: string): Promise<FeeInfo | null>;
}

export interface PaymentSucceeded {
  /** Stripe event id (evt_...) or sim_evt_<orderId>. */
  eventId: string;
  businessId: string;
  orderId: string;
  amountCents: bigint;
  paymentIntentId: string;
}

export interface FeeSettled {
  businessId: string;
  orderId: string;
  fee: FeeInfo;
}

export interface RefundSucceeded {
  businessId: string;
  orderId: string;
  amountCents: bigint;
  refundId: string;
}

export interface Recorded {
  eventId: string;
  kind: string;
  amountCents: string;
}

export interface HandlerDeps {
  platform: PlatformPort;
  fees: FeeSource;
}

export async function handleFeeSettled(ev: FeeSettled, deps: Pick<HandlerDeps, "platform">): Promise<Recorded> {
  const eventId = feeEventId(ev.fee.balanceTransactionId);
  await deps.platform.recordProcessorEvent({
    eventId,
    businessId: ev.businessId,
    kind: "fee",
    orderId: ev.orderId,
    amountCents: ev.fee.feeCents,
    processorRef: ev.fee.balanceTransactionId,
  });
  return { eventId, kind: "fee", amountCents: ev.fee.feeCents.toString() };
}

/**
 * Payment first (posts payment_received + the sale, order -> paid), then the fee if Stripe has
 * settled the balance transaction. If not, the fee arrives later via charge.updated.
 */
export async function handlePaymentSucceeded(ev: PaymentSucceeded, deps: HandlerDeps): Promise<{ recorded: Recorded[]; feePending: boolean }> {
  await deps.platform.recordProcessorEvent({
    eventId: ev.eventId,
    businessId: ev.businessId,
    kind: "payment_succeeded",
    orderId: ev.orderId,
    amountCents: ev.amountCents,
    processorRef: ev.paymentIntentId,
  });
  const recorded: Recorded[] = [{ eventId: ev.eventId, kind: "payment_succeeded", amountCents: ev.amountCents.toString() }];
  const fee = await deps.fees.feeForPaymentIntent(ev.paymentIntentId);
  if (!fee) return { recorded, feePending: true };
  recorded.push(await handleFeeSettled({ businessId: ev.businessId, orderId: ev.orderId, fee }, deps));
  return { recorded, feePending: false };
}

export async function handleRefundSucceeded(ev: RefundSucceeded, deps: Pick<HandlerDeps, "platform">): Promise<Recorded> {
  const eventId = refundEventId(ev.refundId);
  await deps.platform.recordProcessorEvent({
    eventId,
    businessId: ev.businessId,
    kind: "refund_succeeded",
    orderId: ev.orderId,
    amountCents: ev.amountCents,
    processorRef: ev.refundId,
  });
  return { eventId, kind: "refund_succeeded", amountCents: ev.amountCents.toString() };
}
