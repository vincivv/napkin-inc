import type { DocumentView, OrderView, OutboxView, PlatformPort, ProcessorEventArgs, BusinessView, CreateOrderArgs } from "../src/platform";
import type { CheckoutSessionInfo, CreateRefundParams, CreateSessionParams, ProcessorGateway, RefundInfo } from "../src/payments/gateway";
import type { FeeInfo } from "../src/payments/events";

/** In-memory platform: dedupes processor events by id like the real reducer, records every call. */
export class FakePlatform implements PlatformPort {
  businesses = new Map<string, BusinessView>([["maya-cookies", { id: "maya-cookies", name: "Maya's Cookies", activeConfigId: 1n, enforce: true }]]);
  orders = new Map<string, OrderView>();
  documents = new Map<bigint, DocumentView>();
  outbox: OutboxView[] = [];
  events = new Map<string, ProcessorEventArgs>();
  calls: string[] = [];
  grants: { code: string; businessId: string; role: string }[] = [];
  attached: { orderId: string; sessionId: string; url: string }[] = [];
  intents: { orderId: string; key: string }[] = [];
  refuseCreateOrder: string | undefined;
  clock: () => number = Date.now;
  nextOutboxId = 1n;

  isConnected() { return true; }
  business(id: string) { return this.businesses.get(id); }
  order(id: string) { return this.orders.get(id); }
  async awaitOrder(id: string) { return this.orders.get(id); }
  async awaitDocument(id: bigint) { return this.documents.get(id); }
  document(id: bigint) { return this.documents.get(id); }
  documentsByExternalRef(ref: string) { return [...this.documents.values()].filter((d) => d.externalRef === ref); }
  catalogEntry(_b: string, id: string) { return { name: `Product ${id}` }; }
  outboxItems() { return this.outbox; }
  onOutboxChange() {}

  async createOrder(a: CreateOrderArgs) {
    if (this.refuseCreateOrder) {
      const { ReducerRefused } = await import("../src/stdb");
      throw new ReducerRefused("createOrder", this.refuseCreateOrder);
    }
    this.calls.push("createOrder");
    const unit = 300n;
    const total = a.lines.reduce((s, l) => s + BigInt(l.qty) * unit, 0n);
    this.documents.set(1n, {
      id: 1n, businessId: a.businessId, docType: "sale", status: "posted", externalRef: a.orderId, fields: {}, totalCents: total,
      lines: a.lines.map((l) => ({ productId: l.productId, qty: String(l.qty), unitPrice: "3.00" })),
    });
    this.orders.set(a.orderId, {
      id: a.orderId, businessId: a.businessId, status: "pending_payment", saleDocumentId: 1n, totalCents: total, paidCents: 0n,
      refundedCents: 0n, customerName: a.customerName, channel: a.channel,
    });
  }
  async logPaymentIntent(orderId: string, key: string) { this.calls.push("logPaymentIntent"); this.intents.push({ orderId, key }); }
  async attachCheckoutSession(orderId: string, sessionId: string, url: string) { this.calls.push("attachCheckoutSession"); this.attached.push({ orderId, sessionId, url }); }
  /** Returns true if the id was new. Duplicate ids are a no-op, exactly like the platform. */
  async recordProcessorEvent(a: ProcessorEventArgs) {
    this.calls.push(`recordProcessorEvent:${a.kind}`);
    if (!this.events.has(a.eventId)) {
      this.events.set(a.eventId, a);
      if (a.kind === "payment_succeeded") {
        const o = this.orders.get(a.orderId);
        if (o) this.orders.set(a.orderId, { ...o, status: "paid", paidCents: a.amountCents });
      }
    }
  }
  /** Mirrors the platform reducer enqueueOutbox: sms only, idempotent on the key, a different payload is refused. */
  async enqueueOutbox(a: { businessId: string; kind: string; payloadJson: string; idempotencyKey: string }) {
    const { ReducerRefused } = await import("../src/stdb");
    this.calls.push(`enqueueOutbox:${a.kind}`);
    if (a.kind !== "sms") throw new ReducerRefused("enqueueOutbox", `outbox kind "${a.kind}" cannot be enqueued`);
    if (new TextEncoder().encode(a.payloadJson).length > 2048) throw new ReducerRefused("enqueueOutbox", "payloadJson is larger than 2048 bytes");
    const existing = this.outbox.find((o) => o.idempotencyKey === a.idempotencyKey);
    if (existing) {
      if (existing.businessId !== a.businessId || existing.kind !== a.kind || existing.payloadJson !== a.payloadJson) throw new ReducerRefused("enqueueOutbox", `outbox item ${a.idempotencyKey} already exists with a different business, kind or payload`);
      return;
    }
    this.outbox.push({ id: this.nextOutboxId++, businessId: a.businessId, kind: a.kind, payloadJson: a.payloadJson, idempotencyKey: a.idempotencyKey, status: "pending", attempts: 0, claimedAtMs: undefined, resultJson: "" });
  }
  async claimOutbox(id: bigint) { const o = this.outbox.find((x) => x.id === id)!; o.status = "claimed"; o.attempts++; o.claimedAtMs = this.clock(); }
  async completeOutbox(id: bigint, ok: boolean, resultJson: string) { const o = this.outbox.find((x) => x.id === id)!; o.status = ok ? "done" : "failed"; o.resultJson = resultJson; }
  async createRoleGrant(a: { code: string; businessId: string; role: string }) { this.grants.push(a); }
}

export class FakeGateway implements ProcessorGateway {
  mode: "test" | "simulator" = "test";
  sessionsCreated: CreateSessionParams[] = [];
  refunds: CreateRefundParams[] = [];
  fee: FeeInfo | null = { balanceTransactionId: "txn_1", feeCents: 117n, simulated: false };
  async createCheckoutSession(p: CreateSessionParams): Promise<CheckoutSessionInfo> {
    this.sessionsCreated.push(p);
    return { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1", status: "open", expiresAt: 2_000_000_000 };
  }
  async retrieveCheckoutSession(): Promise<CheckoutSessionInfo> { return { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1", status: "open", expiresAt: 2_000_000_000 }; }
  async createRefund(p: CreateRefundParams): Promise<RefundInfo> { this.refunds.push(p); return { id: "re_1", amountCents: p.amountCents, status: "succeeded", orderId: p.metadata.orderId }; }
  async feeForPaymentIntent() { return this.fee; }
  async balanceTransactionFee(id: string): Promise<FeeInfo> { return { balanceTransactionId: id, feeCents: 117n, simulated: false }; }
  async orderIdForPaymentIntent() { return undefined; }
  async refundsForCharge(): Promise<RefundInfo[]> { return []; }
}
