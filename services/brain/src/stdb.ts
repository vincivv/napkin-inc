// SpacetimeDB connections, one per actor identity (system, storefront@biz, shopkeeper@biz, ...).
// Authority lives in the platform: each actor's identity maps to a role in the `actor` table, and
// reducers check ctx.sender. The brain never claims a role by argument, only by which identity calls.

import { DbConnection } from "@napkin/stdb-bindings";
import type { Identity } from "spacetimedb";
import { IdentityStore } from "./store";
import { log } from "./log";

/** The platform refused the call (SenderError): the transaction rolled back. Message is safe to surface. */
export class ReducerRefused extends Error {
  override name = "ReducerRefused";
  constructor(
    readonly reducer: string,
    message: string,
  ) {
    super(message);
  }
}

/** The platform could not be reached or failed internally. Not the caller's fault; retryable. */
export class PlatformUnavailable extends Error {
  override name = "PlatformUnavailable";
}

/** Tables the system connection mirrors into its client cache. */
export const SYSTEM_SUBSCRIPTIONS = [
  "SELECT * FROM business",
  "SELECT * FROM config_version",
  "SELECT * FROM actor",
  "SELECT * FROM catalog_item",
  "SELECT * FROM customer_order",
  "SELECT * FROM document",
  "SELECT * FROM outbox",
  "SELECT * FROM processor_event",
];

export interface ActorConnection {
  key: string;
  conn: DbConnection;
  identity: Identity;
  identityHex: string;
  /** true while the websocket is up. */
  connected: () => boolean;
}

export interface HubOptions {
  uri: string;
  db: string;
  identities: IdentityStore;
  connectTimeoutMs?: number;
}

export function actorKey(role: string, businessId?: string): string {
  return role === "system" ? "system" : `${role}@${businessId}`;
}

export class StdbHub {
  private readonly actors = new Map<string, ActorConnection>();
  private readonly pending = new Map<string, Promise<ActorConnection>>();

  constructor(private readonly opts: HubOptions) {}

  get(key: string): ActorConnection | undefined {
    return this.actors.get(key);
  }

  system(): ActorConnection {
    const a = this.actors.get("system");
    if (!a) throw new PlatformUnavailable("system connection not established");
    return a;
  }

  /** Known identity for an actor key (from identities.json), without connecting. */
  storedIdentity(key: string) {
    return this.opts.identities.get(key);
  }

  /**
   * Connect as `key`, reusing its saved token (or minting a fresh identity and saving its token
   * immediately, so a crash never orphans an identity that may already hold a role).
   * Resolves after the initial subscription is applied (when `subscriptions` is non-empty).
   */
  connect(key: string, subscriptions: string[] = []): Promise<ActorConnection> {
    const existing = this.actors.get(key);
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const p = this.open(key, subscriptions).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private open(key: string, subscriptions: string[]): Promise<ActorConnection> {
    const stored = this.opts.identities.get(key);
    const timeoutMs = this.opts.connectTimeoutMs ?? 15_000;
    return new Promise<ActorConnection>((resolve, reject) => {
      let connected = false;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new PlatformUnavailable(`timed out connecting to SpacetimeDB as ${key} (${this.opts.uri} db=${this.opts.db})`));
      }, timeoutMs);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      DbConnection.builder()
        .withUri(this.opts.uri)
        .withDatabaseName(this.opts.db)
        .withToken(stored?.token)
        .withAutomaticReconnect()
        .onConnect((conn, identity, token) => {
          connected = true;
          const hex = identity.toHexString();
          if (!stored) {
            this.opts.identities.set(key, { identity: hex, token, createdAt: new Date().toISOString() });
            log.info("stdb", `new identity for ${key}: ${hex.slice(0, 16)}…`);
          } else if (stored.identity !== hex) {
            log.warn("stdb", `identity for ${key} changed (${stored.identity.slice(0, 12)}… -> ${hex.slice(0, 12)}…); keeping the stored one on disk`);
          }
          const actor: ActorConnection = { key, conn, identity, identityHex: hex, connected: () => connected };
          const done = () => {
            this.actors.set(key, actor);
            settle(() => resolve(actor));
          };
          if (subscriptions.length === 0) return done();
          conn
            .subscriptionBuilder()
            .onApplied(() => done())
            .onError((ctx) => {
              const msg = (ctx as { event?: Error }).event?.message ?? "subscription error";
              log.error("stdb", `subscription failed for ${key}: ${msg}`);
              settle(() => reject(new PlatformUnavailable(`subscription failed for ${key}: ${msg}`)));
            })
            .subscribe(subscriptions);
        })
        .onAutomaticReconnect(() => {
          connected = true;
          log.info("stdb", `reconnected as ${key}`);
        })
        .onDisconnect((_ctx, err) => {
          connected = false;
          log.warn("stdb", `disconnected (${key})${err ? `: ${err.message}` : ""}`);
        })
        .onConnectError((_ctx, err) => {
          const hint =
            stored && /token|401|403/i.test(err.message)
              ? ` The saved token for ${key} was rejected; if the server was reset, delete its entry in .data/identities.json and re-run bootstrap.`
              : "";
          log.error("stdb", `connect error (${key}): ${err.message}`);
          settle(() => reject(new PlatformUnavailable(`cannot connect as ${key}: ${err.message}.${hint}`)));
        })
        .build();
    });
  }

  /**
   * Call a reducer as `key` and await its outcome. SenderError -> ReducerRefused (rolled back, message
   * from the platform); anything else -> PlatformUnavailable. When the promise resolves the caller's own
   * client cache already reflects the transaction (the SDK applies the update before resolving).
   */
  async call(key: string, reducer: string, fn: (conn: DbConnection) => Promise<void>, timeoutMs = 15_000): Promise<void> {
    const actor = this.actors.get(key);
    if (!actor) throw new PlatformUnavailable(`no connection for actor ${key}`);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fn(actor.conn),
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new PlatformUnavailable(`${reducer} timed out after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } catch (e) {
      throw toPlatformError(reducer, e);
    } finally {
      clearTimeout(timer);
    }
  }

  disconnectAll(): void {
    for (const a of this.actors.values()) {
      try {
        a.conn.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.actors.clear();
  }
}

export function toPlatformError(reducer: string, e: unknown): Error {
  if (e instanceof ReducerRefused || e instanceof PlatformUnavailable) return e;
  const err = e as Error;
  if (err?.name === "SenderError") return new ReducerRefused(reducer, err.message);
  return new PlatformUnavailable(`${reducer} failed: ${err?.message ?? String(e)}`);
}

/** Poll a cache probe until it returns a value (cross-connection updates arrive asynchronously). */
export async function waitFor<T>(probe: () => T | undefined, timeoutMs = 5_000, intervalMs = 20): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== undefined) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
