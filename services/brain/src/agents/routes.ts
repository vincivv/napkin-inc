// HTTP routes for the AI staff.
//   POST /agents/:role/message {businessId, conversationId, text} -> {reply, toolCalls:[{tool,args,decision,result}]}
//   POST /ask {businessId, question} -> {answer, refs, unverifiedRefs, toolCalls}
// The role comes from the path and is checked against the three staff roles; nothing in the body can
// change it. Without ANTHROPIC_API_KEY the routes answer 503 (nothing is faked).

import { Hono } from "hono";
import { z } from "zod";
import { CheckoutError } from "../payments/checkout";
import { PlatformUnavailable, ReducerRefused } from "../stdb";
import { GuardUnavailable } from "../guards";
import { log } from "../log";
import { StaffError, type Staff } from "./staff";
import { isStaffRole, type AgentTurnResult } from "./types";

const BusinessId = z.string().regex(/^[a-z0-9-]{1,64}$/);
const MessageBody = z.object({ businessId: BusinessId, conversationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), text: z.string().min(1).max(4000) });
const AskBody = z.object({ businessId: BusinessId, question: z.string().min(1).max(2000) });

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
const out = (r: AgentTurnResult) => ({ reply: r.reply, toolCalls: r.toolCalls, stopReason: r.stopReason });

export function agentRoutes(staff: () => Staff | undefined): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof StaffError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    if (err instanceof PlatformUnavailable || err instanceof GuardUnavailable) return c.json({ error: `platform unavailable: ${err.message}` }, 503);
    if (err instanceof ReducerRefused || err instanceof CheckoutError) return c.json({ error: err.message }, 422);
    log.error("agents", `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: "agent error" }, 502);
  });

  app.post("/agents/:role/message", async (c) => {
    const role = c.req.param("role");
    if (!isStaffRole(role)) return c.json({ error: `unknown agent role "${role.slice(0, 32)}" (shopkeeper, support, bookkeeper)` }, 404);
    const s = staff();
    if (!s) return c.json({ error: "AI staff unavailable: ANTHROPIC_API_KEY is not set" }, 503);
    const body = MessageBody.parse(await c.req.json());
    const r = await s.message({ role, ...body });
    log.info("agents", `${role}@${body.businessId} ${body.conversationId}: ${r.toolCalls.map((t) => `${t.tool}:${t.decision.outcome}`).join(", ") || "no tools"} (${r.stopReason})`);
    return c.json(jsonSafe(out(r)) as Record<string, unknown>);
  });

  app.post("/ask", async (c) => {
    const s = staff();
    if (!s) return c.json({ error: "AI staff unavailable: ANTHROPIC_API_KEY is not set" }, 503);
    const body = AskBody.parse(await c.req.json());
    const r = await s.ask(body);
    return c.json(jsonSafe({ answer: r.answer, refs: r.refs, unverifiedRefs: r.unverifiedRefs, toolCalls: r.toolCalls, stopReason: r.stopReason }) as Record<string, unknown>);
  });

  return app;
}
