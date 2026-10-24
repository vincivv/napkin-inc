// Z3 lifecycle: one lazily-initialized WASM instance and one context per process.
// check() calls serialize inside z3-solver; we additionally queue them so timings are honest.

import { init, killThreads, type Arith, type Bool, type Context, type Model } from "z3-solver";

export type Z3 = Context<"main">;
export type ZArith = Arith<"main">;
export type ZBool = Bool<"main">;
export type ZModel = Model<"main">;

type Api = Awaited<ReturnType<typeof init>>;

let apiP: Promise<Api> | null = null;
let ctx: Z3 | null = null;

export async function getZ3(): Promise<Z3> {
  if (!apiP) apiP = init();
  const api = await apiP;
  if (!ctx) ctx = new api.Context("main");
  return ctx;
}

export async function solverName(): Promise<string> {
  if (!apiP) apiP = init();
  const api = await apiP;
  return `z3-solver 5.3.1 (Z3 ${api.getVersionString()})`;
}

/** Terminate Z3's worker threads so the Node process can exit. Safe to call more than once. */
export async function shutdown(): Promise<void> {
  if (!apiP) return;
  const api = await apiP;
  apiP = null;
  ctx = null;
  await killThreads(api.em);
}

export type CheckOutcome = { status: "unsat" } | { status: "sat"; model: ZModel } | { status: "unknown"; reason: string };

let queue: Promise<unknown> = Promise.resolve();

/** Check a conjunction of assertions in a fresh solver with a timeout. */
export async function check(z: Z3, assertions: ZBool[], timeoutMs: number): Promise<CheckOutcome> {
  const run = async (): Promise<CheckOutcome> => {
    const s = new z.Solver();
    s.set("timeout", timeoutMs);
    for (const a of assertions) s.add(a);
    const t0 = performance.now();
    const r = await s.check();
    if (process.env.PROVER_DEBUG) console.error(`[z3] ${r} ${Math.round(performance.now() - t0)}ms (${assertions.length} assertions)`);
    if (r === "unsat") return { status: "unsat" };
    if (r === "sat") return { status: "sat", model: s.model() };
    let reason = "unknown";
    try {
      reason = s.reasonUnknown();
    } catch {
      /* older builds */
    }
    return { status: "unknown", reason };
  };
  const p = queue.then(run, run);
  queue = p.catch(() => undefined);
  return p;
}

/** Validate a model independently: every assertion must evaluate to true under it (with completion). */
export function modelSatisfies(z: Z3, m: ZModel, assertions: ZBool[]): boolean {
  for (const a of assertions) {
    const v = m.eval(a, true);
    if (!z.isTrue(v)) return false;
  }
  return true;
}
