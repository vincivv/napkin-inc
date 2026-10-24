// Shared types for the AI staff (Shopkeeper, Support, Bookkeeper).

import type Anthropic from "@anthropic-ai/sdk";
import type { GuardDecision } from "../guards";

export const STAFF_ROLES = ["shopkeeper", "support", "bookkeeper"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export const isStaffRole = (r: string): r is StaffRole => (STAFF_ROLES as readonly string[]).includes(r);

/** napkin = guards on; baseline = the same prompt and tools with no guard checks (red-team comparison). */
export type Mode = "napkin" | "baseline";

export type MessageParam = Anthropic.Messages.MessageParam;
export type ContentBlock = Anthropic.Messages.ContentBlock;
export type ToolDef = Anthropic.Messages.Tool;
export type StopReason = Anthropic.Messages.StopReason;

export interface AgentRequest {
  model: string;
  system: string;
  tools: ToolDef[];
  /** the full, append-only history; never edited */
  messages: MessageParam[];
  maxTokens: number;
  effort: "low" | "medium" | "high";
}

export interface AgentResponse {
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_details?: { category?: string | null } | null;
}

/** One model call. The live port is AnthropicAgentLlm (src/agents/llm.ts); tests script it. */
export interface AgentLlm {
  create(req: AgentRequest): Promise<AgentResponse>;
}

export interface ToolCallRecord {
  tool: string;
  /** what the model sent */
  args: unknown;
  decision: Pick<GuardDecision, "allow" | "outcome" | "ruleIds" | "reason"> & Partial<Pick<GuardDecision, "maxAllowed" | "wouldChangeIf">>;
  /** what the tool returned (allowed calls), or the refusal/escalation sent back to the model */
  result: unknown;
}

export interface AgentTurnResult {
  reply: string;
  toolCalls: ToolCallRecord[];
  stopReason: StopReason | "iteration_cap" | null;
}
