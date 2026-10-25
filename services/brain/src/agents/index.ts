// M3: the AI staff (Shopkeeper, Support, Bookkeeper). See services/brain/README.md "Agents".

import type { Hono } from "hono";
import { StdbGuardPlatform } from "../guards/platform";
import type { PlatformPort } from "../platform";
import type { CheckoutDeps } from "../payments/checkout";
import { actorKey, type StdbHub } from "../stdb";
import { agentLlmFromEnv } from "./llm";
import { agentRoutes, type AgentRouteGuards } from "./routes";
import { BookkeeperReview, reviewConfigFromEnv, ReviewScheduler } from "./review";
import { Staff } from "./staff";
import { StdbStaffBackend } from "./stdb-backend";

export * from "./types";
export { Staff, StaffError, ConversationStore } from "./staff";
export { createAgentHarness, HARNESS_BUSINESSES } from "./harness";
export { agentRoutes, type AgentRouteGuards } from "./routes";
export { runAgentTurn, toolDefs, FIXED_REPLIES } from "./loop";
export { BaselineGuard } from "./baseline";
export { buildSystemPrompt, quoteUntrusted } from "./prompt";
export { toolImpls, quote, menu, type StaffBackend } from "./backend";
export { reconcile, ledgerRead, parseFindings, bookSetFromPlanted, FINDING_KINDS, type BookSet, type Finding } from "./books";
export { AnthropicAgentLlm, agentLlmFromEnv, AGENT_MODEL } from "./llm";
export { StdbStaffBackend } from "./stdb-backend";
export { BookkeeperReview, ReviewScheduler, reviewConfigFromEnv, reviewFindings, reviewQuestion, fingerprint, type ReviewFinding, type ReviewOutcome } from "./review";

/** Live wiring: the staff over the brain's SpacetimeDB identities. Undefined without ANTHROPIC_API_KEY. */
export function createLiveStaff(hub: StdbHub, checkout: CheckoutDeps): Staff | undefined {
  const llm = agentLlmFromEnv();
  return llm ? new Staff({ llm, guardPort: new StdbGuardPlatform(hub), backend: new StdbStaffBackend(hub, checkout) }) : undefined;
}

/** Mounts POST /agents/:role/message and POST /ask (one line in server.ts). */
export function mountAgents(app: Hono, hub: StdbHub, checkout: Omit<CheckoutDeps, "platform"> & { platform: PlatformPort }, guards: AgentRouteGuards = {}): Staff | undefined {
  const staff = createLiveStaff(hub, checkout);
  app.route("/", agentRoutes(() => staff, guards));
  return staff;
}

/**
 * Live automatic Bookkeeper review (src/agents/review.ts): every live, enforced business where the brain
 * holds a bookkeeper identity, on a timer and after new documents. Call start() once the platform is up.
 */
export function createLiveBookkeeperReview(hub: StdbHub, checkout: CheckoutDeps, env: NodeJS.ProcessEnv = process.env): ReviewScheduler {
  const review = new BookkeeperReview({ guardPort: new StdbGuardPlatform(hub), backend: new StdbStaffBackend(hub, checkout) });
  const db = () => {
    const s = hub.get("system");
    return s?.connected() ? s.conn.db : undefined;
  };
  return new ReviewScheduler(
    {
      review: (id) => review.review(id),
      businesses: () => {
        const d = db();
        if (!d) return [];
        return [...d.business.iter()].filter((b) => b.activeConfigId > 0n && b.enforce && hub.get(actorKey("bookkeeper", b.id))).map((b) => b.id);
      },
      signature: (id) => {
        const d = db();
        if (!d) return undefined;
        let n = 0;
        let newest = 0n;
        for (const doc of d.document.businessId.filter(id)) {
          if (doc.status === "draft") continue;
          n++;
          if (doc.id > newest) newest = doc.id;
        }
        return `${n}:${newest}`;
      },
    },
    reviewConfigFromEnv(env),
  );
}
