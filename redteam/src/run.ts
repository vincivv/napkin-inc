// Red-team runner skeleton. Runs the attack set in both modes (baseline, napkin) and produces RunResult[].
//
// Nothing here talks to the agents or to the platform yet. The AgentHarness and Inspector interfaces are
// the seam: M3 wires real implementations (brain + SpacetimeDB). Until then `notWired` throws, so a
// run can never silently produce fake numbers.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { loadAttacks, loadChaos, type LoadedAttack } from "./load";
import { measureAttack } from "./measure";
import { type Attack, type ChaosCase, type Mode, type PlatformSnapshot, type RunFile, type RunResult, type Transcript } from "./types";

/** Drives the Napkin Inc. agents (shopkeeper, support, bookkeeper) with the attacker's turns. */
export interface AgentHarness {
  /** Sends the attacker's turns to `target` in `mode`; returns what the agent said and every tool call. */
  send(target: Attack["target"], turns: string[], mode: Mode): Promise<Transcript>;
}

/** Reads platform state and prepares the world an attack starts from. */
export interface Inspector {
  /** Resets the business to a clean configuration and creates the attack's setup orders and notes. */
  prepare(attack: Attack, mode: Mode): Promise<void>;
  /** Reads the full platform state (orders, documents, journal, outbox, processor truth, ...). */
  snapshot(mode: Mode): Promise<PlatformSnapshot>;
}

/** Runs one chaos case (crash points, Stripe timeouts, webhook replays) and reports pass/fail. */
export interface ChaosDriver {
  runCase(c: ChaosCase, mode: Mode): Promise<{ passed: boolean; failures: string[] }>;
}

export interface RunDeps {
  harness: AgentHarness;
  inspector: Inspector;
  chaos: ChaosDriver;
}

const NOT_WIRED = "not wired yet (M3)";

export const notWired: RunDeps = {
  harness: { send: async () => { throw new Error(NOT_WIRED); } },
  inspector: { prepare: async () => { throw new Error(NOT_WIRED); }, snapshot: async () => { throw new Error(NOT_WIRED); } },
  chaos: { runCase: async () => { throw new Error(NOT_WIRED); } },
};

export const MODES: Mode[] = ["baseline", "napkin"];

/** Hash of the attack set (ids plus canonical JSON), recorded in every RunFile so runs are comparable. */
export function attackSetHash(attacks: readonly Attack[]): string {
  const canon = [...attacks]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((a) => JSON.stringify(a));
  return createHash("sha256").update(canon.join("\n")).digest("hex").slice(0, 16);
}

/** One attack in one mode: prepare, snapshot, talk, snapshot, measure. Errors from the deps propagate. */
export async function runAttack(attack: Attack, mode: Mode, deps: RunDeps): Promise<RunResult> {
  await deps.inspector.prepare(attack, mode);
  const before = await deps.inspector.snapshot(mode);
  const transcript = await deps.harness.send(attack.target, attack.turns, mode);
  const after = await deps.inspector.snapshot(mode);
  return measureAttack(attack, mode, before, after, transcript);
}

export async function runChaos(c: ChaosCase, mode: Mode, deps: RunDeps): Promise<RunResult> {
  const r = await deps.chaos.runCase(c, mode);
  return { kind: "chaos", caseId: c.id, chaosKind: c.kind, mode, passed: r.passed, failures: r.failures, invariantIds: c.invariantIds };
}

/** Runs every attack in both modes, in a stable order (attack id, then mode). */
export async function runAttacks(attacks: readonly LoadedAttack[], deps: RunDeps, modes: Mode[] = MODES): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const ordered = [...attacks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const a of ordered) for (const m of modes) out.push(await runAttack(a, m, deps));
  return out;
}

export async function runAllChaos(deps: RunDeps, modes: Mode[] = MODES): Promise<RunResult[]> {
  const out: RunResult[] = [];
  for (const c of loadChaos()) for (const m of modes) out.push(await runChaos(c, m, deps));
  return out;
}

/** Assembles the RunFile the results generator consumes. `ranAt` comes from the runner's clock, never results.ts. */
export function buildRunFile(results: RunResult[], attacks: readonly Attack[], label: string, model: string): RunFile {
  return {
    schema: "napkin-redteam-run/1",
    fake: false,
    label,
    model,
    ranAt: new Date().toISOString(),
    attackSetHash: attackSetHash(attacks),
    results,
  };
}

async function main(): Promise<void> {
  const attacks = loadAttacks();
  // Not wired: this throws "not wired yet (M3)" before any state is touched.
  await runAttacks(attacks, notWired);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
