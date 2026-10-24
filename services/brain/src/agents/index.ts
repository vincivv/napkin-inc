// M3: the AI staff (Shopkeeper, Support, Bookkeeper). See services/brain/README.md "Agents".

import type { Hono } from "hono";
import { StdbGuardPlatform } from "../guards/platform";
import type { PlatformPort } from "../platform";
import type { CheckoutDeps } from "../payments/checkout";
import type { StdbHub } from "../stdb";
import { agentLlmFromEnv } from "./llm";
import { agentRoutes } from "./routes";
import { Staff } from "./staff";
import { StdbStaffBackend } from "./stdb-backend";

export * from "./types";
export { Staff, StaffError, ConversationStore } from "./staff";
export { createAgentHarness, HARNESS_BUSINESSES } from "./harness";
export { runAgentTurn, toolDefs, FIXED_REPLIES } from "./loop";
export { BaselineGuard } from "./baseline";
export { buildSystemPrompt, quoteUntrusted } from "./prompt";
export { toolImpls, quote, menu, type StaffBackend } from "./backend";
export { reconcile, ledgerRead, parseFindings, bookSetFromPlanted, FINDING_KINDS, type BookSet, type Finding } from "./books";
export { AnthropicAgentLlm, agentLlmFromEnv, AGENT_MODEL } from "./llm";
export { StdbStaffBackend } from "./stdb-backend";

/** Live wiring: the staff over the brain's SpacetimeDB identities. Undefined without ANTHROPIC_API_KEY. */
export function createLiveStaff(hub: StdbHub, checkout: CheckoutDeps): Staff | undefined {
  const llm = agentLlmFromEnv();
  return llm ? new Staff({ llm, guardPort: new StdbGuardPlatform(hub), backend: new StdbStaffBackend(hub, checkout) }) : undefined;
}

/** Mounts POST /agents/:role/message and POST /ask (one line in server.ts). */
export function mountAgents(app: Hono, hub: StdbHub, checkout: Omit<CheckoutDeps, "platform"> & { platform: PlatformPort }): Staff | undefined {
  const staff = createLiveStaff(hub, checkout);
  app.route("/", agentRoutes(() => staff));
  return staff;
}
