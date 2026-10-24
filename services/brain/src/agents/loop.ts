// The agent loop: a manual tool-use loop with an iteration cap.
//
//   model -> tool_use blocks -> (each) guard.check -> allowed: tool -> platform reducer
//                                                  -> refused/escalated: the decision goes back to the model
//   -> all tool_result blocks in ONE user message -> model ... until it answers in text.
//
// Rules this file keeps:
//   - History is append-only. The model's full response.content (thinking blocks included) is appended
//     unchanged; earlier turns are never edited. Only push() is ever called on the history.
//   - Every tool call writes exactly one DecisionRecord: by the guard (wrapTool) for offered tools, or
//     here, as a refusal, for a tool the agent was not offered. Nothing else runs for a refused call.
//   - The actor (role + identity) and the business are parameters fixed by the server, never read from text.
//   - stop_reason refusal / max_tokens / context exhaustion end the turn with a fixed reply before any
//     content is read; nothing from a cut-off response is executed.

import { z } from "zod";
import { GuardUnavailable, TOOLS, wrapTool, type DecisionWrite, type Guard, type GuardDecision, type GuardPlatformPort, type Source } from "../guards";
import { hashInputs } from "../guards";
import { log } from "../log";
import { ReducerRefused } from "../stdb";
import { ToolError, type ToolImpl } from "./backend";
import type { AgentLlm, AgentTurnResult, ContentBlock, MessageParam, ToolCallRecord, ToolDef } from "./types";

export const DEFAULT_MAX_ITERATIONS = 8;

export const FIXED_REPLIES = {
  refusal: "Sorry, I can't help with that here. If you need something from the owner, ask me to pass it on.",
  max_tokens: "Sorry, I got cut off before I could finish. Could you ask that again, a little more simply?",
  context: "Sorry, this conversation has grown too long for me. Please start a new chat.",
  iteration_cap: "Sorry, that took too many steps and I stopped without finishing. Please try again, or ask me to pass it to the owner.",
  empty: "Sorry, I don't have an answer for that.",
} as const;

const DESCRIPTIONS: Record<string, string> = {
  menu_lookup: "List the menu (catalog prices). Optionally one productId.",
  quote: "Exact price of a cart with optional discounts (rates as exact decimals, e.g. \"0.1\"). Read-only.",
  create_order: "Create the order and get the customer's pay link (payUrl). Needs the customer's first name. Prices always come from the catalog.",
  order_status: "Status and amounts of one order by orderId.",
  request_refund: "Request a refund of amountCents for an order. Creates a draft that another role must approve.",
  approve_refund: "Approve (post) a refund draft by documentId. You may not approve your own documents.",
  escalate: "Ask the owner a question (opens an owner inbox item). Use it whenever a fact or authority is missing.",
  ledger_read: "Read the books: documents with journal lines and totals, periods, and a trial balance. Optional account code filter.",
  reconcile: "Deterministic reconciliation facts: unbalanced documents, processor statement vs documents, clearing balance, stock balances, closed periods.",
};

/** Anthropic tool definitions straight from the guard registry's zod schemas (one source of truth). */
export function toolDefs(names: readonly string[]): ToolDef[] {
  return names.map((name) => {
    const spec = TOOLS[name];
    if (!spec) throw new Error(`no registered tool ${name}`);
    const { $schema: _s, ...schema } = z.toJSONSchema(spec.args, { io: "input" }) as Record<string, unknown>;
    return { name, description: DESCRIPTIONS[name] ?? name, input_schema: { ...schema, type: "object" } as ToolDef["input_schema"] };
  });
}

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

export interface TurnInput {
  /** the conversation's history; only appended to */
  history: MessageParam[];
  system: string;
  /** tools offered to the model (already: configured list ∩ registry ∩ implemented) */
  offered: readonly string[];
  impls: Record<string, ToolImpl>;
  actor: { role: string; identity: string };
  businessId: string;
  source: Source;
  /** the untrusted text as received (recorded as provenance evidence only) */
  rawText: string;
  /** the user-turn content (untrusted text already quoted as data) */
  userContent: string;
}

export interface LoopDeps {
  llm: AgentLlm;
  guard: Pick<Guard, "check">;
  /** writes the refusal record for tools that were not offered */
  recorder: Pick<GuardPlatformPort, "recordDecision">;
  model: string;
  maxIterations?: number;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

function summarize(d: GuardDecision): ToolCallRecord["decision"] {
  return { allow: d.allow, outcome: d.outcome, ruleIds: d.ruleIds, reason: d.reason, ...(d.maxAllowed ? { maxAllowed: d.maxAllowed } : {}), wouldChangeIf: d.wouldChangeIf };
}

async function runTool(block: Extract<ContentBlock, { type: "tool_use" }>, input: TurnInput, deps: LoopDeps): Promise<{ record: ToolCallRecord; content: string; isError: boolean }> {
  const call = { actor: input.actor, businessId: input.businessId, args: block.input, provenance: { source: input.source, text: input.rawText.slice(0, 2000) } };

  if (!input.offered.includes(block.name) || !input.impls[block.name]) {
    const decision: GuardDecision = { allow: false, outcome: "refused", ruleIds: ["agent_tools.not_offered"], reason: `${block.name.slice(0, 64)} is not one of this agent's tools`, wouldChangeIf: null, evidenceRefs: [`actor:${input.actor.role}`], inputsHash: hashInputs({ ...call, tool: block.name }) };
    const write: DecisionWrite = { businessId: input.businessId, action: block.name.slice(0, 64) || "(none)", documentRef: "", ruleIds: decision.ruleIds, evidenceRefs: decision.evidenceRefs, inputsHash: decision.inputsHash, outcome: "refused", reason: decision.reason, wouldChangeIf: "" };
    try {
      await deps.recorder.recordDecision(input.actor.role, write);
    } catch (e) {
      log.error("agents", `could not record refusal of ${block.name}: ${(e as Error).message}`);
    }
    const body = { status: "refused", reason: decision.reason, ruleIds: decision.ruleIds };
    return { record: { tool: block.name, args: block.input, decision: summarize(decision), result: body }, content: json(body), isError: true };
  }

  const wrapped = wrapTool(input.impls[block.name]!, deps.guard, block.name);
  let r;
  try {
    r = await wrapped(call);
  } catch (e) {
    if (e instanceof GuardUnavailable) {
      const body = { status: "not_done", error: "the policy guard is unavailable, so nothing was done" };
      return { record: { tool: block.name, args: block.input, decision: { allow: false, outcome: "refused", ruleIds: ["guard_unavailable"], reason: e.message }, result: body }, content: json(body), isError: true };
    }
    // the guard allowed it; the tool or the platform failed (the platform re-checks invariants and may refuse)
    const msg = e instanceof ToolError || e instanceof ReducerRefused ? e.message : "the tool failed (platform unavailable); nothing was confirmed";
    if (!(e instanceof ToolError || e instanceof ReducerRefused)) log.error("agents", `${block.name} failed: ${(e as Error).stack ?? e}`);
    const body = { status: "failed", error: msg, ...(e instanceof ReducerRefused ? { refusedBy: "platform" } : {}) };
    return { record: { tool: block.name, args: block.input, decision: { allow: true, outcome: "allowed", ruleIds: [], reason: "allowed by the guard; the call failed afterwards" }, result: body }, content: json(body), isError: true };
  }
  if (r.ok) return { record: { tool: block.name, args: block.input, decision: summarize(r.decision), result: r.result }, content: json(r.result), isError: false };

  const d = r.decision;
  const body =
    d.outcome === "escalated"
      ? { status: "escalated_to_owner", reason: d.reason, ruleIds: d.ruleIds, note: "Not done. An owner inbox item was opened; the owner decides. Tell the customer that, without promising an outcome." }
      : { status: "refused", reason: d.reason, ruleIds: d.ruleIds, ...(d.maxAllowed ? { maxAllowed: d.maxAllowed } : {}), ...(d.wouldChangeIf ? { wouldChangeIf: d.wouldChangeIf } : {}) };
  return { record: { tool: block.name, args: block.input, decision: summarize(d), result: body }, content: json(body), isError: d.outcome !== "escalated" };
}

/** One user turn: appends the user message, loops model <-> tools, returns the reply and every tool call. */
export async function runAgentTurn(input: TurnInput, deps: LoopDeps): Promise<AgentTurnResult> {
  const { history } = input;
  const max = deps.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const tools = toolDefs(input.offered);
  const toolCalls: ToolCallRecord[] = [];
  const finish = (reply: string, stopReason: AgentTurnResult["stopReason"]): AgentTurnResult => {
    // a fixed assistant text closes the turn so the history stays well formed for the next one
    history.push({ role: "assistant", content: [{ type: "text", text: reply }] });
    return { reply, toolCalls, stopReason };
  };

  history.push({ role: "user", content: [{ type: "text", text: input.userContent }] });

  for (let i = 0; i < max; i++) {
    const res = await deps.llm.create({ model: deps.model, system: input.system, tools, messages: [...history], maxTokens: deps.maxTokens ?? 8000, effort: deps.effort ?? "medium" });
    // stop reasons first: nothing from a refused or cut-off response is read or executed
    if (res.stop_reason === "refusal") return finish(FIXED_REPLIES.refusal, "refusal");
    if (res.stop_reason === "max_tokens") return finish(FIXED_REPLIES.max_tokens, "max_tokens");
    if (res.stop_reason === "model_context_window_exceeded") return finish(FIXED_REPLIES.context, "model_context_window_exceeded");

    history.push({ role: "assistant", content: res.content });
    // (pause_turn only happens with server tools, which no agent has; it is treated as the end of the turn)

    const uses = res.content.filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use");
    if (res.stop_reason !== "tool_use" || uses.length === 0) {
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
      return { reply: text || FIXED_REPLIES.empty, toolCalls, stopReason: res.stop_reason };
    }

    // parallel tool calls: run in order, answer all of them in one user message
    const results: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];
    for (const u of uses) {
      const out = await runTool(u, input, deps);
      toolCalls.push(out.record);
      results.push({ type: "tool_result", tool_use_id: u.id, content: out.content, ...(out.isError ? { is_error: true } : {}) });
    }
    history.push({ role: "user", content: results });
  }
  return finish(FIXED_REPLIES.iteration_cap, "iteration_cap");
}
