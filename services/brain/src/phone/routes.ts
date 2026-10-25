// POST /phone/tools/:name — Cartesia webhook tools (and GET /phone/shops for the setup script, public GET /phone/code/:businessId). Every call needs `Authorization: Bearer <PHONE_TOOL_SECRET>`
// (Cartesia's webhook `authentication: {mode: "bearer"}`). No secret configured = every call refused.

import { Hono } from "hono";
import { log } from "../log";
import { runTool, type PhoneDeps } from "./tools";
import { constantTimeEqual } from "./util";

export function bearerOk(header: string | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  const m = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  if (!m) return false;
  return constantTimeEqual(m[1]!.trim(), secret);
}

export function phoneRoutes(d: PhoneDeps, secret: string | undefined): Hono {
  const r = new Hono();
  r.onError((err, c) => {
    log.error("phone", `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ ok: false, say: "Something went wrong on our side. Please try again." }, 500);
  });

  // the live shop names, for the Cartesia agent's speech-to-text keyterms (scripts/cartesia-setup.ts)
  r.get("/phone/shops", async (c) => {
    if (!bearerOk(c.req.header("authorization"), secret)) return c.json({ ok: false, error: "unauthorized" }, 401);
    await d.platform.ready();
    return c.json({ ok: true, shops: d.platform.shops().map((x) => x.name) });
  });

  // public: a live shop's 4-digit phone code, shown on its store and dashboard (assigned on first ask)
  r.get("/phone/code/:businessId", async (c) => {
    await d.platform.ready();
    const id = c.req.param("businessId");
    const shops = d.platform.shops();
    // just after a restart the shop list is still loading: say so, so pages retry instead of giving up
    if (shops.length === 0) return c.json({ ok: false, error: "the brain is starting; try again shortly" }, 503);
    if (!shops.some((x) => x.id === id)) return c.json({ ok: false, error: "no live shop with that id" }, 404);
    return c.json({ ok: true, code: d.codes.codeFor(id) });
  });

  r.post("/phone/tools/:name", async (c) => {
    if (!bearerOk(c.req.header("authorization"), secret)) {
      log.warn("phone", `401 on ${c.req.param("name")}${secret ? "" : " (PHONE_TOOL_SECRET not set: all phone tool calls are refused)"}`);
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid JSON body" }, 400);
    }
    const res = await runTool(d, c.req.param("name"), body);
    return c.json(res.body, res.status);
  });

  return r;
}
