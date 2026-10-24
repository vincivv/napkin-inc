// Payment processor gateway: real Stripe (TEST MODE) or the clearly-labelled DEV SIMULATOR.
// The simulator exists only so the system runs before a Stripe test key is configured.

import Stripe from "stripe";
import type { StripeMode } from "../env";
import type { PlatformPort } from "../platform";
import type { FeeInfo, FeeSource } from "./events";
import { SIM, simulatedFeeCents } from "./ids";

export interface LineItem {
  name: string;
  description?: string;
  unitAmountCents: bigint;
  quantity: number;
}

export interface CreateSessionParams {
  orderId: string;
  businessId: string;
  lineItems: LineItem[];
  successUrl: string;
  cancelUrl: string;
  idempotencyKey: string;
}

export interface CheckoutSessionInfo {
  id: string;
  url: string;
  status: "open" | "complete" | "expired";
  /** unix seconds */
  expiresAt: number;
}

export interface RefundInfo {
  id: string;
  amountCents: bigint;
  status: string;
  orderId: string | undefined;
}

export interface CreateRefundParams {
  paymentIntentId: string;
  amountCents: bigint;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

/** Retry later (network, 5xx, rate limit, auth misconfiguration). */
export class TransientProcessorError extends Error {
  override name = "TransientProcessorError";
}
/** Will never succeed as asked (invalid request, already refunded, ...). */
export class PermanentProcessorError extends Error {
  override name = "PermanentProcessorError";
}

export interface ProcessorGateway extends FeeSource {
  readonly mode: StripeMode;
  createCheckoutSession(p: CreateSessionParams): Promise<CheckoutSessionInfo>;
  retrieveCheckoutSession(id: string): Promise<CheckoutSessionInfo>;
  createRefund(p: CreateRefundParams): Promise<RefundInfo>;
  balanceTransactionFee(balanceTransactionId: string): Promise<FeeInfo>;
  orderIdForPaymentIntent(paymentIntentId: string): Promise<string | undefined>;
  refundsForCharge(chargeId: string): Promise<RefundInfo[]>;
}

export function classifyStripeError(e: unknown): Error {
  const err = e as { type?: string; message?: string; code?: string };
  const msg = `${err?.type ?? "Error"}: ${err?.message ?? String(e)}`;
  switch (err?.type) {
    case "StripeInvalidRequestError":
    case "StripeIdempotencyError":
    case "StripeCardError":
      return new PermanentProcessorError(msg);
    default:
      return new TransientProcessorError(msg);
  }
}

const sessionInfo = (s: Stripe.Checkout.Session): CheckoutSessionInfo => ({
  id: s.id,
  url: s.url ?? "",
  status: (s.status ?? "open") as CheckoutSessionInfo["status"],
  expiresAt: s.expires_at,
});

const refundInfo = (r: Stripe.Refund): RefundInfo => ({
  id: r.id,
  amountCents: BigInt(r.amount),
  status: r.status ?? "unknown",
  orderId: r.metadata?.orderId,
});

export class StripeGateway implements ProcessorGateway {
  readonly mode = "test" as const;
  constructor(readonly stripe: Stripe) {}

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      throw classifyStripeError(e);
    }
  }

  createCheckoutSession(p: CreateSessionParams): Promise<CheckoutSessionInfo> {
    return this.wrap(async () => {
      const s = await this.stripe.checkout.sessions.create(
        {
          mode: "payment",
          line_items: p.lineItems.map((li) => ({
            quantity: li.quantity,
            price_data: {
              currency: "usd",
              unit_amount: Number(li.unitAmountCents),
              product_data: { name: li.name, ...(li.description ? { description: li.description } : {}) },
            },
          })),
          client_reference_id: p.orderId,
          metadata: { orderId: p.orderId, businessId: p.businessId },
          payment_intent_data: { metadata: { orderId: p.orderId, businessId: p.businessId } },
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
        },
        { idempotencyKey: p.idempotencyKey },
      );
      if (!s.url) throw new PermanentProcessorError("Stripe returned a checkout session without a URL");
      return sessionInfo(s);
    });
  }

  retrieveCheckoutSession(id: string): Promise<CheckoutSessionInfo> {
    return this.wrap(async () => sessionInfo(await this.stripe.checkout.sessions.retrieve(id)));
  }

  createRefund(p: CreateRefundParams): Promise<RefundInfo> {
    return this.wrap(async () =>
      refundInfo(
        await this.stripe.refunds.create(
          { payment_intent: p.paymentIntentId, amount: Number(p.amountCents), metadata: p.metadata },
          { idempotencyKey: p.idempotencyKey },
        ),
      ),
    );
  }

  feeForPaymentIntent(paymentIntentId: string): Promise<FeeInfo | null> {
    return this.wrap(async () => {
      const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
      const charge = pi.latest_charge;
      if (!charge || typeof charge === "string") return null;
      const bt = charge.balance_transaction;
      if (!bt) return null;
      if (typeof bt === "string") return this.balanceTransactionFee(bt);
      return { balanceTransactionId: bt.id, feeCents: BigInt(bt.fee), simulated: false };
    });
  }

  balanceTransactionFee(balanceTransactionId: string): Promise<FeeInfo> {
    return this.wrap(async () => {
      const bt = await this.stripe.balanceTransactions.retrieve(balanceTransactionId);
      return { balanceTransactionId: bt.id, feeCents: BigInt(bt.fee), simulated: false };
    });
  }

  orderIdForPaymentIntent(paymentIntentId: string): Promise<string | undefined> {
    return this.wrap(async () => (await this.stripe.paymentIntents.retrieve(paymentIntentId)).metadata?.orderId);
  }

  refundsForCharge(chargeId: string): Promise<RefundInfo[]> {
    return this.wrap(async () => {
      const out: RefundInfo[] = [];
      for await (const r of this.stripe.refunds.list({ charge: chargeId, limit: 100 })) out.push(refundInfo(r));
      return out;
    });
  }
}

/**
 * DEV SIMULATOR. No money moves and nothing talks to Stripe. Fees are computed with the list-price
 * formula and every id is prefixed sim_ so simulated rows are obvious in the books.
 */
export class SimulatorGateway implements ProcessorGateway {
  readonly mode = "simulator" as const;
  constructor(private readonly platform: PlatformPort) {}

  async feeForPaymentIntent(paymentIntentId: string): Promise<FeeInfo | null> {
    const orderId = SIM.orderIdFromPaymentIntent(paymentIntentId);
    const order = orderId ? this.platform.order(orderId) : undefined;
    if (!orderId || !order) return null;
    return { balanceTransactionId: SIM.balanceTransactionId(orderId), feeCents: simulatedFeeCents(order.totalCents), simulated: true };
  }

  async createRefund(p: CreateRefundParams): Promise<RefundInfo> {
    return { id: SIM.refundId(p.metadata.outboxId ?? p.idempotencyKey), amountCents: p.amountCents, status: "succeeded", orderId: p.metadata.orderId };
  }

  async createCheckoutSession(): Promise<CheckoutSessionInfo> {
    throw new PermanentProcessorError("simulator mode has no Stripe checkout sessions");
  }
  async retrieveCheckoutSession(): Promise<CheckoutSessionInfo> {
    throw new PermanentProcessorError("simulator mode has no Stripe checkout sessions");
  }
  async balanceTransactionFee(): Promise<FeeInfo> {
    throw new PermanentProcessorError("simulator mode has no balance transactions");
  }
  async orderIdForPaymentIntent(paymentIntentId: string): Promise<string | undefined> {
    return SIM.orderIdFromPaymentIntent(paymentIntentId);
  }
  async refundsForCharge(): Promise<RefundInfo[]> {
    return [];
  }
}
