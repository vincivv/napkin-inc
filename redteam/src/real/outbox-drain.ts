// Drains the platform outbox with the brain's own OutboxWorker + RefundExecutor, deterministically:
// the worker is ticked by hand (no timers), and its clock can be moved forward so an item left "claimed"
// by a crashed or timed-out attempt becomes stale and is retried with its original idempotency key,
// exactly as the running brain would do after OUTBOX_STALE_SECONDS (default 60 s, the brain's env default).

import { OutboxWorker, RefundExecutor, type ProcessorGateway } from "./brain";
import type { ScratchWorld } from "./db";

/** The brain's default OUTBOX_STALE_SECONDS (services/brain/src/env.ts). */
export const BRAIN_STALE_MS = 60_000;

/** Simulated time added to the brain's clock (never to the platform's). Monotonic across brain restarts. */
export interface BrainClock {
  offsetMs: number;
}

/** Waits until the system connection's cache shows the same outbox rows (id + status) as the database. */
export async function syncOutbox(world: ScratchWorld, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = (await world.sql("SELECT id, status FROM outbox"))[0]?.rows ?? [];
    const want = new Map(rows.map((r) => [String(r[0]), String(r[1])]));
    const have = new Map(world.platform.outboxItems().map((o) => [o.id.toString(), o.status]));
    const same = want.size === have.size && [...want].every(([k, v]) => have.get(k) === v);
    if (same) return;
    if (Date.now() > deadline) throw new Error(`system cache did not catch up with the outbox (db ${JSON.stringify([...want])}, cache ${JSON.stringify([...have])})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export interface DrainReport {
  passes: number;
  executed: string[];
  stillOpen: string[];
  clockAdvancedMs: number;
}

/**
 * Up to `maxPasses` worker passes. After a pass that leaves stripe_refund items pending or claimed, the
 * brain's clock moves forward by staleMs + 1 s so the next pass may retry them (a stale claim).
 */
export async function drainOutbox(
  world: ScratchWorld,
  gateway: ProcessorGateway,
  clock: BrainClock,
  maxPasses = 5,
  staleMs = BRAIN_STALE_MS,
  /** true once this brain has crashed: a dead brain does nothing more */
  isDead: () => boolean = () => false,
): Promise<DrainReport> {
  const worker = new OutboxWorker({
    platform: world.platform,
    executors: [new RefundExecutor(world.platform, gateway)],
    staleMs,
    now: () => Date.now() + clock.offsetMs,
  });
  const executed: string[] = [];
  let passes = 0;
  let advanced = 0;
  let open: string[] = [];
  for (let i = 0; i < maxPasses; i++) {
    await syncOutbox(world);
    passes++;
    executed.push(...(await worker.tick()));
    if (isDead()) break;
    await syncOutbox(world);
    open = world.platform
      .outboxItems()
      .filter((o) => o.kind === "stripe_refund" && (o.status === "pending" || o.status === "claimed"))
      .map((o) => `${o.id}:${o.status}`);
    if (open.length === 0) break;
    clock.offsetMs += staleMs + 1_000;
    advanced += staleMs + 1_000;
  }
  return { passes, executed, stillOpen: open, clockAdvancedMs: advanced };
}
