// The phone line's read/write slice of the platform. A separate port (like M2Platform) so the existing
// PlatformPort and its fakes stay untouched. Reads come from the brain's system connection cache;
// the only write is openInbox (as the system actor). Orders are created through createCheckout.

import { log } from "../log";
import { PlatformUnavailable, type StdbHub } from "../stdb";

export interface CatalogRowView {
  catalog: string;
  entryId: string;
  data: Record<string, string>;
}

export interface PhoneOrderView {
  id: string;
  businessId: string;
  status: string;
  totalCents: bigint;
  paidCents: bigint;
  refundedCents: bigint;
  customerName: string;
  channel: string;
  createdAtMs: number;
  paidAtMs: number | undefined;
}

export interface StockBalanceView {
  registerId: string;
  dimsKey: string;
  qty: bigint;
}

export interface PhonePlatform {
  isConnected(): boolean;
  /** Shops the line can serve: live configuration and guards on (the store index's rule; hides the red-team baseline). */
  shops(): { id: string; name: string }[];
  /** Resolves once every table the phone tools read is in the client cache (throws PlatformUnavailable otherwise). */
  ready(): Promise<void>;
  /** Live catalog rows of the ACTIVE configuration (active=true, configId = business.activeConfigId). */
  catalog(businessId: string): CatalogRowView[];
  balances(businessId: string): StockBalanceView[];
  orders(businessId: string): PhoneOrderView[];
  order(orderId: string): PhoneOrderView | undefined;
  openInboxCount(businessId: string): number;
  /** IANA zone from the active configuration (business.timezone), if any. */
  timezone(businessId: string): string | undefined;
  openInbox(a: { businessId: string; question: string; contextJson: string; documentRef: string }): Promise<void>;
  /** system: queue a platform outbox row (reducer enqueueOutbox; only kind "sms"). Idempotent on idempotencyKey. */
  enqueueOutbox(a: { businessId: string; kind: string; payloadJson: string; idempotencyKey: string }): Promise<void>;
  /** The queued row's current state from the client cache, if it has arrived. */
  outboxRow(idempotencyKey: string): { status: string; resultJson: string } | undefined;
}

const fieldsToRecord = (fs: readonly { name: string; value: string }[]): Record<string, string> => Object.fromEntries(fs.map((f) => [f.name, f.value]));
const tsMs = (t: { microsSinceUnixEpoch: bigint } | undefined) => (t ? Number(t.microsSinceUnixEpoch / 1000n) : undefined);

/**
 * PhonePlatform over the system connection. register_balance and inbox_item are not in the system connection's
 * subscription set, so they are subscribed on first use and every tool call awaits ready() first (otherwise the
 * first call after startup would read an empty stock table and say "sold out").
 */
export class StdbPhonePlatform implements PhonePlatform {
  private applied: Promise<void> | undefined;
  constructor(private readonly hub: StdbHub) {}

  private sys() {
    return this.hub.get("system");
  }

  ready(): Promise<void> {
    const s = this.sys();
    if (!s) return Promise.reject(new PlatformUnavailable("system connection not established"));
    if (!this.applied) {
      this.applied = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new PlatformUnavailable("timed out subscribing to register_balance/inbox_item")), 10_000);
        s.conn
          .subscriptionBuilder()
          .onApplied(() => {
            clearTimeout(timer);
            resolve();
          })
          .onError(() => {
            clearTimeout(timer);
            reject(new PlatformUnavailable("subscription to register_balance/inbox_item failed"));
          })
          .subscribe(["SELECT * FROM register_balance", "SELECT * FROM inbox_item"]);
      }).catch((e: unknown) => {
        this.applied = undefined; // retry on the next call
        log.warn("phone", (e as Error).message);
        throw e;
      });
    }
    return this.applied;
  }

  isConnected(): boolean {
    return this.hub.get("system")?.connected() ?? false;
  }

  shops(): { id: string; name: string }[] {
    const s = this.sys();
    if (!s) return [];
    return [...s.conn.db.business.iter()].filter((b) => b.activeConfigId > 0n && b.enforce).map((b) => ({ id: b.id, name: b.name }));
  }

  catalog(businessId: string): CatalogRowView[] {
    const s = this.sys();
    if (!s) return [];
    const biz = s.conn.db.business.id.find(businessId);
    if (!biz || biz.activeConfigId === 0n) return [];
    return [...s.conn.db.catalogItem.businessId.filter(businessId)]
      .filter((c) => c.active && c.configId === biz.activeConfigId)
      .map((c) => ({ catalog: c.catalog, entryId: c.entryId, data: fieldsToRecord(c.data) }));
  }

  balances(businessId: string): StockBalanceView[] {
    const s = this.sys();
    if (!s) return [];
    return [...s.conn.db.registerBalance.businessId.filter(businessId)].map((b) => ({ registerId: b.registerId, dimsKey: b.dimsKey, qty: b.qty }));
  }

  private toOrder(o: { id: string; businessId: string; status: string; totalCents: bigint; paidCents: bigint; refundedCents: bigint; customerName: string; channel: string; createdAt: { microsSinceUnixEpoch: bigint }; paidAt?: { microsSinceUnixEpoch: bigint } | undefined }): PhoneOrderView {
    return {
      id: o.id,
      businessId: o.businessId,
      status: o.status,
      totalCents: o.totalCents,
      paidCents: o.paidCents,
      refundedCents: o.refundedCents,
      customerName: o.customerName,
      channel: o.channel,
      createdAtMs: tsMs(o.createdAt) ?? 0,
      paidAtMs: tsMs(o.paidAt ?? undefined),
    };
  }

  orders(businessId: string): PhoneOrderView[] {
    const s = this.sys();
    if (!s) return [];
    return [...s.conn.db.customerOrder.businessId.filter(businessId)].map((o) => this.toOrder(o));
  }

  order(orderId: string): PhoneOrderView | undefined {
    const o = this.sys()?.conn.db.customerOrder.id.find(orderId);
    return o ? this.toOrder(o) : undefined;
  }

  openInboxCount(businessId: string): number {
    const s = this.sys();
    if (!s) return 0;
    return [...s.conn.db.inboxItem.businessId.filter(businessId)].filter((i) => i.status === "open").length;
  }

  timezone(businessId: string): string | undefined {
    const s = this.sys();
    const biz = s?.conn.db.business.id.find(businessId);
    if (!s || !biz || biz.activeConfigId === 0n) return undefined;
    const cv = s.conn.db.configVersion.id.find(biz.activeConfigId);
    if (!cv) return undefined;
    try {
      const tz = (JSON.parse(cv.json) as { business?: { timezone?: unknown } }).business?.timezone;
      return typeof tz === "string" && tz ? tz : undefined;
    } catch {
      return undefined;
    }
  }

  async openInbox(a: { businessId: string; question: string; contextJson: string; documentRef: string }): Promise<void> {
    await this.hub.call("system", "openInbox", (c) => c.reducers.openInbox(a));
  }

  async enqueueOutbox(a: { businessId: string; kind: string; payloadJson: string; idempotencyKey: string }): Promise<void> {
    await this.hub.call("system", "enqueueOutbox", (c) => c.reducers.enqueueOutbox(a));
  }

  outboxRow(idempotencyKey: string): { status: string; resultJson: string } | undefined {
    const o = [...(this.sys()?.conn.db.outbox.iter() ?? [])].find((x) => x.idempotencyKey === idempotencyKey);
    return o ? { status: o.status, resultJson: o.resultJson } : undefined;
  }
}
