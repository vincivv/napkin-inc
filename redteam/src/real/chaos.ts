// The real ChaosDriver. Each case runs on a freshly reset napkin-l, through the brain's own payment code:
//
//   create_order + start_checkout  -> createCheckout (storefront createOrder, logPaymentIntent, simulator session)
//   webhook                        -> a Stripe-shaped event, signed with a per-run secret, verified by the brain's
//                                     verifyStripeEvent and dispatched by dispatchStripeEvent (the /webhooks/stripe
//                                     code path), repeated or concurrent as the case says
//   request_refund / approve_refund-> requestRefund as support, postDocument as bookkeeper (the agents' reducers)
//   drain_outbox                   -> the brain's OutboxWorker + RefundExecutor, ticked by hand
//   crash_at                       -> a one-shot crash at a port boundary (the processor gateway): the brain "dies"
//                                     there; restart_brain drops every connection and in-memory object and
//                                     reconnects with the same stored identities
//   stripe_timeout (refunds.create)-> the gateway call times out, with or without having taken effect
//
// Cases that need real Stripe (checkout sessions) are not run; see chaosSkipReason.

import { businessFor, type ScratchWorld } from "./db";
import { createCheckout, dispatchStripeEvent, verifyStripeEvent, type ProcessorGateway, type SessionRecord } from "./brain";
import { BrainCrash, SimProcessor, type CrashPoint } from "./processor";
import { drainOutbox, syncOutbox, type BrainClock } from "./outbox-drain";
import { newWebhookSecret, stripeEventFor, stripeSignature } from "./stripe-events";
import { readSnapshot } from "./inspector";
import { chaosSkipReason, evaluateChaos } from "./chaos-eval";
import type { ChaosDriver } from "../run";
import type { ChaosCase, ChaosStep, Mode } from "../types";

export interface ChaosOutcome {
  passed: boolean;
  failures: string[];
  /** set when the case was not run (needs Stripe) */
  skipped?: string;
  /** what happened, step by step (goes into the run file) */
  trace: string[];
}

interface Brain {
  gateway: ProcessorGateway;
  dead: boolean;
}

export class RealChaosDriver implements ChaosDriver {
  lastTrace: string[] = [];

  constructor(readonly world: ScratchWorld) {}

  async runCase(c: ChaosCase, mode: Mode): Promise<ChaosOutcome> {
    const skipped = chaosSkipReason(c);
    if (skipped) return { passed: false, failures: [], skipped, trace: [] };

    const w = this.world;
    await w.reset();
    const biz = businessFor(mode);
    const processor = new SimProcessor();
    const secret = newWebhookSecret();
    const clock: BrainClock = { offsetMs: 0 };
    const sessions = new Map<string, SessionRecord>(); // stands in for .data/sessions.json (survives restarts)
    const pendingOrders = new Map<string, Extract<ChaosStep, { op: "create_order" }>>();
    const trace: string[] = [];
    const failures: string[] = [];
    const crashesBefore = () => processor.crashes.length;
    let brain: Brain = { gateway: processor.gateway(w.platform), dead: false };

    const onBrain = async (what: string, fn: () => Promise<void>) => {
      if (brain.dead) {
        failures.push(`step "${what}" ran while the brain was crashed (case has no restart_brain before it)`);
        return;
      }
      const n = crashesBefore();
      try {
        await fn();
      } catch (e) {
        if (e instanceof BrainCrash) {
          trace.push(`  brain crashed at ${e.point}`);
          brain.dead = true;
          return;
        }
        throw e;
      }
      if (processor.crashes.length > n) {
        trace.push(`  brain crashed at ${processor.crashes[processor.crashes.length - 1]} (inside the outbox worker)`);
        brain.dead = true;
      }
    };

    for (const [i, step] of c.steps.entries()) {
      const label = `${i + 1}. ${step.op}`;
      try {
        switch (step.op) {
          case "create_order":
            if (step.discountRate !== "0") throw new Error("create_order with a discount is not supported by createCheckout (the storefront never discounts)");
            pendingOrders.set(step.orderId, step);
            trace.push(`${label} ${step.orderId} (created by start_checkout through createCheckout)`);
            break;

          case "start_checkout":
            await onBrain(label, async () => {
              const spec = pendingOrders.get(step.orderId);
              if (!spec) throw new Error(`start_checkout for ${step.orderId} without create_order`);
              const r = await createCheckout(
                { businessId: biz, lines: spec.items, customerName: "Chaos" },
                {
                  platform: w.platform,
                  gateway: brain.gateway,
                  sessions: { get: (id) => sessions.get(id), put: (rec) => void sessions.set(rec.orderId, rec) },
                  storePublicUrl: "http://localhost:3002",
                  hasStorefront: () => true,
                  newOrderId: () => step.orderId,
                },
              );
              pendingOrders.delete(step.orderId);
              trace.push(`${label} ${r.orderId} -> ${r.simulated ? "simulator checkout" : r.url}`);
            });
            break;

          case "webhook": {
            const ev = step.event;
            if (ev.kind === "payment_succeeded") processor.record({ kind: "charge", orderId: ev.orderId, processorRef: ev.processorRef, amountCents: ev.amountCents }, `charge:${ev.eventId}`);
            if (ev.kind === "fee") processor.settleFee(ev.processorRef, { balanceTransactionId: `txn_${ev.eventId}`, feeCents: BigInt(ev.amountCents), simulated: true }, ev.orderId);
            if (ev.kind === "refund_succeeded") processor.record({ kind: "refund", orderId: ev.orderId, processorRef: `re_${ev.eventId}`, amountCents: ev.amountCents });
            if (ev.kind === "payout") processor.record({ kind: "payout", orderId: ev.orderId, processorRef: ev.processorRef, amountCents: ev.amountCents });
            const raw = JSON.stringify(stripeEventFor(ev, biz));
            await onBrain(label, async () => {
              const deliver = async () => {
                const event = verifyStripeEvent(raw, stripeSignature(raw, secret), secret);
                return dispatchStripeEvent(event, { platform: w.platform, gateway: brain.gateway });
              };
              const n = step.repeat;
              const settled = step.concurrent
                ? await Promise.allSettled(Array.from({ length: n }, deliver))
                : await (async () => {
                    const out: PromiseSettledResult<Awaited<ReturnType<typeof deliver>>>[] = [];
                    for (let k = 0; k < n; k++) out.push(...(await Promise.allSettled([deliver()])));
                    return out;
                  })();
              const ok = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<{ status: string; reason?: string }>).value);
              const bad = settled.filter((s) => s.status === "rejected").map((s) => String((s as PromiseRejectedResult).reason?.message ?? (s as PromiseRejectedResult).reason));
              const summary = [...new Set(ok.map((o) => (o.status === "ignored" ? `ignored (${o.reason})` : o.status)))].join(", ");
              trace.push(`${label} ${ev.kind} ${ev.eventId} x${n}${step.concurrent ? " concurrent" : ""}: ${summary}${bad.length ? `; ${bad.length} delivery error(s): ${[...new Set(bad)].join(" | ")}` : ""}`);
              // A non-2xx makes Stripe redeliver. Redeliver failed deliveries once, as Stripe would.
              if (bad.length) {
                const retry = await Promise.allSettled(bad.map(() => deliver()));
                const still = retry.filter((r) => r.status === "rejected").length;
                trace.push(`   redelivered ${bad.length}: ${still} still failing`);
                if (still) failures.push(`webhook ${ev.eventId}: ${still} delivery(ies) still failing after a redelivery`);
              }
            });
            break;
          }

          case "request_refund":
            await w.hub.call(w.key("support", mode), "requestRefund", (cn) => cn.reducers.requestRefund({ orderId: step.orderId, amountCents: BigInt(step.amountCents), reason: step.reason }));
            trace.push(`${label} ${step.orderId} ${step.amountCents} cents (support)`);
            break;

          case "approve_refund": {
            const res = await w.sql(`SELECT id FROM document WHERE doc_type = 'refund' AND status = 'draft' AND external_ref = '${step.orderId}'`);
            const id = res[0]?.rows[0]?.[0];
            if (id === undefined) throw new Error(`no refund draft for ${step.orderId}`);
            await w.hub.call(w.key("bookkeeper", mode), "postDocument", (cn) => cn.reducers.postDocument({ documentId: BigInt(String(id)) }));
            await syncOutbox(w);
            trace.push(`${label} refund document ${id} posted (bookkeeper)`);
            break;
          }

          case "drain_outbox":
            await onBrain(label, async () => {
              const n0 = processor.crashes.length;
              const r = await drainOutbox(w, brain.gateway, clock, step.maxPasses, undefined, () => processor.crashes.length > n0);
              trace.push(`${label} ${r.passes} pass(es), executed [${r.executed.join(", ")}], still open [${r.stillOpen.join(", ")}], brain clock +${r.clockAdvancedMs / 1000}s`);
            });
            break;

          case "crash_at":
            processor.armCrash(step.point as CrashPoint);
            trace.push(`${label} armed ${step.point}`);
            break;

          case "restart_brain": {
            if (processor.armedCrash && !brain.dead) {
              // The live brain's outbox worker reacts to every outbox change; run it once on the OLD brain so an
              // armed outbox crash point is reached the way it would be in production.
              await onBrain(`${label} (old brain's outbox worker)`, async () => {
                const n0 = processor.crashes.length;
                const r = await drainOutbox(w, brain.gateway, clock, 1, undefined, () => processor.crashes.length > n0);
                trace.push(`${label} old brain's worker: executed [${r.executed.join(", ")}]`);
              });
            }
            if (processor.armedCrash) failures.push(`crash point ${processor.armedCrash} was never reached`);
            await w.restartBrain();
            brain = { gateway: processor.gateway(w.platform), dead: false };
            trace.push(`${label} brain restarted (new connections, same identities, in-memory state dropped)`);
            break;
          }

          case "stripe_timeout":
            processor.armTimeout(step.api, step.times, step.succeedsServerSide);
            trace.push(`${label} next ${step.times} ${step.api} call(s) time out (${step.succeedsServerSide ? "taking effect" : "no effect"} server side)`);
            break;
        }
      } catch (e) {
        const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
        trace.push(`${label} ERROR ${msg}`);
        failures.push(`step ${label} failed: ${msg}`);
      }
    }

    const snap = await readSnapshot(w, mode, processor);
    const check = evaluateChaos(c, snap);
    for (const a of processor.refundAttempts) trace.push(`   processor refunds.create ${a.idempotencyKey}: ${a.outcome}`);
    const all = [...failures, ...check];
    this.lastTrace = trace;
    return { passed: all.length === 0, failures: all, trace };
  }
}
