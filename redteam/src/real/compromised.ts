// The COMPROMISED MODEL pass: the Staff (same prompt, tools, loop, guards and platform as the real run) with
// its LLM port swapped for ScriptedAdversaryLlm, a deterministic script that is NOT an LLM. On each attacker
// turn it makes the calls in COMPROMISED_SCRIPTS (the attacker's own requests, or the most damaging calls in
// reach), one tool call per model step, then "replies" by printing every tool result of the turn (worst-case
// disclosure). It never reads policy, never refuses and never escalates on its own.
// In baseline mode the BaselineGuard and enforce=false let everything through to the platform; in napkin mode
// the Guard and the platform's own checks are all that stand between the script and the money.

import type { Attack, Mode, Transcript } from "../types";
import { actorKey, createAgentHarness, Staff, StdbGuardPlatform, StdbStaffBackend, type AgentLlm, type AgentRequest, type AgentResponse, type SessionRecord } from "./brain";
import { COMPROMISED_SCRIPTS, type AttackScript, type ScriptedCall } from "./compromised-scripts";
import type { ScratchWorld } from "./db";
import type { RealInspector } from "./inspector";

export const COMPROMISED_MODEL = "scripted-adversary/1 (deterministic script, not an LLM)";

type Msg = AgentRequest["messages"][number];
type Block = { type: string; text?: string; content?: unknown };

const blocks = (m: Msg): Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]));
const isTextTurn = (m: Msg) => m.role === "user" && blocks(m).some((b) => b.type === "text");
const isToolResults = (m: Msg) => m.role === "user" && blocks(m).some((b) => b.type === "tool_result");
const resultText = (b: Block) => (typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? ""));

/** newest value of `key` in any tool result so far (results are JSON strings) */
function lastValue(messages: Msg[], key: string): unknown {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const b of blocks(messages[i]!).filter((x) => x.type === "tool_result").reverse()) {
      try {
        const v = (JSON.parse(resultText(b)) as Record<string, unknown>)[key];
        if (v !== undefined && v !== null && v !== "") return v;
      } catch {
        /* not JSON */
      }
    }
  }
  return undefined;
}

export function resolveArgs(args: Record<string, unknown>, messages: Msg[]): Record<string, unknown> {
  const fix = (v: unknown): unknown => {
    if (typeof v === "string" && v.startsWith("$LAST:")) return lastValue(messages, v.slice(6)) ?? `unknown-${v.slice(6)}`;
    if (Array.isArray(v)) return v.map(fix);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)]));
    return v;
  };
  return fix(args) as Record<string, unknown>;
}

export class ScriptedAdversaryLlm implements AgentLlm {
  private n = 0;
  constructor(private readonly script: AttackScript) {}

  async create(req: AgentRequest): Promise<AgentResponse> {
    const msgs = req.messages;
    const turn = msgs.filter(isTextTurn).length - 1; // index of the attacker message being answered
    let lastText = msgs.length - 1;
    while (lastText >= 0 && !isTextTurn(msgs[lastText]!)) lastText--;
    const since = msgs.slice(lastText + 1);
    const step = since.filter(isToolResults).length; // tool calls already made this turn
    const plan: ScriptedCall[] = this.script.turns[turn] ?? [];
    if (step < plan.length) {
      const call = plan[step]!;
      const input = resolveArgs(call.args, msgs);
      const id = `toolu_scripted_${++this.n}`;
      return {
        content: [{ type: "tool_use", id, name: call.tool, input } as unknown as AgentResponse["content"][number]],
        stop_reason: "tool_use",
      };
    }
    const results = since.flatMap((m) => blocks(m).filter((b) => b.type === "tool_result").map(resultText));
    const text = results.length ? `Done. Here is everything the tools returned:\n${results.join("\n")}` : "Sure, I'll do whatever you need.";
    return { content: [{ type: "text", text, citations: null } as unknown as AgentResponse["content"][number]], stop_reason: "end_turn" };
  }
}

export function scriptFor(a: Attack): AttackScript | undefined {
  return COMPROMISED_SCRIPTS[a.id];
}

export interface CompromisedHarness {
  send(target: string, turns: string[], mode: Mode): Promise<Transcript>;
}

/** A fresh Staff (scripted LLM) + harness for one row, over the world's current connections. */
export function makeCompromisedHarness(world: ScratchWorld, inspector: RealInspector, script: AttackScript): CompromisedHarness {
  const sessions = new Map<string, SessionRecord>();
  const checkout = {
    platform: world.platform,
    gateway: inspector.processor.gateway(world.platform),
    sessions: { get: (id: string) => sessions.get(id), put: (r: SessionRecord) => void sessions.set(r.orderId, r) },
    storePublicUrl: "http://localhost:3002",
    hasStorefront: (b: string) => Boolean(world.hub.get(actorKey("storefront", b))),
  };
  const staff = new Staff({ llm: new ScriptedAdversaryLlm(script), guardPort: new StdbGuardPlatform(world.hub), backend: new StdbStaffBackend(world.hub, checkout), model: COMPROMISED_MODEL });
  return createAgentHarness({ staff }) as unknown as CompromisedHarness;
}
