// Server-side phone state.
//
// OwnerSessions: which conversations are owner-verified. IN MEMORY ONLY, with a TTL (default 30 min). It is set
// by verify_owner and nothing else; no tool parameter can set or extend it. A brain restart forgets every
// session, so the owner simply verifies again. A session is bound to (conversationId, callerId, businessId).
//
// FailureLimiter: verify_owner failures per conversation AND per caller ID within a sliding window
// (default 3 per 15 min). Once either key reaches the limit, verification is locked for that key until the
// oldest failure leaves the window, even with the right PIN.
//
// PhoneOrderStore: which caller placed which phone order (orderId -> caller E.164), plus the place_order
// idempotency index. The platform's customer_order row has no phone column, so the brain keeps this in
// .data/phone-orders.json (gitignored, mode 0600). Orders not placed by phone have no phone on record.

import path from "node:path";
import { JsonFileStore } from "../store";

export interface OwnerSession {
  conversationId: string;
  callerId: string;
  businessId: string;
  verifiedAtMs: number;
  expiresAtMs: number;
}

export const OWNER_SESSION_TTL_MS = 30 * 60_000;

export class OwnerSessions {
  private readonly sessions = new Map<string, OwnerSession>();
  constructor(
    private readonly ttlMs = OWNER_SESSION_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  grant(conversationId: string, callerId: string, businessId: string): OwnerSession {
    const t = this.now();
    const s = { conversationId, callerId, businessId, verifiedAtMs: t, expiresAtMs: t + this.ttlMs };
    this.sessions.set(conversationId, s);
    return s;
  }

  /** The live session for exactly this conversation, caller and business; otherwise undefined. */
  find(conversationId: string, callerId: string | undefined, businessId: string): OwnerSession | undefined {
    const s = this.sessions.get(conversationId);
    if (!s) return undefined;
    if (this.now() >= s.expiresAtMs) {
      this.sessions.delete(conversationId);
      return undefined;
    }
    if (!callerId || s.callerId !== callerId || s.businessId !== businessId) return undefined;
    return s;
  }

  size(): number {
    const t = this.now();
    for (const [k, s] of this.sessions) if (t >= s.expiresAtMs) this.sessions.delete(k);
    return this.sessions.size;
  }
}

export class FailureLimiter {
  private readonly fails = new Map<string, number[]>();
  constructor(
    readonly max = 3,
    readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const t = this.now();
    const xs = (this.fails.get(key) ?? []).filter((x) => t - x < this.windowMs);
    if (xs.length) this.fails.set(key, xs);
    else this.fails.delete(key);
    return xs;
  }

  /** Seconds until `key` unlocks, or 0 when it is not locked. */
  lockedFor(key: string): number {
    const xs = this.recent(key);
    if (xs.length < this.max) return 0;
    const unlockAt = xs[xs.length - this.max]! + this.windowMs;
    return Math.max(1, Math.ceil((unlockAt - this.now()) / 1000));
  }

  fail(key: string): void {
    const xs = this.recent(key);
    xs.push(this.now());
    this.fails.set(key, xs);
  }

  clear(key: string): void {
    this.fails.delete(key);
  }
}

export interface PhoneOrderRecord {
  orderId: string;
  businessId: string;
  callerId: string;
  conversationId: string;
  createdAt: string;
}

export interface PhoneOrdersData {
  orders: Record<string, PhoneOrderRecord>;
  /** place_order idempotency key -> orderId */
  placements: Record<string, string>;
}

export interface PhoneOrderStoreBackend {
  read(): PhoneOrdersData;
  update(fn: (d: PhoneOrdersData) => void): PhoneOrdersData;
}

const emptyOrders = (): PhoneOrdersData => ({ orders: {}, placements: {} });

export class FilePhoneOrderBackend extends JsonFileStore<PhoneOrdersData> implements PhoneOrderStoreBackend {
  constructor(dataDir: string) {
    super(path.join(dataDir, "phone-orders.json"), emptyOrders);
  }
}

export class MemoryPhoneOrderBackend implements PhoneOrderStoreBackend {
  private d = emptyOrders();
  read() {
    return structuredClone(this.d);
  }
  update(fn: (d: PhoneOrdersData) => void) {
    const next = structuredClone(this.d);
    fn(next);
    this.d = next;
    return structuredClone(next);
  }
}

export class PhoneOrderStore {
  constructor(private readonly backend: PhoneOrderStoreBackend) {}
  get(orderId: string): PhoneOrderRecord | undefined {
    return this.backend.read().orders[orderId];
  }
  placement(key: string): string | undefined {
    return this.backend.read().placements[key];
  }
  record(rec: PhoneOrderRecord, placementKey: string): void {
    this.backend.update((d) => {
      d.orders[rec.orderId] = rec;
      d.placements[placementKey] = rec.orderId;
    });
  }
}
