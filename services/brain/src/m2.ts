// M2 wiring: mounts the intake + question-engine routes on the brain app, and the real StdbHub-backed port.

import type { Hono } from "hono";
import { intakeRoutes } from "./intake/routes";
import { llmFromEnv } from "./llm";
import type { M2Deps, M2Platform } from "./m2deps";
import { questionRoutes } from "./questions/routes";
import { SpecStore } from "./spec/store";
import { log } from "./log";
import type { StdbHub } from "./stdb";

/** Platform slice over the system connection. owner_statement is subscribed lazily on top of the hub's set. */
export class StdbM2Platform implements M2Platform {
  private subscribed = false;
  constructor(private readonly hub: StdbHub) {}

  private sys() {
    const s = this.hub.get("system");
    if (!s) return undefined;
    if (!this.subscribed) {
      this.subscribed = true;
      s.conn.subscriptionBuilder().onError(() => (this.subscribed = false)).subscribe(["SELECT * FROM owner_statement"]);
    }
    return s;
  }
  hasBusiness(id: string): boolean {
    const s = this.hub.get("system");
    return Boolean(s?.connected() && s.conn.db.business.id.find(id));
  }
  async recordDecision(a: Parameters<M2Platform["recordDecision"]>[0]) {
    await this.hub.call("system", "recordDecision", (c) => c.reducers.recordDecision(a));
  }
  async queueOwnerStatement(a: Parameters<M2Platform["queueOwnerStatement"]>[0]) {
    await this.hub.call("system", "queueOwnerStatement", (c) => c.reducers.queueOwnerStatement(a));
  }
  ownerStatements(businessId: string) {
    const s = this.sys();
    if (!s) return [];
    return [...s.conn.db.ownerStatement.iter()].filter((r) => r.businessId === businessId).map((r) => ({ id: r.id, status: r.status, diffJson: r.diffJson }));
  }
  async markOwnerStatementApplied(id: bigint) {
    await this.hub.call("system", "markOwnerStatementApplied", (c) => c.reducers.markOwnerStatementApplied({ id }));
  }
}

export function registerM2Routes(app: Hono, hub: StdbHub, dataDir: string, env: NodeJS.ProcessEnv = process.env): M2Deps {
  const deps: M2Deps = {
    store: new SpecStore(dataDir),
    llm: llmFromEnv(env),
    platform: new StdbM2Platform(hub),
    cartesiaKey: env.CARTESIA_API_KEY?.trim() || undefined,
  };
  if (!deps.llm) log.warn("m2", "ANTHROPIC_API_KEY not set: /intake/* and /owner/statement answer 503");
  if (!deps.cartesiaKey) log.warn("m2", "CARTESIA_API_KEY not set: /intake/voice accepts typed transcripts only");
  app.route("/", intakeRoutes(deps));
  app.route("/", questionRoutes(deps));
  return deps;
}
