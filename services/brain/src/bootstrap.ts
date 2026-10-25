// Idempotent platform bootstrap: system actor, Maya's business + red-team baseline, M1 configuration,
// and one identity per AI/storefront actor with its role granted through a one-time code. It also
// reconnects the actors of every other live business, so they keep taking orders after a restart.
// Run: pnpm --filter @napkin/brain bootstrap   (the server also runs it at startup)
// Running it twice changes nothing: every step first checks the platform's current state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newGrantCode } from "./auth";
import { loadEnv } from "./env";
import { log } from "./log";
import { actorKey, StdbHub, SYSTEM_SUBSCRIPTIONS, waitFor } from "./stdb";
import { IdentityStore } from "./store";

const BRAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const FIXTURE_PATH = path.resolve(BRAIN_DIR, "../../fixtures/maya/configuration.json");

export interface BusinessSeed {
  id: string;
  name: string;
  enforce: boolean;
}

export const MAYA: BusinessSeed = { id: "maya-cookies", name: "Maya's Cookies", enforce: true };
/** Red-team baseline: same module, enforce=false (guards off). Name differs only so dashboards can tell them apart. */
export const MAYA_BASELINE: BusinessSeed = { id: "maya-cookies-baseline", name: "Maya's Cookies (baseline)", enforce: false };
export const SEED_BUSINESSES = [MAYA, MAYA_BASELINE];

/** Actor roles that get their own identity per business. Owner is granted only via /auth/owner. */
export const ACTOR_ROLES = ["storefront", "shopkeeper", "support", "bookkeeper"] as const;
const ROLE_NAMES: Record<(typeof ACTOR_ROLES)[number], string> = {
  storefront: "Storefront",
  shopkeeper: "AI Shopkeeper",
  support: "AI Support",
  bookkeeper: "AI Bookkeeper",
};

/** The fixture re-slugged for another business id (only id/businessId/slug change). */
export function configFor(fixture: Record<string, unknown>, businessId: string): Record<string, unknown> {
  const c = structuredClone(fixture) as Record<string, any>;
  if (c.businessId === businessId) return c;
  c.id = `${businessId}@${c.version}`;
  c.businessId = businessId;
  c.business = { ...c.business, slug: businessId };
  c.source = `${c.source ?? "fixture"} (re-slugged for ${businessId})`;
  return c;
}

export interface BootstrapReport {
  systemIdentity: string;
  steps: string[];
}

export async function bootstrap(hub: StdbHub, fixturePath = FIXTURE_PATH): Promise<BootstrapReport> {
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    log.info("bootstrap", s);
  };
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

  // 1. system actor
  const sys = await hub.connect("system", SYSTEM_SUBSCRIPTIONS);
  const db = sys.conn.db;
  const mine = db.actor.identity.find(sys.identity);
  if (mine?.role === "system") {
    step(`system actor: already claimed by this brain (${sys.identityHex.slice(0, 16)}…)`);
  } else {
    if (mine) throw new Error(`the brain's system identity already holds role "${mine.role}" for ${mine.businessId}; refusing to continue`);
    const other = [...db.actor.iter()].find((a) => a.role === "system");
    if (other) {
      throw new Error(
        `another identity (${other.identity.toHexString().slice(0, 16)}…) already holds the system role. ` +
          `Restore that identity's token in .data/identities.json or republish the database.`,
      );
    }
    await hub.call("system", "claimSystem", (c) => c.reducers.claimSystem({}));
    const claimed = await waitFor(() => (db.actor.identity.find(sys.identity)?.role === "system" ? true : undefined));
    if (!claimed) throw new Error("claimSystem succeeded but no system actor row appeared");
    step("system actor: claimed");
  }

  for (const seed of SEED_BUSINESSES) {
    // 2. business
    type Biz = NonNullable<ReturnType<typeof db.business.id.find>>;
    let biz: Biz | undefined = db.business.id.find(seed.id) ?? undefined;
    if (!biz) {
      await hub.call("system", "registerBusiness", (c) => c.reducers.registerBusiness(seed));
      biz = await waitFor(() => db.business.id.find(seed.id) ?? undefined);
      if (!biz) throw new Error(`registerBusiness(${seed.id}) succeeded but the row did not appear`);
      step(`business ${seed.id}: registered (enforce=${seed.enforce})`);
    } else {
      step(`business ${seed.id}: exists`);
      if (biz.enforce !== seed.enforce) log.warn("bootstrap", `business ${seed.id} has enforce=${biz.enforce}, expected ${seed.enforce} (immutable; leaving it)`);
    }

    // 3. configuration
    if (biz.activeConfigId !== 0n) {
      step(`business ${seed.id}: active configuration ${biz.activeConfigId} (left unchanged)`);
    } else {
      const json = JSON.stringify(configFor(fixture, seed.id));
      const pendingFor = () =>
        [...db.configVersion.businessId.filter(seed.id)]
          .filter((v) => v.status === "pending" && v.json === json)
          .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
      let pending = pendingFor();
      if (pending) {
        step(`business ${seed.id}: reusing pending configuration ${pending.id}`);
      } else {
        // M1: no prover yet, so the proof report is empty (the platform rejects only *failed* proofs).
        await hub.call("system", "submitConfiguration", (c) =>
          c.reducers.submitConfiguration({ businessId: seed.id, json, proofReportJson: "" }),
        );
        pending = await waitFor(pendingFor);
        if (!pending) throw new Error(`submitConfiguration(${seed.id}) succeeded but no pending config_version appeared`);
        step(`business ${seed.id}: submitted configuration ${pending.id}`);
      }
      const configId = pending.id;
      await hub.call("system", "activateConfiguration", (c) => c.reducers.activateConfiguration({ configId }));
      const active = await waitFor(() => (db.business.id.find(seed.id)?.activeConfigId === configId ? true : undefined));
      if (!active) throw new Error(`activateConfiguration(${configId}) succeeded but business ${seed.id} is not on it`);
      step(`business ${seed.id}: activated configuration ${configId}`);
    }

    // 4. actor identities
    await grantActors(hub, seed.id, step);
  }

  // 5. every other live business (created from a napkin): reconnect its actors, or its storefront, phone
  // orders and AI staff stop working after a brain restart. One failing business must not stop the rest.
  const seeds = new Set(SEED_BUSINESSES.map((b) => b.id));
  for (const b of [...db.business.iter()].filter((x) => x.activeConfigId !== 0n && !seeds.has(x.id))) {
    try {
      await grantActors(hub, b.id, step);
    } catch (e) {
      log.warn("bootstrap", `business ${b.id}: could not connect its actors: ${(e as Error).message}`);
    }
  }

  return { systemIdentity: sys.identityHex, steps };
}

// CLI entry
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const env = loadEnv();
  const hub = new StdbHub({ uri: env.stdbUri, db: env.stdbDb, identities: new IdentityStore(env.dataDir, `${env.stdbUri}#${env.stdbDb}`) });
  bootstrap(hub)
    .then((r) => {
      console.log(`bootstrap OK (${r.steps.length} steps) on ${env.stdbUri} db=${env.stdbDb}`);
      hub.disconnectAll();
      process.exit(0);
    })
    .catch((e: Error) => {
      console.error(`bootstrap FAILED: ${e.name}: ${e.message}`);
      hub.disconnectAll();
      process.exit(1);
    });
}

/**
 * Give a business its storefront and AI-staff identities (idempotent): each role gets its own SpacetimeDB
 * identity through a one-time role grant. Used by bootstrap for the seed businesses and by the compiler when
 * a napkin creates a brand-new business, so its storefront can take orders right away.
 */
export async function grantActors(hub: StdbHub, businessId: string, step: (s: string) => void = (s) => log.info("actors", s)): Promise<void> {
  const db = hub.system().conn.db;
  for (const role of ACTOR_ROLES) {
    const key = actorKey(role, businessId);
    const actor = await hub.connect(key);
    const row = db.actor.identity.find(actor.identity);
    if (row) {
      if (row.role !== role || row.businessId !== businessId) {
        throw new Error(`identity for ${key} already holds ${row.role}@${row.businessId}; refusing to reuse it`);
      }
      step(`actor ${key}: exists`);
      continue;
    }
    const code = newGrantCode();
    await hub.call("system", "createRoleGrant", (c) =>
      c.reducers.createRoleGrant({ code, businessId, role, name: ROLE_NAMES[role], ttlSeconds: 300 }),
    );
    await hub.call(key, "redeemRoleGrant", (c) => c.reducers.redeemRoleGrant({ code }));
    const granted = await waitFor(() => {
      const r = db.actor.identity.find(actor.identity);
      return r && r.role === role && r.businessId === businessId ? r : undefined;
    });
    if (!granted) throw new Error(`redeemRoleGrant for ${key} succeeded but no matching actor row appeared`);
    step(`actor ${key}: granted (${actor.identityHex.slice(0, 16)}…)`);
  }
}
