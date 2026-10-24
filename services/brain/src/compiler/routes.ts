// POST /compile {businessId}: compiles the business's owner-confirmed spec into Configuration v(n+1),
// streaming progress as Server-Sent Events, and submits it to the platform as the system identity.
// Activation stays an OWNER action in the owner app (invariant 6). The only exception is the platform's
// own bootstrap rule: a brand-new business with no active configuration and no owner yet.
//
// Events: `step` {step, status, message, data?} (facts -> template -> synthesis -> proofs -> configuration
// -> storefront -> agents -> submit), then exactly one `result` {configId, version, status, activated} or
// `error` {code, message, questions}. GET /compile/:businessId/latest replays the last run's events.

import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Configuration } from "@napkin/schema";
import { log } from "../log";
import { ReducerRefused, type StdbHub } from "../stdb";
import { compile, CompileRefused, type StepEvent } from "./index";
import { SpecStore } from "../spec/store";
import { SpecStoreSource, StdbCompilePlatform, type CompilePlatformPort, type SpecSource } from "./platform";
import { StubProver, type ProverPort } from "./prover-port";
import { ClaudeCopyProposer, type CopyProposer } from "./storefront";
import type { RoleLimits } from "./templates/item_seller";

export interface CompileRouteDeps {
  platform: CompilePlatformPort;
  specs: SpecSource;
  prover: ProverPort;
  proposer?: CopyProposer;
}

export type CompileEvent =
  | { event: "step"; data: StepEvent | { step: "submit"; status: StepEvent["status"]; message: string; data?: unknown } }
  | { event: "result"; data: { businessId: string; configId: string; version: number; status: string; activated: boolean; message: string } }
  | { event: "error"; data: { code: string; message: string; questions: unknown[] } };

const Body = z.object({ businessId: z.string().regex(/^[a-z0-9-]{1,64}$/) });

const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));

/** Refund limits the owner already approved (in the active configuration) carry over; otherwise none. */
export function carriedRoleLimits(active: Configuration | undefined): RoleLimits | undefined {
  if (!active) return undefined;
  const get = (role: string) => {
    const v = active.roles.find((r) => r.id === role)?.limits["maxRefundCents"];
    const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
    return n !== undefined && Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  };
  const support = get("support");
  const bookkeeper = get("bookkeeper");
  return support === undefined || bookkeeper === undefined ? undefined : { maxRefundCents: { support, bookkeeper } };
}

/** The compile run itself, independent of HTTP: yields events through `send`. */
export async function runCompile(businessId: string, deps: CompileRouteDeps, send: (e: CompileEvent) => Promise<void> | void): Promise<void> {
  const step = (s: CompileEvent["data"] & { step: string }) => send({ event: "step", data: s } as CompileEvent);
  try {
    const spec = await deps.specs.get(businessId);
    if (!spec) {
      await send({ event: "error", data: { code: "no_spec", message: `no owner-confirmed BusinessSpec for "${businessId}" yet (finish the interview first)`, questions: [] } });
      return;
    }
    const versions = deps.platform.configVersions(businessId);
    const version = versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const biz = deps.platform.business(businessId);
    const activeRow = biz && biz.activeConfigId !== 0n ? versions.find((v) => v.id === biz.activeConfigId) : undefined;
    let active: Configuration | undefined;
    try {
      active = activeRow ? (JSON.parse(activeRow.json) as Configuration) : undefined;
    } catch {
      active = undefined;
    }
    const roleLimits = carriedRoleLimits(active);

    const r = await compile(spec, { businessId, version, prover: deps.prover, ...(deps.proposer ? { proposer: deps.proposer } : {}), ...(roleLimits ? { roleLimits } : {}), onStep: (e) => void step(e) });

    await step({ step: "submit", status: "running", message: `submitting configuration v${version}` });
    if (!biz) {
      await deps.platform.registerBusiness(businessId, r.config.business.name);
      await step({ step: "submit", status: "running", message: `registered new business ${businessId}` });
    }
    const cfgJson = JSON.stringify(r.config);
    await deps.platform.submitConfiguration(businessId, cfgJson, JSON.stringify(r.proofReport));
    const row = await deps.platform.awaitConfigVersion(businessId, version);
    if (!row || row.json !== cfgJson) throw new CompileRefused("invalid_configuration", `the platform stored a different v${version} (another compile ran at the same time); compile again`);

    const after = deps.platform.business(businessId);
    let activated = false;
    let message = `configuration v${version} is pending: the owner activates it in the owner app`;
    if (after && after.activeConfigId === 0n && !deps.platform.hasOwner(businessId)) {
      await deps.platform.activateConfiguration(row.id);
      activated = true;
      message = `configuration v${version} activated (bootstrap: brand-new business with no owner yet)`;
    }
    await step({ step: "submit", status: "done", message });
    await send({ event: "result", data: { businessId, configId: row.id.toString(), version, status: activated ? "active" : "pending", activated, message } });
  } catch (e) {
    const err = e as Error;
    const code = e instanceof CompileRefused ? e.code : e instanceof ReducerRefused ? "platform_refused" : "internal";
    if (code === "internal") log.error("compile", `${businessId}: ${err.stack ?? err.message}`);
    await send({ event: "error", data: { code, message: err.message, questions: e instanceof CompileRefused ? e.questions : [] } });
  }
}

export function registerCompileRoutes(app: Hono, deps: CompileRouteDeps): void {
  const latest = new Map<string, CompileEvent[]>();
  const running = new Set<string>();

  app.post("/compile", async (c) => {
    const { businessId } = Body.parse(await c.req.json());
    if (running.has(businessId)) return c.json({ error: `a compile for ${businessId} is already running` }, 409);
    running.add(businessId);
    const events: CompileEvent[] = [];
    latest.set(businessId, events);
    return streamSSE(c, async (stream) => {
      try {
        await runCompile(businessId, deps, async (e) => {
          events.push(e);
          await stream.writeSSE({ event: e.event, data: json(e.data) });
        });
      } finally {
        running.delete(businessId);
      }
    });
  });

  app.get("/compile/:businessId/latest", (c) => c.json(JSON.parse(json({ businessId: c.req.param("businessId"), running: running.has(c.req.param("businessId")), events: latest.get(c.req.param("businessId")) ?? [] }))));
}

/** Production wiring: stub prover until services/prover is merged; Claude copy proposals only with a key. */
export function defaultCompileDeps(platform: CompilePlatformPort, specs: SpecSource, prover: ProverPort = new StubProver()): CompileRouteDeps {
  const key = process.env["ANTHROPIC_API_KEY"]?.trim();
  const proposer = key ? new ClaudeCopyProposer(key, process.env["ANTHROPIC_WORKSPACE_ID"]?.trim() || undefined) : undefined;
  if (prover.isStub) log.warn("compile", "PROVER STUB: configurations are compiled with proofs marked 'skipped' until services/prover is wired");
  return { platform, specs, prover, ...(proposer ? { proposer } : {}) };
}

/** One-line mount for server.ts. Specs come from the intake/question engine's SpecStore. */
export function mountCompiler(app: Hono, hub: StdbHub, dataDir: string): void {
  registerCompileRoutes(app, defaultCompileDeps(new StdbCompilePlatform(hub), new SpecStoreSource(new SpecStore(dataDir))));
}
