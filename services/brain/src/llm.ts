// Thin LLM port. The AI reads, parses and phrases; deterministic code decides. Unit tests inject a fake Llm.

import Anthropic from "@anthropic-ai/sdk";

export const MODELS = {
  /** intake, interview/statement parsing */
  opus: "claude-opus-5-5",
  /** question phrasing (classification-grade) */
  haiku: "claude-haiku-5-5",
} as const;

export type UserContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; base64: string };

export interface ToolRequest {
  model: string;
  system: string;
  content: UserContent[];
  toolName: string;
  toolDescription: string;
  /** JSON Schema of the structured output. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface Llm {
  /** Returns one object shaped by `schema` (unvalidated: callers parse it with zod). */
  tool(req: ToolRequest): Promise<unknown>;
  text(req: { model: string; system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class LlmUnavailable extends Error {
  override name = "LlmUnavailable";
}

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`); Haiku has none. */
const FALLBACK_MODELS = new Set<string>([MODELS.opus]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;
  constructor(apiKey: string, workspaceId?: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 300_000, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  // Current models reject a forced tool_choice ("tool"/"any"), so the tool is offered with tool_choice auto and
  // the system prompt says to call it. Callers validate the input with zod and retry; no tool call is an error.
  async tool(req: ToolRequest): Promise<unknown> {
    const fallback = FALLBACK_MODELS.has(req.model);
    const res = await this.client.beta.messages
      .stream({
        model: req.model,
        // thinking is always on for these models and counts against max_tokens, so leave headroom
        max_tokens: Math.max(req.maxTokens ?? 0, 16_000),
        system: `${req.system}\n\nRecord your answer by calling the ${req.toolName} tool exactly once. Do not answer in plain text.`,
        output_config: { effort: "medium" },
        tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema as Anthropic.Beta.BetaTool.InputSchema }],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
        messages: [
          {
            role: "user",
            content: req.content.map((c) =>
              c.type === "text"
                ? { type: "text" as const, text: c.text }
                : { type: "image" as const, source: { type: "base64" as const, media_type: c.mediaType, data: c.base64 } },
            ),
          },
        ],
      })
      .finalMessage();
    if (res.stop_reason === "refusal") throw new LlmUnavailable(`model declined to produce ${req.toolName} (${res.stop_details?.category ?? "no category"})`);
    if (res.stop_reason === "max_tokens") throw new LlmUnavailable(`${req.toolName} was cut off at max_tokens`);
    const block = res.content.find((b) => b.type === "tool_use" && b.name === req.toolName);
    if (!block || block.type !== "tool_use") throw new LlmUnavailable(`model returned no ${req.toolName} tool call (stop_reason ${res.stop_reason})`);
    return block.input;
  }

  async text(req: { model: string; system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await this.client.messages.create({
      model: req.model,
      // adaptive thinking is on by default and shares this budget; low effort keeps short phrasing short
      max_tokens: Math.max(req.maxTokens ?? 0, 2_000),
      output_config: { effort: "low" },
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    if (res.stop_reason === "refusal") throw new LlmUnavailable("model declined to answer");
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
}

/** Reads ANTHROPIC_API_KEY (and optional ANTHROPIC_WORKSPACE_ID, needed for keys not scoped to a workspace); undefined when absent (routes answer 503, nothing is faked). */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): Llm | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? new AnthropicLlm(key, env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined) : undefined;
}
