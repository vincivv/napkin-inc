// StaffBackend over the brain's live SpacetimeDB connections. Writes run as the agent's OWN identity
// (shopkeeper@biz, support@biz, bookkeeper@biz), so the platform checks the role it holds; the brain
// never passes a role as an argument. Orders go through the storefront checkout path (checkoutOrder).

import { checkoutOrder, type CheckoutDeps } from "../payments/checkout";
import { actorKey, PlatformUnavailable, waitFor, type StdbHub } from "../stdb";
import type { StaffBackend } from "./backend";
import type { BookDoc, BookSet } from "./books";
import type { StaffRole } from "./types";

const LEDGER_SUBSCRIPTIONS = ["SELECT * FROM journal_line", "SELECT * FROM register_movement", "SELECT * FROM period", "SELECT * FROM processor_event", "SELECT * FROM precedent", "SELECT * FROM register_balance"];
const iso = (t: { microsSinceUnixEpoch: bigint } | undefined | null) => (t ? new Date(Number(t.microsSinceUnixEpoch / 1000n)).toISOString() : undefined);
const rec = (fs: readonly { name: string; value: string }[]) => Object.fromEntries(fs.map((f) => [f.name, f.value]));

export class StdbStaffBackend implements StaffBackend {
  private subscribed: Promise<void> | undefined;

  constructor(
    private readonly hub: StdbHub,
    private readonly checkout: CheckoutDeps,
  ) {}

  private get db() {
    return this.hub.system().conn.db;
  }

  private key(role: StaffRole, businessId: string) {
    const k = actorKey(role, businessId);
    if (!this.hub.get(k)) throw new PlatformUnavailable(`the brain holds no ${role} identity for ${businessId} (run bootstrap)`);
    return k;
  }

  identity(role: StaffRole, businessId: string) {
    return this.hub.get(actorKey(role, businessId))?.identityHex;
  }

  async createOrder(i: { businessId: string; lines: { productId: string; qty: number }[]; customerName: string; discountRate: string; couponCode: string }) {
    this.key("shopkeeper", i.businessId);
    const r = await checkoutOrder({ businessId: i.businessId, lines: i.lines, customerName: i.customerName, couponCode: i.couponCode, discountRate: i.discountRate, channel: "agent", asRole: "shopkeeper" }, this.checkout);
    const order = this.checkout.platform.order(r.orderId);
    return { orderId: r.orderId, totalCents: (order?.totalCents ?? 0n).toString(), payUrl: r.url, simulated: r.simulated };
  }

  orderStatus(businessId: string, orderId: string) {
    const o = this.db.customerOrder.id.find(orderId);
    if (!o || o.businessId !== businessId) return undefined;
    // no customer name: chat callers are not verified, so nothing personal is returned
    return { orderId: o.id, status: o.status, totalCents: o.totalCents.toString(), paidCents: o.paidCents.toString(), refundedCents: o.refundedCents.toString(), channel: o.channel, paidAt: iso(o.paidAt) ?? null };
  }

  async requestRefund(role: StaffRole, businessId: string, a: { orderId: string; amountCents: number; reason: string }) {
    const before = new Set([...this.db.document.externalRef.filter(a.orderId)].map((d) => d.id));
    await this.hub.call(this.key(role, businessId), "requestRefund", (c) => c.reducers.requestRefund({ orderId: a.orderId, amountCents: BigInt(a.amountCents), reason: a.reason }));
    const doc = await waitFor(() => [...this.db.document.externalRef.filter(a.orderId)].find((d) => d.docType === "refund" && !before.has(d.id)));
    return { documentId: doc?.id.toString() };
  }

  async approveRefund(role: StaffRole, businessId: string, documentId: string) {
    await this.hub.call(this.key(role, businessId), "postDocument", (c) => c.reducers.postDocument({ documentId: BigInt(documentId) }));
  }

  async openInbox(role: StaffRole, businessId: string, i: { question: string; documentRef: string; contextJson: string }) {
    await this.hub.call(this.key(role, businessId), "openInbox", (c) => c.reducers.openInbox({ businessId, question: i.question, contextJson: i.contextJson, documentRef: i.documentRef.slice(0, 64) }));
  }

  private ready(): Promise<void> {
    this.subscribed ??= new Promise<void>((resolve, reject) => {
      this.hub
        .system()
        .conn.subscriptionBuilder()
        .onApplied(() => resolve())
        .onError(() => reject(new PlatformUnavailable("ledger subscription failed")))
        .subscribe(LEDGER_SUBSCRIPTIONS);
    }).catch((e) => {
      this.subscribed = undefined;
      throw e;
    });
    return this.subscribed;
  }

  async stock(businessId: string): Promise<Map<string, bigint>> {
    await this.ready();
    const m = new Map<string, bigint>();
    for (const b of this.db.registerBalance.businessId.filter(businessId)) {
      const item = /^item=(.+)$/.exec(b.dimsKey)?.[1];
      if (b.registerId === "stock" && item) m.set(item, b.qty);
    }
    return m;
  }

  async books(businessId: string): Promise<BookSet> {
    await this.ready();
    const db = this.db;
    const actors = new Map([...db.actor.iter()].map((a) => [a.identity.toHexString(), a.role]));
    const journal = new Map<bigint, BookDoc["journal"]>();
    for (const j of db.journalLine.businessId.filter(businessId)) {
      const arr = journal.get(j.documentId) ?? [];
      arr.push({ account: j.accountCode, debitCents: Number(j.debitCents), creditCents: Number(j.creditCents), memo: j.memo });
      journal.set(j.documentId, arr);
    }
    const moves = new Map<bigint, BookDoc["movements"]>();
    for (const m of db.registerMovement.businessId.filter(businessId)) {
      const arr = moves.get(m.documentId) ?? [];
      arr.push({ register: m.registerId, dims: Object.fromEntries(m.dimsKey.split(",").filter(Boolean).map((kv) => kv.split("=") as [string, string])), kind: m.kind === "in" ? "in" : "out", qty: Number(m.qty), amountCents: Number(m.amountCents) });
      moves.set(m.documentId, arr);
    }
    const documents: BookDoc[] = [...db.document.businessId.filter(businessId)]
      .filter((d) => d.status !== "draft")
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(-300)
      .map((d) => ({
        id: d.id.toString(),
        docType: d.docType,
        status: d.status,
        period: d.period,
        createdAt: iso(d.createdAt),
        postedAt: iso(d.postedAt),
        createdBy: d.createdByRole,
        approvedBy: d.approvedBy ? (actors.get(d.approvedBy.toHexString()) ?? d.approvedByRole) : d.approvedByRole,
        externalRef: d.externalRef,
        fields: rec(d.fields),
        lines: d.lines.map((l) => rec(l.values)),
        journal: journal.get(d.id) ?? [],
        movements: moves.get(d.id) ?? [],
        reversalOf: d.reversalOf === 0n ? null : d.reversalOf.toString(),
        note: d.note,
      }));
    const periods = [...db.period.businessId.filter(businessId)].map((p) => ({ month: p.month, status: p.status, closedAt: iso(p.closedAt) ?? null }));
    const processorStatement = [...db.processorEvent.iter()]
      .filter((e) => e.businessId === businessId)
      .map((e) => {
        const doc = e.documentId === 0n ? undefined : db.document.id.find(e.documentId);
        return { eventId: e.eventId, kind: e.kind, orderId: e.orderId, processorRef: doc ? (rec(doc.fields)["processorRef"] ?? "") : "", amountCents: Number(e.amountCents), at: iso(e.receivedAt) };
      });
    return {
      label: `live books of ${businessId}`,
      documents,
      periods,
      processorStatement,
      statementSource: "the platform's processor_event table (events as received from the processor's webhooks, not a fresh read of Stripe)",
    };
  }
}
