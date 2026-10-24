// The red team's view of the payment processor while no Stripe key exists.
//
// SimProcessor wraps the brain's own DEV SIMULATOR gateway (services/brain SimulatorGateway): every refund,
// fee and id still comes from that simulator. On top it adds three things the red team needs:
//
//   1. processor truth: a record of what the "processor" really did (charges, fees, refunds), kept outside
//      our ledger, so measure.ts and the chaos checks can compare the ledger against it;
//   2. fault injection at the gateway boundary (port boundary, no process killing): a call can time out
//      (with or without having taken effect server side) or the brain can "crash" right before or right after
//      a processor call;
//   3. fees the processor has settled for a payment intent (from a chaos case's fee event), so the brain's
//      fee lookup sees what Stripe would report. Payment intents it does not know fall back to the simulator.
//
// Nothing here talks to Stripe. Anything that needs Stripe itself (real checkout sessions, Stripe's own
// idempotency-key dedupe) is reported as "skipped: needs Stripe test key" by the runner, never simulated.

import type { PlatformPort, ProcessorGateway, CreateRefundParams, RefundInfo, FeeInfo, CheckoutSessionInfo } from "./brain";
import { SimulatorGateway, TransientProcessorError } from "./brain";
import type { PlatformSnapshot } from "../types";

export type ProcessorTruth = PlatformSnapshot["processorTruth"][number];

/** Thrown at an armed crash point: the brain process "dies" here. Nothing after it runs in that brain. */
export class BrainCrash extends Error {
  override name = "BrainCrash";
  constructor(readonly point: string) {
    super(`simulated brain crash at ${point}`);
  }
}

export type CrashPoint =
  | "after_create_order_before_stripe_session"
  | "after_stripe_session_before_attach"
  | "after_refund_posted_before_stripe_refund"
  | "after_stripe_refund_before_complete_outbox";

export type ProcessorApi = "checkout.sessions.create" | "refunds.create" | "balance_transactions.retrieve";

export class SimProcessor {
  private readonly truth: ProcessorTruth[] = [];
  private readonly seen = new Set<string>(); // de-dupes truth rows by processor id
  private readonly settledFees = new Map<string, FeeInfo>(); // paymentIntentId -> fee
  private readonly timeouts = new Map<ProcessorApi, { times: number; succeedsServerSide: boolean }>();
  private armed: CrashPoint | undefined;
  /** crash points that fired, in order */
  readonly crashes: CrashPoint[] = [];
  /** every createRefund attempt (including timed-out and crashed ones), for diagnostics */
  readonly refundAttempts: { idempotencyKey: string; outcome: string }[] = [];

  record(t: ProcessorTruth, uniqueKey: string = `${t.kind}:${t.processorRef}`): void {
    if (this.seen.has(uniqueKey)) return;
    this.seen.add(uniqueKey);
    this.truth.push(t);
  }

  /** The processor settled a fee on this payment intent (a balance transaction exists). */
  settleFee(paymentIntentId: string, fee: FeeInfo, orderId: string): void {
    this.settledFees.set(paymentIntentId, fee);
    this.record({ kind: "fee", orderId, processorRef: fee.balanceTransactionId, amountCents: Number(fee.feeCents) }, `fee:${fee.balanceTransactionId}`);
  }

  armCrash(point: CrashPoint): void {
    this.armed = point;
  }
  get armedCrash(): CrashPoint | undefined {
    return this.armed;
  }

  armTimeout(api: ProcessorApi, times: number, succeedsServerSide: boolean): void {
    this.timeouts.set(api, { times, succeedsServerSide });
  }

  /** One-shot: throws BrainCrash if `point` is armed. */
  crashIf(point: CrashPoint): void {
    if (this.armed !== point) return;
    this.armed = undefined;
    this.crashes.push(point);
    throw new BrainCrash(point);
  }

  /** Consumes one armed timeout for `api`: undefined (no timeout), or whether the call took effect anyway. */
  private takeTimeout(api: ProcessorApi): { succeedsServerSide: boolean } | undefined {
    const t = this.timeouts.get(api);
    if (!t || t.times <= 0) return undefined;
    t.times -= 1;
    return { succeedsServerSide: t.succeedsServerSide };
  }

  snapshotTruth(): ProcessorTruth[] {
    return this.truth.map((t) => ({ ...t }));
  }

  /** A ProcessorGateway over the brain's SimulatorGateway with truth recording and fault injection. */
  gateway(platform: PlatformPort): ProcessorGateway {
    const sim = new SimulatorGateway(platform);
    const self = this;
    return {
      mode: "simulator",
      async feeForPaymentIntent(paymentIntentId: string): Promise<FeeInfo | null> {
        const settled = self.settledFees.get(paymentIntentId);
        if (settled) return settled;
        const fee = await sim.feeForPaymentIntent(paymentIntentId);
        if (fee) {
          const orderId = paymentIntentId.replace(/^sim_pi_/, "");
          self.record({ kind: "fee", orderId, processorRef: fee.balanceTransactionId, amountCents: Number(fee.feeCents) }, `fee:${fee.balanceTransactionId}`);
        }
        return fee;
      },
      async createRefund(p: CreateRefundParams): Promise<RefundInfo> {
        self.crashIf("after_refund_posted_before_stripe_refund");
        const timeout = self.takeTimeout("refunds.create");
        if (timeout && !timeout.succeedsServerSide) {
          self.refundAttempts.push({ idempotencyKey: p.idempotencyKey, outcome: "timeout (no effect)" });
          throw new TransientProcessorError("simulated timeout: refunds.create (did not take effect)");
        }
        const r = await sim.createRefund(p); // deterministic id per outbox item: the simulator's idempotency
        self.record({ kind: "refund", orderId: r.orderId ?? p.metadata.orderId ?? "", processorRef: r.id, amountCents: Number(r.amountCents) }, `refund:${r.id}`);
        if (timeout) {
          self.refundAttempts.push({ idempotencyKey: p.idempotencyKey, outcome: "timeout (took effect)" });
          throw new TransientProcessorError("simulated timeout: refunds.create (took effect server side)");
        }
        self.refundAttempts.push({ idempotencyKey: p.idempotencyKey, outcome: `ok ${r.id}` });
        self.crashIf("after_stripe_refund_before_complete_outbox");
        return r;
      },
      createCheckoutSession(): Promise<CheckoutSessionInfo> {
        return sim.createCheckoutSession();
      },
      retrieveCheckoutSession(): Promise<CheckoutSessionInfo> {
        return sim.retrieveCheckoutSession();
      },
      balanceTransactionFee(): Promise<FeeInfo> {
        return sim.balanceTransactionFee();
      },
      orderIdForPaymentIntent(pi: string): Promise<string | undefined> {
        return sim.orderIdForPaymentIntent(pi);
      },
      refundsForCharge(): Promise<RefundInfo[]> {
        return sim.refundsForCharge();
      },
    };
  }
}
