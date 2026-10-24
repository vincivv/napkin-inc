// Red-team harness: implements redteam/src/run.ts `AgentHarness`
//   send(target, turns, mode) -> Transcript
// mode "napkin"   -> business maya-cookies, guards on (wrapTool + Guard)
// mode "baseline" -> business maya-cookies-baseline, the SAME prompt and tools with no guard checks
//                    (BaselineGuard); the platform's enforce=false means no policy checks there either.
// DecisionRecords are written in both modes. Types are structural copies of redteam/src/types.ts
// (Transcript, Mode, Target) so the brain does not depend on the redteam package; a test pins them.
//
// Also: audit(set, mode) runs the Bookkeeper on a PROVIDED book set (redteam/planted) and returns
// findings in the scorer's format ({kind, entries, note}).

import { randomUUID } from "node:crypto";
import { bookSetFromPlanted, type BookDoc, type Finding, type StatementEvent } from "./books";
import type { Staff } from "./staff";
import { isStaffRole, type Mode } from "./types";

export type HarnessTarget = "shopkeeper" | "support" | "bookkeeper" | "platform";

export interface HarnessToolCall {
  tool: string;
  args: Record<string, unknown>;
  allowed: boolean;
  ruleIds: string[];
  result?: unknown;
}

export interface HarnessTranscript {
  turns: { role: "attacker" | "agent" | "system"; text: string }[];
  toolCalls: HarnessToolCall[];
  error?: string;
}

export interface AgentHarnessDeps {
  staff: Staff;
  businessIds?: Record<Mode, string>;
  newConversationId?: () => string;
}

export const HARNESS_BUSINESSES: Record<Mode, string> = { napkin: "maya-cookies", baseline: "maya-cookies-baseline" };

export interface PlantedBooksInput {
  id: string;
  documents: BookDoc[];
  periods: { month: string; status: string; closedAt?: string | null }[];
  processorStatement: StatementEvent[];
}

export function createAgentHarness(deps: AgentHarnessDeps) {
  const ids = deps.businessIds ?? HARNESS_BUSINESSES;
  const newId = deps.newConversationId ?? (() => `rt-${randomUUID().slice(0, 18)}`);

  return {
    async send(target: HarnessTarget, turns: string[], mode: Mode): Promise<HarnessTranscript> {
      const t: HarnessTranscript = { turns: [], toolCalls: [] };
      if (!isStaffRole(target)) {
        t.error = `target "${target}" is not an agent (platform attacks go to the platform directly, not through AgentHarness)`;
        return t;
      }
      const conversationId = newId();
      for (const text of turns) {
        t.turns.push({ role: "attacker", text });
        try {
          const r = await deps.staff.message({ role: target, businessId: ids[mode], conversationId, text, mode });
          t.turns.push({ role: "agent", text: r.reply });
          for (const c of r.toolCalls) {
            t.toolCalls.push({
              tool: c.tool,
              args: c.args && typeof c.args === "object" && !Array.isArray(c.args) ? (c.args as Record<string, unknown>) : { value: c.args },
              allowed: c.decision.allow,
              ruleIds: c.decision.ruleIds,
              result: c.result,
            });
          }
          if (r.stopReason !== "end_turn" && r.stopReason !== "tool_use") t.turns.push({ role: "system", text: `turn ended: ${r.stopReason}` });
        } catch (e) {
          t.error = `${(e as Error).name}: ${(e as Error).message}`;
          break;
        }
      }
      return t;
    },

    /** The Bookkeeper audits a provided book set (answer key never shown to it). */
    async audit(set: PlantedBooksInput, mode: Mode = "napkin"): Promise<{ findings: Finding[]; reply: string; toolCalls: HarnessToolCall[]; error?: string }> {
      try {
        const r = await deps.staff.audit(bookSetFromPlanted({ ...set, periods: set.periods }), { businessId: ids[mode], mode });
        return { findings: r.findings, reply: r.reply, toolCalls: r.toolCalls.map((c) => ({ tool: c.tool, args: (c.args ?? {}) as Record<string, unknown>, allowed: c.decision.allow, ruleIds: c.decision.ruleIds })) };
      } catch (e) {
        return { findings: [], reply: "", toolCalls: [], error: `${(e as Error).name}: ${(e as Error).message}` };
      }
    },
  };
}

export type AgentHarnessImpl = ReturnType<typeof createAgentHarness>;
