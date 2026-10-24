// Live AgentLlm: Claude Sonnet 5.5 through the shared Anthropic client (src/llm.ts createAnthropicClient,
// which adds the anthropic-workspace-id header when the key needs it).
//
// Model constraints this follows (verified against the API for claude-sonnet-5-5):
//   - tool_choice "auto" only (forced "tool"/"any" is a 400)
//   - no `thinking` param (disabled / budget_tokens are 400s; adaptive is the default), no sampling params
//   - no assistant prefill; output_config.effort is set explicitly
//   - no server-side fallback (it is not combinable with between_tools, and a refusal is handled by the loop)

import type Anthropic from "@anthropic-ai/sdk";
import { createAnthropicClient, MODELS } from "../llm";
import type { AgentLlm, AgentRequest, AgentResponse } from "./types";

export const AGENT_MODEL = MODELS.sonnet;

export class AnthropicAgentLlm implements AgentLlm {
  private readonly client: Anthropic;
  constructor(apiKey: string, workspaceId?: string) {
    this.client = createAnthropicClient(apiKey, workspaceId);
  }

  async create(req: AgentRequest): Promise<AgentResponse> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      tools: req.tools,
      tool_choice: { type: "auto" },
      output_config: { effort: req.effort },
      messages: req.messages,
    });
    return { content: res.content, stop_reason: res.stop_reason, stop_details: res.stop_details };
  }
}

export function agentLlmFromEnv(env: NodeJS.ProcessEnv = process.env): AgentLlm | undefined {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? new AnthropicAgentLlm(key, env.ANTHROPIC_WORKSPACE_ID?.trim() || undefined) : undefined;
}
