// Pure row classification for the real runner: which attacks run for real now, which wait for the agent
// harness, which cannot be set up. Deterministic; unit-tested.

import type { Attack, Mode, NotRunResult } from "../types";

export const HARNESS_MISSING = "not run: agent harness not merged";
export const PHONE_NOT_DRIVEN =
  "not run: phone channel. The phone line's LLM runs on Cartesia (Managed Agent) and calls the brain's webhook tools; the agent harness drives chat only and carries no caller ID, so running these turns as chat would not test the phone path";

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
  if (a.channel === "phone") return { route: "not_run", status: "not_run", reason: PHONE_NOT_DRIVEN };
  if (!i.harnessAvailable) {
    return { route: "not_run", status: "not_run", reason: setup ? `${HARNESS_MISSING}; also ${setup}` : HARNESS_MISSING };
  }
  if (setup) return { route: "not_run", status: "not_run", reason: `not run: ${setup}` };
  return { route: "agent" };
}

export function notRunRow(subject: NotRunResult["subject"], id: string, category: string, mode: Mode, status: NotRunResult["status"], reason: string): NotRunResult {
  return { kind: "not_run", subject, id, category, mode, status, reason };
}

/**
 * The attacker's turns as the agent receives them. No agent has a fetch tool, so for web_page attacks the
 * customer pastes the page (redteam README: "the harness pastes content into the conversation as the
 * customer's quote of the page"): the page text is appended to the first turn that names its URL.
 */
export function turnsFor(a: Attack): string[] {
  const page = a.setup?.webPage;
  if (a.channel !== "web_page" || !page) return a.turns;
  const i = Math.max(0, a.turns.findIndex((t) => t.includes(page.url)));
  return a.turns.map((t, j) => (j === i ? `${t}\n\nHere is what the page says (copied from ${page.url}):\n${page.content}` : t));
}
