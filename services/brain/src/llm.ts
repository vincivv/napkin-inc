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
  /** JSON Schema of the structured output (the tool input). */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

export interface Llm {
  /** Forces one tool call and returns its (unvalidated) input object. */
  tool(req: ToolRequest): Promise<unknown>;
  text(req: { model: string; system: string; user: string; maxTokens?: number }): Promise<string>;
}

export class LlmUnavailable extends Error {
  override name = "LlmUnavailable";
}

export class AnthropicLlm implements Llm {
  private readonly client: Anthropic;
  constructor(apiKey: string, workspaceId?: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  async tool(req: ToolRequest): Promise<unknown> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 4096,
      system: req.system,
      tools: [{ name: req.toolName, description: req.toolDescription, input_schema: req.schema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: req.toolName },
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
    });
    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") throw new LlmUnavailable(`model returned no ${req.toolName} tool call (stop_reason ${res.stop_reason})`);
    return block.input;
  }

  async text(req: { model: string; system: string; user: string; maxTokens?: number }): Promise<string> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens ?? 300,
      system: req.system,
      messages: [{ role: "user", content: req.user }],
    });
    return res.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
  }
}

/** Reads ANTHROPIC_API_KEY (and optional ANTHROPIC_WORKSPACE_ID, needed for keys not scoped to a workspace); undefined when absent (routes answer 503, nothing is faked). */
export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): Llm | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? new AnthropicLlm(key, env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined) : undefined;
}
