// HTTP routes for the AI staff.
//   POST /agents/:role/message {businessId, conversationId, text} -> {reply, toolCalls:[{tool,args,decision,result}]}
//   POST /ask {businessId, question} -> {answer, refs, unverifiedRefs, toolCalls}
// The role comes from the path and is checked against the three staff roles; nothing in the body can
// change it. Without ANTHROPIC_API_KEY the routes answer 503 (nothing is faked).
// The Bookkeeper and /ask read the books, so they are owner-only (the account gate). Shopkeeper and Support
// are the storefront's customer chat: public, but rate-limited per caller and overall (each turn costs
// model calls).

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import { CheckoutError } from "../payments/checkout";
import { PlatformUnavailable, ReducerRefused } from "../stdb";
import { GuardUnavailable } from "../guards";
import type { RateLimiter } from "../auth";
import { log } from "../log";
import { StaffError, type Staff } from "./staff";
import { isStaffRole, type AgentTurnResult } from "./types";

const BusinessId = z.string().regex(/^[a-z0-9-]{1,64}$/);
const MessageBody = z.object({ businessId: BusinessId, conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().min(1).max(4000) });
const AskBody = z.object({ businessId: BusinessId, question: z.string().min(1).max(2000) });

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const out = (r: AgentTurnResult) => ({ reply: r.reply, toolCalls: r.toolCalls, stopReason: r.stopReason });

export type AgentRouteGuards = {
  /** Runs before owner-only routes (Bookkeeper, /ask): the signed-in account must own body.businessId. */
  ownerGate?: MiddlewareHandler;
  /** Limits for the public customer chat (Shopkeeper, Support). */
  customerLimits?: { perClient: RateLimiter; global: RateLimiter; clientKey: (c: Context) => string };
};

export function agentRoutes(staff: () => Staff | undefined, guards: AgentRouteGuards = {}): Hono {
  const app = new Hono();
  const ownerOnly: MiddlewareHandler = (c, next) => (guards.ownerGate ? guards.ownerGate(c, next) : next());
  const byRole: MiddlewareHandler = async (c, next) => {
    if (c.req.param("role") === "bookkeeper") return ownerOnly(c, next);
    const l = guards.customerLimits;
    if (l) {
      // one caller over its limit is refused before it can use up the shared global budget
      let r = l.perClient.hit(l.clientKey(c));
      if (r.allowed) r = l.global.hit("*");
      if (!r.allowed) {
        c.header("Retry-After", String(r.retryAfterSeconds));
        return c.json({ error: "the shop's assistant is busy, please try again in a few minutes" }, 429);
      }
    }
    return next();
  };

  app.onError((err, c) => {
    if (err instanceof StaffError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    if (err instanceof PlatformUnavailable || err instanceof GuardUnavailable) return c.json({ error: `platform unavailable: ${err.message}` }, 503);
    if (err instanceof ReducerRefused || err instanceof CheckoutError) return c.json({ error: err.message }, 422);
    log.error("agents", `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: "agent error" }, 502);
  });

  app.post("/agents/:role/message", byRole, async (c) => {
    const role = c.req.param("role");
    if (!isStaffRole(role)) return c.json({ error: `unknown agent role "${role.slice(0, 32)}" (shopkeeper, support, bookkeeper)` }, 404);
    const s = staff();
    if (!s) return c.json({ error: "AI staff unavailable: ANTHROPIC_API_KEY is not set" }, 503);
    const body = MessageBody.parse(await c.req.json());
    const r = await s.message({ role, ...body });
    log.info("agents", `${role}@${body.businessId} ${body.conversationId}: ${r.toolCalls.map((t) => `${t.tool}:${t.decision.outcome}`).join(", ") || "no tools"} (${r.stopReason})`);
    return c.json(jsonSafe(out(r)) as Record<string, unknown>);
  });

  app.post("/ask", ownerOnly, async (c) => {
    const s = staff();
    if (!s) return c.json({ error: "AI staff unavailable: ANTHROPIC_API_KEY is not set" }, 503);
    const body = AskBody.parse(await c.req.json());
    const r = await s.ask(body);
    return c.json(jsonSafe({ answer: r.answer, refs: r.refs, unverifiedRefs: r.unverifiedRefs, toolCalls: r.toolCalls, stopReason: r.stopReason }) as Record<string, unknown>);
  });

  return app;
}
