// The policy engine every agent tool call passes through:
//   LLM -> guard.check() -> (allowed) tool -> platform reducer (which re-checks the invariants)
// Every check writes exactly one DecisionRecord (allowed, refused and escalated alike) through the
// platform's recordDecision reducer; escalations also open an owner inbox item (or, for a verified
// phone owner asking for a config change, queue an owner statement for confirmation in the app).
// Fail-closed: if the decision cannot be recorded, the call is not allowed.

import { createHash } from "node:crypto";
import type { Configuration } from "@napkin/schema";
import { log } from "../log";
import { evaluate, type Evaluation } from "./rules";
import { TOOLS } from "./tools";
import type { DocumentMeta, GuardCall, GuardDecision, GuardWorld, PrecedentRow, RefundFacts } from "./types";

export * from "./types";
export { evaluate, maxDiscountRate, PrecedentCondition } from "./rules";
export { TOOLS, CONFIG_CHANGE_TOOLS } from "./tools";

export interface DecisionWrite {
  businessId: string;
  action: string;
  documentRef: string;
  ruleIds: string[];
  evidenceRefs: string[];
  inputsHash: string;
  outcome: "allowed" | "refused" | "escalated";
  reason: string;
  wouldChangeIf: string;
}

export interface GuardPlatformPort {
  activeConfiguration(businessId: string): { configId: string; config: Configuration } | undefined;
  precedents(businessId: string): PrecedentRow[];
  refundFacts(businessId: string, orderId: string): RefundFacts | undefined;
  documentMeta(businessId: string, documentId: string): DocumentMeta | undefined;
  /** written as the actor's own platform identity when the brain holds it, else as system */
  recordDecision(asRole: string, d: DecisionWrite): Promise<void>;
  openInbox(asRole: string, i: { businessId: string; question: string; contextJson: string; documentRef: string }): Promise<void>;
  queueOwnerStatement(s: { businessId: string; channel: "phone"; text: string; diffJson: string }): Promise<void>;
}

export class GuardUnavailable extends Error {
  override name = "GuardUnavailable";
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  return typeof v === "bigint" ? v.toString() : v;
}
export const hashInputs = (call: GuardCall) => createHash("sha256").update(JSON.stringify(canonical(call))).digest("hex");

const str = (v: unknown, max = 64) => (typeof v === "string" ? v.slice(0, max) : typeof v === "number" ? String(v) : "");

export class Guard {
  constructor(private readonly platform: GuardPlatformPort) {}

  /** Loads the world for a call: active configuration, precedents and only the facts this tool needs. */
  world(call: GuardCall): GuardWorld | undefined {
    const active = this.platform.activeConfiguration(call.businessId);
    if (!active) return undefined;
    const args = (call.args ?? {}) as Record<string, unknown>;
    const fam = Object.hasOwn(TOOLS, call.tool) ? TOOLS[call.tool]!.family : undefined;
    return {
      configId: active.configId,
      config: active.config,
      precedents: this.platform.precedents(call.businessId),
      refundFacts: fam === "refund" && typeof args["orderId"] === "string" ? this.platform.refundFacts(call.businessId, args["orderId"]) : undefined,
      document: fam === "approve_refund" && typeof args["documentId"] === "string" ? this.platform.documentMeta(call.businessId, args["documentId"]) : undefined,
    };
  }

  async check(call: GuardCall): Promise<GuardDecision> {
    const inputsHash = hashInputs(call);
    let ev: Evaluation;
    try {
      ev = evaluate(call, this.world(call));
    } catch (e) {
      ev = { allow: false, outcome: "refused", ruleIds: ["guard_error"], reason: `guard error (fail closed): ${(e as Error).message}`, wouldChangeIf: null, evidenceRefs: [] };
    }
    const args = (call.args ?? {}) as Record<string, unknown>;
    const documentRef = str(args["orderId"]) || str(args["documentId"]) || str(args["documentRef"]);
    const decision: GuardDecision = { ...ev, inputsHash };

    if (decision.outcome === "escalated") {
      const summary = `${call.actor.role} wants ${call.tool} ${JSON.stringify(ev.checkedArgs ?? {}).slice(0, 300)}`;
      decision.escalation = TOOLS[call.tool]?.family === "config_change" && call.provenance.source === "owner_phone_verified"
        ? { kind: "owner_statement", text: call.provenance.text?.slice(0, 2000) || summary, diff: { tool: call.tool, args: ev.checkedArgs } }
        : { kind: "inbox", question: `${summary}. ${ev.reason}` };
    }

    try {
      await this.platform.recordDecision(call.actor.role, {
        businessId: call.businessId,
        action: call.tool.slice(0, 64),
        documentRef,
        ruleIds: decision.ruleIds,
        evidenceRefs: decision.evidenceRefs,
        inputsHash,
        outcome: decision.outcome,
        reason: decision.reason.slice(0, 1000),
        wouldChangeIf: decision.wouldChangeIf ?? "",
      });
    } catch (e) {
      throw new GuardUnavailable(`could not record the decision (call not allowed): ${(e as Error).message}`);
    }

    const esc = decision.escalation;
    try {
      if (esc?.kind === "inbox") {
        await this.platform.openInbox(call.actor.role, {
          businessId: call.businessId,
          question: esc.question,
          contextJson: JSON.stringify({ tool: call.tool, args: ev.checkedArgs ?? null, ruleIds: decision.ruleIds, maxAllowed: decision.maxAllowed ?? null, inputsHash }),
          documentRef,
        });
      } else if (esc?.kind === "owner_statement") {
        await this.platform.queueOwnerStatement({ businessId: call.businessId, channel: "phone", text: esc.text, diffJson: JSON.stringify(esc.diff) });
      }
    } catch (e) {
      log.error("guard", `escalation for ${call.tool} could not be delivered: ${(e as Error).message}`);
      decision.reason += `; (escalation not delivered: ${(e as Error).message})`;
    }
    return decision;
  }
}

export type GuardedResult<R> = { ok: true; result: R; decision: GuardDecision } | { ok: false; decision: GuardDecision };
export type ToolFn<A, R> = ((args: A, decision: GuardDecision) => Promise<R>) & { toolName?: string };

/**
 * Wrap a tool so it can only run after the guard allows it. The tool receives the guard's parsed args
 * (unknown keys stripped), never the raw LLM output. Refused/escalated calls never reach the tool.
 */
export function wrapTool<A, R>(toolFn: ToolFn<A, R>, guard: Pick<Guard, "check">, toolName = toolFn.toolName ?? toolFn.name) {
  if (!Object.hasOwn(TOOLS, toolName)) throw new Error(`wrapTool: "${toolName}" is not a registered tool`);
  return async (call: Omit<GuardCall, "tool">): Promise<GuardedResult<R>> => {
    const decision = await guard.check({ ...call, tool: toolName });
    if (!decision.allow) return { ok: false, decision };
    return { ok: true, result: await toolFn(decision.checkedArgs as A, decision), decision };
  };
}
