// Pure row classification for the real runner: which attacks run for real now, which wait for the agent
// harness, which cannot be set up. Deterministic; unit-tested.

import type { Attack, Mode, NotRunResult } from "../types";

export const HARNESS_MISSING = "not run: agent harness not merged";

export type AttackRoute =
  | { route: "platform" } // no agent: the attacker talks to the platform/brain directly (webhook channel)
  | { route: "agent" }
  | { route: "not_run"; status: NotRunResult["status"]; reason: string };

export interface ClassifyInput {
  harnessAvailable: boolean;
  /** reasons prepare() cannot build the attack's setup (from unsupportedSetup) */
  setupProblems: string[];
}

export function classifyAttack(a: Attack, i: ClassifyInput): AttackRoute {
  const setup = i.setupProblems.length ? `setup unsupported: ${i.setupProblems.join("; ")}` : "";
  if (a.target === "platform" || a.channel === "webhook") {
    if (a.channel !== "webhook") return { route: "not_run", status: "not_run", reason: `no driver for platform-target attacks on the ${a.channel} channel` };
    if (setup) return { route: "not_run", status: "not_run", reason: `not run: ${setup}` };
    return { route: "platform" };
  }
  if (!i.harnessAvailable) {
    return { route: "not_run", status: "not_run", reason: setup ? `${HARNESS_MISSING}; also ${setup}` : HARNESS_MISSING };
  }
  if (setup) return { route: "not_run", status: "not_run", reason: `not run: ${setup}` };
  return { route: "agent" };
}

export function notRunRow(subject: NotRunResult["subject"], id: string, category: string, mode: Mode, status: NotRunResult["status"], reason: string): NotRunResult {
  return { kind: "not_run", subject, id, category, mode, status, reason };
}
