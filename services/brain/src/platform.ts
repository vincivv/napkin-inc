// The brain's narrow view of the platform. Everything payments/auth need goes through PlatformPort,
// so the deterministic logic can be unit-tested with a fake (test/fakes.ts) and no running database.

import { actorKey, StdbHub, waitFor } from "./stdb";

export interface BusinessView {
  id: string;
  name: string;
  activeConfigId: bigint;
  enforce: boolean;
}

export interface OrderView {
  id: string;
  businessId: string;
  status: string;
  saleDocumentId: bigint;
  totalCents: bigint;
  paidCents: bigint;
  refundedCents: bigint;
  customerName: string;
  channel: string;
}

export interface DocumentView {
  id: bigint;
  businessId: string;
  docType: string;
  status: string;
  externalRef: string;
  fields: Record<string, string>;
  lines: Record<string, string>[];
  totalCents: bigint;
}

export interface OutboxView {
  id: bigint;
  businessId: string;
  kind: string;
  payloadJson: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  claimedAtMs: number | undefined;
  resultJson: string;
}

export interface OrderLineInput {
  productId: string;
  qty: number;
}

export interface CreateOrderArgs {
  businessId: string;
  orderId: string;
  customerName: string;
  channel: string;
  discountRate: string;
  couponCode: string;
  lines: OrderLineInput[];
}

export type ProcessorEventKind = "payment_succeeded" | "fee" | "refund_succeeded" | "payout";

export interface ProcessorEventArgs {
  eventId: string;
  businessId: string;
  kind: ProcessorEventKind;
  orderId: string;
  amountCents: bigint;
  processorRef: string;
}

export interface PlatformPort {
  isConnected(): boolean;
  // reads (from the system connection's subscribed cache)
  business(id: string): BusinessView | undefined;
  order(orderId: string): OrderView | undefined;
  /** Waits briefly for an order created by another actor connection to reach the system cache. */
  awaitOrder(orderId: string, timeoutMs?: number): Promise<OrderView | undefined>;
  awaitDocument(id: bigint, timeoutMs?: number): Promise<DocumentView | undefined>;
  document(id: bigint): DocumentView | undefined;
  documentsByExternalRef(externalRef: string): DocumentView[];
  catalogEntry(businessId: string, entryId: string): Record<string, string> | undefined;
  outboxItems(): OutboxView[];
  onOutboxChange(cb: () => void): void;
  // writes. createOrder runs as the business's storefront identity; everything else as system.
  createOrder(args: CreateOrderArgs): Promise<void>;
  logPaymentIntent(orderId: string, idempotencyKey: string): Promise<void>;
  attachCheckoutSession(orderId: string, checkoutSessionId: string, checkoutUrl: string): Promise<void>;
  recordProcessorEvent(args: ProcessorEventArgs): Promise<void>;
  claimOutbox(id: bigint): Promise<void>;
  completeOutbox(id: bigint, ok: boolean, resultJson: string): Promise<void>;
  createRoleGrant(args: { code: string; businessId: string; role: string; name: string; ttlSeconds: number }): Promise<void>;
}

const fieldsToRecord = (fs: readonly { name: string; value: string }[]): Record<string, string> =>
  Object.fromEntries(fs.map((f) => [f.name, f.value]));

/** PlatformPort over live SpacetimeDB connections. */
export class StdbPlatform implements PlatformPort {
  constructor(private readonly hub: StdbHub) {}

  private get db() {
    return this.hub.system().conn.db;
  }

  isConnected(): boolean {
    return this.hub.get("system")?.connected() ?? false;
  }

  business(id: string): BusinessView | undefined {
    const b = this.db.business.id.find(id);
    return b ? { id: b.id, name: b.name, activeConfigId: b.activeConfigId, enforce: b.enforce } : undefined;
  }

  order(orderId: string): OrderView | undefined {
    const o = this.db.customerOrder.id.find(orderId);
    return (
      o ? {
        id: o.id,
        businessId: o.businessId,
        status: o.status,
        saleDocumentId: o.saleDocumentId,
        totalCents: o.totalCents,
        paidCents: o.paidCents,
        refundedCents: o.refundedCents,
        customerName: o.customerName,
        channel: o.channel,
      } : undefined
    );
  }

  awaitOrder(orderId: string, timeoutMs = 5_000) {
    return waitFor(() => this.order(orderId), timeoutMs);
  }

  awaitDocument(id: bigint, timeoutMs = 5_000) {
    return waitFor(() => this.document(id), timeoutMs);
  }

  private toDoc(d: NonNullable<ReturnType<StdbPlatform["rawDoc"]>>): DocumentView {
    return {
      id: d.id,
      businessId: d.businessId,
      docType: d.docType,
      status: d.status,
      externalRef: d.externalRef,
      fields: fieldsToRecord(d.fields),
      lines: d.lines.map((l) => fieldsToRecord(l.values)),
      totalCents: d.totalCents,
    };
  }

  private rawDoc(id: bigint) {
    return this.db.document.id.find(id);
  }

  document(id: bigint): DocumentView | undefined {
    const d = this.rawDoc(id);
    return d ? this.toDoc(d) : undefined;
  }

  documentsByExternalRef(externalRef: string): DocumentView[] {
    return [...this.db.document.externalRef.filter(externalRef)].map((d) => this.toDoc(d));
  }

  catalogEntry(businessId: string, entryId: string): Record<string, string> | undefined {
    for (const c of this.db.catalogItem.businessId.filter(businessId)) {
      if (c.active && c.entryId === entryId) return fieldsToRecord(c.data);
    }
    return undefined;
  }

  outboxItems(): OutboxView[] {
    return [...this.db.outbox.iter()].map((o) => ({
      id: o.id,
      businessId: o.businessId,
      kind: o.kind,
      payloadJson: o.payloadJson,
      idempotencyKey: o.idempotencyKey,
      status: o.status,
      attempts: o.attempts,
      claimedAtMs: o.claimedAt ? Number(o.claimedAt.microsSinceUnixEpoch / 1000n) : undefined,
      resultJson: o.resultJson,
    }));
  }

  onOutboxChange(cb: () => void): void {
    this.db.outbox.onInsert(() => cb());
    this.db.outbox.onUpdate?.(() => cb());
  }

  createOrder(a: CreateOrderArgs): Promise<void> {
    return this.hub.call(actorKey("storefront", a.businessId), "createOrder", (c) => c.reducers.createOrder(a));
  }

  logPaymentIntent(orderId: string, idempotencyKey: string): Promise<void> {
    return this.hub.call("system", "logPaymentIntent", (c) => c.reducers.logPaymentIntent({ orderId, idempotencyKey }));
  }

  attachCheckoutSession(orderId: string, checkoutSessionId: string, checkoutUrl: string): Promise<void> {
    return this.hub.call("system", "attachCheckoutSession", (c) =>
      c.reducers.attachCheckoutSession({ orderId, checkoutSessionId, checkoutUrl }),
    );
  }

  recordProcessorEvent(a: ProcessorEventArgs): Promise<void> {
    return this.hub.call("system", "recordProcessorEvent", (c) => c.reducers.recordProcessorEvent(a));
  }

  claimOutbox(id: bigint): Promise<void> {
    return this.hub.call("system", "claimOutbox", (c) => c.reducers.claimOutbox({ id }));
  }

  completeOutbox(id: bigint, ok: boolean, resultJson: string): Promise<void> {
    return this.hub.call("system", "completeOutbox", (c) => c.reducers.completeOutbox({ id, ok, resultJson }));
  }

  createRoleGrant(a: { code: string; businessId: string; role: string; name: string; ttlSeconds: number }): Promise<void> {
    return this.hub.call("system", "createRoleGrant", (c) => c.reducers.createRoleGrant(a));
  }
}
