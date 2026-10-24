// Outbox worker: side effects queued by the platform in the same transaction as the document that
// caused them (e.g. a posted refund queues "stripe_refund"). The brain claims, executes with the row's
// own idempotency key, and completes. Crash-safe: an item left "claimed" longer than staleMs (brain
// crashed, or a transient Stripe error) is executed again with the SAME key, so Stripe dedupes it.

import type { OutboxView, PlatformPort } from "../platform";
import { ReducerRefused } from "../stdb";
import { log } from "../log";
import { handleRefundSucceeded } from "./events";
import { PermanentProcessorError, type ProcessorGateway } from "./gateway";

export interface OutboxResult {
  ok: boolean;
  result: Record<string, unknown>;
}

export interface OutboxExecutor {
  handles(kind: string): boolean;
  /** Throw for transient failures (item stays claimed and is retried); return ok=false for permanent ones. */
  execute(item: OutboxView): Promise<OutboxResult>;
}

/** stripe_refund payload, as queued by the platform. Field names beyond orderId/amountCents are tolerated. */
interface RefundPayload {
  orderId?: string;
  amountCents?: number | string;
  paymentIntentId?: string;
  processorRef?: string;
}

export class RefundExecutor implements OutboxExecutor {
  constructor(
    private readonly platform: PlatformPort,
    private readonly gateway: ProcessorGateway,
  ) {}

  handles(kind: string): boolean {
    return kind === "stripe_refund";
  }

  /** The payment intent comes from the payload, else from the order's posted payment_received document. */
  private paymentIntentFor(p: RefundPayload): string | undefined {
    const direct = p.paymentIntentId ?? p.processorRef;
    if (direct) return direct;
    if (!p.orderId) return undefined;
    return this.platform.documentsByExternalRef(p.orderId).find((d) => d.docType === "payment_received" && d.status === "posted")?.fields
      .processorRef;
  }

  async execute(item: OutboxView): Promise<OutboxResult> {
    let p: RefundPayload;
    try {
      p = JSON.parse(item.payloadJson) as RefundPayload;
    } catch {
      return { ok: false, result: { error: "payloadJson is not JSON" } };
    }
    const amount = p.amountCents === undefined ? undefined : BigInt(p.amountCents);
    if (!p.orderId || amount === undefined || amount <= 0n) return { ok: false, result: { error: "payload needs orderId and a positive amountCents" } };
    const paymentIntentId = this.paymentIntentFor(p);
    if (!paymentIntentId) return { ok: false, result: { error: `no payment intent found for ${p.orderId}` } };

    try {
      const refund = await this.gateway.createRefund({
        paymentIntentId,
        amountCents: amount,
        idempotencyKey: item.idempotencyKey,
        metadata: { orderId: p.orderId, businessId: item.businessId, outboxId: item.id.toString() },
      });
      if (refund.status === "succeeded") {
        // Same id the webhook would use (refund:<re_id>), so whichever arrives second is a no-op.
        await handleRefundSucceeded({ businessId: item.businessId, orderId: p.orderId, amountCents: refund.amountCents, refundId: refund.id }, { platform: this.platform });
      }
      return {
        ok: refund.status !== "failed" && refund.status !== "canceled",
        result: { refundId: refund.id, status: refund.status, amountCents: refund.amountCents.toString(), simulated: this.gateway.mode === "simulator" },
      };
    } catch (e) {
      if (e instanceof PermanentProcessorError) return { ok: false, result: { error: e.message } };
      throw e;
    }
  }
}

export interface OutboxWorkerOptions {
  platform: PlatformPort;
  executors: OutboxExecutor[];
  staleMs: number;
  now?: () => number;
}

export class OutboxWorker {
  private readonly inflight = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private scheduled = false;
  private readonly warnedKinds = new Set<string>();

  constructor(private readonly o: OutboxWorkerOptions) {}

  start(intervalMs = 5_000): void {
    this.o.platform.onOutboxChange(() => this.schedule());
    this.timer = setInterval(() => this.schedule(), intervalMs);
    this.schedule();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.tick().catch((e) => log.error("outbox", `tick failed: ${(e as Error).message}`));
    });
  }

  /** One pass over the outbox. Returns the ids it executed (for tests). */
  async tick(): Promise<string[]> {
    if (!this.o.platform.isConnected()) return [];
    const now = (this.o.now ?? Date.now)();
    const runs: Promise<string | undefined>[] = [];
    for (const item of this.o.platform.outboxItems()) {
      const executor = this.o.executors.find((x) => x.handles(item.kind));
      if (!executor) {
        if (item.status === "pending" && !this.warnedKinds.has(item.kind)) {
          this.warnedKinds.add(item.kind);
          log.warn("outbox", `no executor for kind "${item.kind}" yet; leaving it pending`);
        }
        continue;
      }
      const stale = item.status === "claimed" && item.claimedAtMs !== undefined && now - item.claimedAtMs > this.o.staleMs;
      if (item.status === "pending") runs.push(this.run(item, executor, true));
      else if (stale) runs.push(this.run(item, executor, false));
    }
    return (await Promise.all(runs)).filter((x): x is string => x !== undefined);
  }

  private async run(item: OutboxView, executor: OutboxExecutor, claim: boolean): Promise<string | undefined> {
    const id = item.id.toString();
    if (this.inflight.has(id)) return undefined;
    this.inflight.add(id);
    try {
      if (claim) {
        try {
          await this.o.platform.claimOutbox(item.id);
        } catch (e) {
          if (e instanceof ReducerRefused) {
            log.info("outbox", `claim ${id} refused (${e.message}); skipping`);
            return undefined;
          }
          throw e;
        }
      } else {
        log.warn("outbox", `retrying stale claimed item ${id} (${item.kind}) with its original idempotency key`);
      }
      const r = await executor.execute(item);
      const current = this.o.platform.outboxItems().find((x) => x.id === item.id);
      if (current?.status === "done" || current?.status === "failed") {
        log.info("outbox", `item ${id} already ${current.status} (completed by the processor event)`);
      } else {
        await this.o.platform.completeOutbox(item.id, r.ok, JSON.stringify(r.result));
      }
      log.info("outbox", `item ${id} (${item.kind}) -> ${r.ok ? "done" : "failed"}`);
      return id;
    } catch (e) {
      log.error("outbox", `item ${id} (${item.kind}) will be retried after ${this.o.staleMs}ms: ${(e as Error).message}`);
      return undefined;
    } finally {
      this.inflight.delete(id);
    }
  }
}
