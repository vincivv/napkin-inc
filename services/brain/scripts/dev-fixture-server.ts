// UI development without API keys or a platform: serves ONLY the M2 routes on $PORT (default 4000; CORS origins from $DEV_ORIGINS) with a FAKE LLM that
// returns the synthetic napkin (fixtures/maya/napkin.SYNTHETIC.png) extraction. Clearly not real AI output.
//   pnpm --filter @napkin/brain exec tsx scripts/dev-fixture-server.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { intakeRoutes } from "../src/intake/routes";
import type { Llm } from "../src/llm";
import { questionRoutes } from "../src/questions/routes";
import { SpecStore } from "../src/spec/store";

const rf = (value: string, quote: string, region: { x: number; y: number; w: number; h: number }, confidence = 0.92) => ({ value, quote, region, confidence, provenance: "paper" as const });
const napkin = {
  business: { name: rf("Maya's Cookies", "Maya's Cookies", { x: 0.13, y: 0.14, w: 0.7, h: 0.12 }) },
  offerings: [
    {
      name: rf("Chocolate chip cookie", "chocolate chip", { x: 0.14, y: 0.35, w: 0.42, h: 0.08 }),
      variants: [
        { name: rf("Single", "chocolate chip ..... $3", { x: 0.14, y: 0.35, w: 0.64, h: 0.08 }), price: rf("3", "$3", { x: 0.68, y: 0.35, w: 0.1, h: 0.08 }) },
        { name: rf("Box of 6", "box of 6", { x: 0.14, y: 0.48, w: 0.25, h: 0.08 }), price: rf("15", "$15", { x: 0.62, y: 0.48, w: 0.14, h: 0.08 }) },
      ],
      addOns: [{ name: rf("Sea salt", "+ sea salt", { x: 0.15, y: 0.62, w: 0.32, h: 0.08 }), price: rf("1", "$1", { x: 0.66, y: 0.62, w: 0.1, h: 0.08 }) }],
    },
  ],
};
const llm: Llm = {
  async tool(r) {
    if (r.toolName === "propose_changes") return { changes: [{ path: "policies.maxDiscountPct", newValue: "0", quote: "no discounts" }], unparsed: [], note: "FAKE LLM (dev fixture server)" };
    return napkin;
  },
  async text(r) {
    return r.user;
  },
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-dev-"));
const deps = { store: new SpecStore(dir), llm, platform: undefined, cartesiaKey: undefined };
const app = new Hono();
app.use("*", cors({ origin: (process.env.DEV_ORIGINS ?? "http://localhost:3001").split(","), allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type"] }));
app.route("/", intakeRoutes(deps));
app.route("/", questionRoutes(deps));
serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4000) }, () => console.log("FAKE-LLM M2 dev server on :" + (process.env.PORT ?? 4000) + " (data in " + dir + ")"));
