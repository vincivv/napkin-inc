// Scratch SpacetimeDB database for the red team: `napkin-l` on the local server (127.0.0.1:3000).
//
// Reset strategy: re-publish platform/ to napkin-l with clear-on-publish (`spacetime publish -c=always`)
// from a bundle built once per run, then run the brain's own bootstrap (system actor, maya-cookies +
// maya-cookies-baseline, the M1 configuration, one identity per actor) against it. A reset takes about
// 0.2 s for the publish plus about 1 s for the bootstrap, so a fresh world per attack per mode is cheap.
// Fresh business ids per attack would not work: order ids and processor event ids are global primary
// keys, and the attack files use fixed order ids.
//
// SAFETY: the shared `napkin` database runs the live demo. assertScratchDb refuses any other name.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { REDTEAM_ROOT } from "../load";
import { bootstrap, IdentityStore, StdbHub, StdbPlatform, actorKey, MAYA, MAYA_BASELINE } from "./brain";
import type { Mode } from "../types";

export const SCRATCH_DB = "napkin-l";
export const STDB_URI = "http://127.0.0.1:3000";
export const STDB_SERVER = "local";
export const PLATFORM_DIR = join(REDTEAM_ROOT, "..", "platform");
export const DATA_DIR = join(REDTEAM_ROOT, "out", ".data");

/** Throws unless `db` is the red team's scratch database. Never `napkin` (live demo). */
export function assertScratchDb(db: string): void {
  if (db !== SCRATCH_DB) throw new Error(`refusing to touch database "${db}": the red team only uses ${SCRATCH_DB}`);
}

export const businessFor = (mode: Mode): string => (mode === "napkin" ? MAYA.id : MAYA_BASELINE.id);

let bundlePath: string | undefined;

/** Builds platform/ once (spacetime build) and returns the JS bundle to publish. */
export function buildBundle(): string {
  if (bundlePath) return bundlePath;
  execFileSync("spacetime", ["build"], { cwd: PLATFORM_DIR, stdio: "pipe" });
  const p = join(PLATFORM_DIR, "dist", "bundle.js");
  if (!existsSync(p)) throw new Error(`spacetime build did not produce ${p}`);
  bundlePath = p;
  return p;
}

/** Re-publishes the module to napkin-l, destroying all its data. */
export function republishClean(db: string = SCRATCH_DB): void {
  assertScratchDb(db);
  const bundle = buildBundle();
  execFileSync("spacetime", ["publish", db, "--server", STDB_SERVER, "-j", bundle, "-c=always", "-y"], { cwd: PLATFORM_DIR, stdio: "pipe" });
}

/** One clean, bootstrapped napkin-l world: a brain hub with system + storefront/shopkeeper/support/bookkeeper connections. */
export class ScratchWorld {
  hub: StdbHub;
  platform: StdbPlatform;
  private readonly identities: IdentityStore;

  constructor(readonly db: string = SCRATCH_DB) {
    assertScratchDb(db);
    mkdirSync(DATA_DIR, { recursive: true });
    this.identities = new IdentityStore(DATA_DIR, `${STDB_URI}#${db}`);
    this.hub = this.newHub();
    this.platform = new StdbPlatform(this.hub);
  }

  private newHub(): StdbHub {
    return new StdbHub({ uri: STDB_URI, db: this.db, identities: this.identities });
  }

  /** Destroys napkin-l's data, re-publishes, and bootstraps it exactly like the brain does. */
  async reset(): Promise<void> {
    this.hub.disconnectAll();
    republishClean(this.db);
    this.hub = this.newHub();
    this.platform = new StdbPlatform(this.hub);
    await bootstrap(this.hub);
  }

  /**
   * Simulates a brain restart: drops every connection and in-memory state, reconnects with the same stored
   * identities (as the restarted process would), without touching the database.
   */
  async restartBrain(): Promise<void> {
    this.hub.disconnectAll();
    this.hub = this.newHub();
    this.platform = new StdbPlatform(this.hub);
    await bootstrap(this.hub); // idempotent: reconnects, changes nothing on the platform
  }

  key(role: string, mode: Mode): string {
    return actorKey(role, businessFor(mode));
  }

  /** The system actor's token, for read-only HTTP SQL. */
  private systemToken(): string {
    const t = this.identities.get("system")?.token;
    if (!t) throw new Error("no system identity stored for napkin-l (bootstrap first)");
    return t;
  }

  /** HTTP SQL against napkin-l (public tables). Returns the raw SATS-JSON statement results. */
  async sql(query: string): Promise<SqlResult[]> {
    assertScratchDb(this.db);
    const res = await fetch(`${STDB_URI}/v1/database/${this.db}/sql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.systemToken()}`, "Content-Type": "text/plain" },
      body: query,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`SQL ${res.status} on ${this.db}: ${text.slice(0, 300)} (query: ${query})`);
    return JSON.parse(text) as SqlResult[];
  }

  close(): void {
    this.hub.disconnectAll();
  }
}

/** One statement's result from POST /v1/database/:db/sql. */
export interface SqlResult {
  schema: { elements: { name: { some: string } | string | null; algebraic_type?: unknown }[] };
  rows: unknown[][];
}
