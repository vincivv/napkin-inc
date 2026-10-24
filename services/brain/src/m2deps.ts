// Shared dependencies + helpers for the M2 routes (intake + questions). Everything injectable for tests.

import { createHash } from "node:crypto";
import type { BusinessSpec } from "@napkin/schema";
import { Hono } from "hono";
import { ZodError } from "zod";
import { log } from "./log";
import type { Llm } from "./llm";
import { LlmUnavailable } from "./llm";
import { moneyBlockers, moneyReady } from "./questions/engine";
import { listFacts, isMissing } from "./spec/paths";
import { BUSINESS_ID_RE, type SpecStore, type StoredSpec } from "./spec/store";

export interface OwnerStatementRow {
  id: bigint;
  status: string;
  diffJson: string;
}
/** The slice of the platform M2 needs (a separate port from PlatformPort so other agents' fakes are untouched). */
export interface M2Platform {
  hasBusiness(businessId: string): boolean;
  recordDecision(a: { businessId: string; action: string; documentRef: string; ruleIds: string[]; evidenceRefs: string[]; inputsHash: string; outcome: string; reason: string; wouldChangeIf: string }): Promise<void>;
  queueOwnerStatement(a: { businessId: string; channel: string; text: string; diffJson: string }): Promise<void>;
  ownerStatements(businessId: string): OwnerStatementRow[];
  markOwnerStatementApplied(id: bigint): Promise<void>;
}

export interface M2Deps {
  store: SpecStore;
  llm: Llm | undefined;
  platform: M2Platform | undefined;
  cartesiaKey: string | undefined;
  fetchImpl?: typeof fetch;
  newId?: () => string;
}

export class HttpError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 413 | 415 | 422 | 502 | 503, message: string) {
    super(message);
  }
}

export const sha = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex");

export function requireLlm(d: M2Deps): Llm {
  if (!d.llm) throw new HttpError(503, "ANTHROPIC_API_KEY is not set; the AI features are unavailable (nothing is faked)");
  return d.llm;
}

export function checkBusinessId(id: unknown): string {
  if (typeof id !== "string" || !BUSINESS_ID_RE.test(id)) throw new HttpError(400, "businessId is required (lowercase letters, digits, dashes)");
  return id;
}

export function requireSpec(d: M2Deps, businessId: string): StoredSpec {
  const s = d.store.get(businessId);
  if (!s) throw new HttpError(404, `no draft spec for ${businessId}; run intake first`);
  return s;
}

export function countByProvenance(spec: BusinessSpec) {
  const c = { paper: 0, owner_said: 0, inferred: 0, missing: 0, confirmed: 0, total: 0 };
  for (const { fact } of listFacts(spec)) {
    c.total++;
    if (isMissing(fact)) c.missing++;
    else c[fact.provenance]++;
    if (fact.confirmed) c.confirmed++;
  }
  return c;
}

export function specView(rec: StoredSpec) {
  return {
    businessId: rec.businessId,
    version: rec.version,
    updatedAt: rec.updatedAt,
    spec: rec.spec,
    alternatives: rec.alternatives,
    moneyReady: moneyReady(rec.spec),
    blockers: moneyBlockers(rec.spec),
    counts: countByProvenance(rec.spec),
    hasPhoto: Boolean(rec.photo),
    drafts: { photo: Boolean(rec.drafts.photo), voice: Boolean(rec.drafts.voice) },
  };
}

/** Sub-app with its own error mapping so the M2 routes do not depend on createApp's onError. */
export function newRouter(): Hono {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof LlmUnavailable) return c.json({ error: err.message }, 502);
    if (typeof (err as { status?: unknown }).status === "number" && /APIError|AnthropicError/.test(err.constructor.name + (err.name ?? ""))) {
      log.error("m2", `Anthropic API error ${(err as { status: number }).status}: ${err.message.slice(0, 300)}`);
      return c.json({ error: `the AI service refused the request (HTTP ${(err as { status: number }).status})` }, 502);
    }
    if (err instanceof ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    const name = (err as Error).name;
    if (["ExtractionFailed", "SttError"].includes(name)) return c.json({ error: err.message }, 502);
    if (["AnswerError", "CoerceError", "StaleDiff"].includes(name)) return c.json({ error: err.message }, name === "StaleDiff" ? 409 : 422);
    log.error("m2", `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}
