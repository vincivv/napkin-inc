// Test harness for the platform module: SpacetimeDB's in-process module test utilities
// (spacetimedb/server/test-utils, a real datastore compiled to Wasm) drive the actual reducers.
// One JWT identity per actor, exactly as the brain/apps will connect.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createModuleTestHarness, TestAuth } from "spacetimedb/server/test-utils";
import { ConnectionId, Timestamp } from "spacetimedb";
import spacetimedb from "../src/schema";
import * as mod from "../src/index";

export type Harness = ReturnType<typeof createModuleTestHarness<any>>;
type Reducers = typeof mod;
type ReducerName = Exclude<keyof Reducers, "default">;
type ArgsOf<R extends ReducerName> = Reducers[R] extends (ctx: any, args: infer A) => any ? A : never;

export const MAYA_JSON = readFileSync(fileURLToPath(new URL("../../fixtures/maya/configuration.json", import.meta.url)), "utf8");

/** 2026-10-24T12:00:00Z */
export const T0 = 1_792_843_200_000_000n;
export const HOUR = 3_600_000_000n;

export const ROLES = ["owner", "storefront", "shopkeeper", "support", "bookkeeper"] as const;
export type Role = (typeof ROLES)[number];

let nextConn = 1n;

export class World {
  readonly h: Harness;
  readonly system: TestAuth;

  constructor() {
    this.h = createModuleTestHarness(spacetimedb, mod as unknown as Record<string, unknown>);
    this.h.clock.set(new Timestamp(T0));
    this.system = this.identity("system");
  }

  identity(sub: string): TestAuth {
    return TestAuth.fromJwtPayload(JSON.stringify({ iss: "https://napkin.test", sub, aud: ["spacetimedb"], iat: 0 }), new ConnectionId(nextConn++));
  }

  call<R extends ReducerName>(auth: TestAuth, reducer: R, args: ArgsOf<R>): void {
    const fn = mod[reducer] as unknown as (ctx: unknown, args: unknown) => void;
    this.h.withReducerTx(auth, (ctx) => fn(ctx, args));
  }

  setTime(micros: bigint) {
    this.h.clock.set(new Timestamp(micros));
  }
  advance(micros: bigint) {
    this.setTime(this.h.clock.now().microsSinceUnixEpoch + micros);
  }

  get db() {
    return this.h.db as any;
  }

  rows(table: string): any[] {
    return [...this.db[table].iter()];
  }
}

export interface Biz {
  w: World;
  id: string;
  configId: bigint;
  actors: Record<Role, TestAuth>;
}

export function mayaConfig(businessId = "maya-cookies", patch?: (cfg: any) => void): string {
  const cfg = JSON.parse(MAYA_JSON);
  cfg.businessId = businessId;
  cfg.id = `${businessId}@${cfg.version}`;
  cfg.business.slug = businessId;
  patch?.(cfg);
  return JSON.stringify(cfg);
}

let grantSeq = 0;
/** system mints a code, `who` redeems it. */
export function grant(w: World, by: TestAuth, who: TestAuth, businessId: string, role: string, name = role) {
  const code = `grant-${role}-${++grantSeq}-xyz`;
  w.call(by, "createRoleGrant", { code, businessId, role, name, ttlSeconds: 600 });
  w.call(who, "redeemRoleGrant", { code });
}

/** Full bootstrap: claim system (once per world), register, submit + activate (system bootstrap), grant every role. */
export function bootMaya(w: World, opts: { id?: string; enforce?: boolean; claim?: boolean } = {}): Biz {
  const id = opts.id ?? "maya-cookies";
  if (opts.claim ?? true) w.call(w.system, "claimSystem", {} as never);
  w.call(w.system, "registerBusiness", { id, name: "Maya's Cookies", enforce: opts.enforce ?? true });
  w.call(w.system, "submitConfiguration", { businessId: id, json: mayaConfig(id), proofReportJson: "" });
  const cfgRow = w.rows("configVersion").find((c) => c.businessId === id)!;
  w.call(w.system, "activateConfiguration", { configId: cfgRow.id });
  const actors = {} as Record<Role, TestAuth>;
  for (const r of ROLES) {
    actors[r] = w.identity(`${id}-${r}`);
    grant(w, w.system, actors[r], id, r);
  }
  return { w, id, configId: cfgRow.id, actors };
}

// ---------- read helpers ----------

export function journal(w: World, businessId: string) {
  return w.rows("journalLine").filter((j) => j.businessId === businessId);
}

/** debit - credit over every journal line of the business (must be 0). */
export function trialBalanceSum(w: World, businessId: string): bigint {
  let s = 0n;
  for (const j of journal(w, businessId)) s += (j.debitCents as bigint) - (j.creditCents as bigint);
  return s;
}

/** account -> debit - credit */
export function balances(w: World, businessId: string): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  for (const j of journal(w, businessId)) out[j.accountCode] = (out[j.accountCode] ?? 0n) + (j.debitCents as bigint) - (j.creditCents as bigint);
  return out;
}

export function stock(w: World, businessId: string, item = "choc_chip_cookie"): bigint {
  const row = w.db.registerBalance.key.find(`${businessId}|stock|item=${item}`);
  return row ? row.qty : 0n;
}

export function order(w: World, id: string) {
  return w.db.customerOrder.id.find(id);
}

export function doc(w: World, id: bigint) {
  return w.db.document.id.find(id);
}

export function docsOf(w: World, businessId: string, docType?: string) {
  return w.rows("document").filter((d) => d.businessId === businessId && (!docType || d.docType === docType));
}

export function openInbox(w: World, businessId: string) {
  return w.rows("inboxItem").filter((i) => i.businessId === businessId && i.status === "open");
}

/** Snapshot of everything a refused or replayed call must not change (audit_log excluded). */
export function snapshot(w: World) {
  const tables = ["business", "configVersion", "actor", "catalogItem", "document", "journalLine", "registerMovement", "registerBalance", "period", "customerOrder", "processorEvent", "outbox", "inboxItem", "precedent", "ownerStatement", "decisionRecord"];
  return JSON.stringify(
    tables.map((t) => w.rows(t)),
    (_k, v) => (typeof v === "bigint" ? v.toString() : v && typeof v === "object" && "__identity__" in v ? String(v.__identity__) : v && typeof v === "object" && "__timestamp_micros_since_unix_epoch__" in v ? String(v.__timestamp_micros_since_unix_epoch__) : v),
  );
}

export const line = (productId: string, qty: number) => ({ productId, qty });

export function createOrder(b: Biz, by: TestAuth, orderId: string, lines: { productId: string; qty: number }[], discountRate = "0", channel = "storefront") {
  b.w.call(by, "createOrder", { businessId: b.id, orderId, customerName: "Sam", channel, discountRate, couponCode: "", lines });
  return order(b.w, orderId);
}

let evSeq = 0;
export function pay(b: Biz, orderId: string, amountCents: bigint, eventId = `evt_${++evSeq}`) {
  b.w.call(b.w.system, "recordProcessorEvent", { eventId, businessId: b.id, kind: "payment_succeeded", orderId, amountCents, processorRef: `pi_${orderId}` });
  return eventId;
}

/** Paid order: storefront creates, system records the payment. */
export function sell(b: Biz, orderId: string, lines: { productId: string; qty: number }[], discountRate = "0") {
  const o = createOrder(b, b.actors.storefront, orderId, lines, discountRate);
  pay(b, orderId, o.totalCents);
  return order(b.w, orderId);
}

export function lastDoc(w: World, businessId: string, docType: string) {
  const ds = docsOf(w, businessId, docType);
  return ds.sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1);
}
