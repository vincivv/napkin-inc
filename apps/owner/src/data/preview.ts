// PREVIEW MODE ONLY (?preview=fixture). A small, clearly fake dataset for checking the design when the
// local database is empty. It is derived from the hand-written Maya fixture and posted through the real
// @napkin/ledger-core engine, so its books balance the same way the platform's would. Every customer,
// order, fee and agent decision here is invented for the preview and is never written anywhere.

import { Identity, Timestamp } from "spacetimedb";
import { post, reversalOf, balanceKey, type DocumentDef, type DocumentInput, type PostingContext, type PostingResult, type Scalar } from "@napkin/ledger-core";
import { parseConfiguration, type Configuration } from "@napkin/schema";
import { parseDollars } from "@/lib/money";
import fixtureJson from "../../../../fixtures/maya/configuration.json";
import type { Actions, ActorRow, AuditLogRow, CustomerOrderRow, DecisionRecordRow, DocLine, DocumentRow, FieldValue, InboxItemRow, JournalLineRow, OwnerStatementRow, ProcessorEventRow, RegisterBalanceRow, RegisterMovementRow, Session, Snapshot } from "./types";

const BIZ = "maya-cookies";
const HOUR = 3_600_000_000n; // micros
const MIN = 60_000_000n;

const ident = (n: number) => new Identity(BigInt(n) * 0x1000000000000000000000000000000000000000000000000000000000001n);
export const PREVIEW_IDS = {
  me: ident(1), // the owner app's own identity in preview
  system: ident(2),
  storefront: ident(3),
  shopkeeper: ident(4),
  support: ident(5),
  bookkeeper: ident(6),
} as const;
type Who = keyof typeof PREVIEW_IDS;
const ROLE: Record<Who, string> = { me: "owner", system: "system", storefront: "storefront", shopkeeper: "shopkeeper", support: "support", bookkeeper: "bookkeeper" };

const fv = (rec: Record<string, Scalar>): FieldValue[] => Object.entries(rec).map(([name, value]) => ({ name, value: String(value) }));
const toRec = (vals: readonly FieldValue[]): Record<string, string> => Object.fromEntries(vals.map((v) => [v.name, v.value]));

class PreviewWorld {
  config: Configuration;
  ctx: PostingContext;
  now: bigint;
  signedIn = false;
  s: Snapshot;
  private ids = { doc: 0n, jl: 0n, mv: 0n, dec: 0n, inbox: 0n, stmt: 0n, audit: 0n, prec: 0n };
  private numbers = new Map<string, bigint>();
  private listeners = new Set<() => void>();
  private results = new Map<bigint, Pick<PostingResult, "journal" | "movements">>();

  constructor() {
    this.config = parseConfiguration(fixtureJson);
    const policies: Record<string, Scalar> = {};
    for (const [k, v] of Object.entries(this.config.policies)) if (typeof v === "string" || typeof v === "number") policies[k] = v;
    this.ctx = { policies, catalogs: this.config.catalogs };
    this.now = BigInt(Date.now()) * 1000n;
    const ts = new Timestamp(this.now - 30n * HOUR);
    this.s = {
      businessId: BIZ,
      businesses: [{ id: BIZ, name: this.config.business.name, activeConfigId: 1n, enforce: true, createdAt: ts }],
      business: undefined,
      configVersions: [
        { id: 1n, businessId: BIZ, version: 1, json: JSON.stringify(fixtureJson), proofReportJson: "", status: "active", submittedBy: PREVIEW_IDS.system, submittedAt: ts, activatedBy: PREVIEW_IDS.system, activatedAt: ts },
      ],
      actors: (["system", "storefront", "shopkeeper", "support", "bookkeeper"] as const).map((w) => ({ identity: PREVIEW_IDS[w], businessId: w === "system" ? "*" : BIZ, role: ROLE[w], name: `${w} (preview)`, grantedAt: ts })),
      catalogItems: [],
      documents: [],
      journalLines: [],
      registerMovements: [],
      registerBalances: [],
      periods: [],
      orders: [],
      processorEvents: [],
      outbox: [],
      decisions: [],
      inbox: [],
      precedents: [],
      ownerStatements: [],
      audit: [],
    };
    this.s.business = this.s.businesses[0];
    this.seed();
  }

  // ---------- store plumbing ----------
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.s;
  private commit(patch: Partial<Snapshot>) {
    this.s = { ...this.s, ...patch };
    for (const l of this.listeners) l();
  }

  private def(docType: string): DocumentDef & { approval: Configuration["documents"][number]["approval"] } {
    const d = this.config.documents.find((x) => x.id === docType);
    if (!d) throw new Error(`no document type ${docType}`);
    return d;
  }
  private period(at: bigint) {
    const d = new Date(Number(at / 1000n));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  // ---------- document lifecycle (mirrors the platform contract, in memory) ----------
  private createDoc(who: Who, docType: string, fields: Record<string, Scalar>, lines: Record<string, Scalar>[], at: bigint, externalRef = "", note = ""): DocumentRow {
    const id = ++this.ids.doc;
    const n = (this.numbers.get(docType) ?? 0n) + 1n;
    this.numbers.set(docType, n);
    const doc: DocumentRow = {
      id, businessId: BIZ, docType, number: n, status: "draft", period: this.period(at), externalRef,
      fields: fv(fields), lines: lines.map((l): DocLine => ({ values: fv(l) })), totalCents: 0n, configId: 1n,
      createdBy: PREVIEW_IDS[who], createdByRole: ROLE[who], approvedBy: undefined, approvedByRole: "", createdAt: new Timestamp(at), postedAt: undefined,
      reversalOf: 0n, reversedBy: 0n, note,
    };
    const input: DocumentInput = { fields: toRec(doc.fields), lines: doc.lines.map((l) => toRec(l.values)) };
    try {
      const r = post(this.def(docType), input, this.ctx);
      const total = r.computed.doc["total"] ?? r.computed.doc["value"];
      const amount = input.fields["amount"] ?? input.fields["fee"];
      doc.totalCents = total ? total.toCents() : amount !== undefined ? parseDollars(String(amount)) : r.totalDebitCents;
    } catch {
      /* drafts may fail checks until posted */
    }
    this.commit({ documents: [...this.s.documents, doc] });
    this.audit(who, "create_document", `${docType} #${n} draft${externalRef ? ` for ${externalRef}` : ""}`, at);
    return doc;
  }

  private writePostings(doc: DocumentRow, r: Pick<PostingResult, "journal" | "movements">, at: bigint) {
    const journal: JournalLineRow[] = r.journal.map((j) => ({
      id: ++this.ids.jl, businessId: BIZ, documentId: doc.id, accountCode: j.account, period: doc.period, debitCents: j.debitCents, creditCents: j.creditCents,
      ruleId: j.ruleId, memo: j.memo ?? "", lineIndex: j.lineIndex ?? -1, postedAt: new Timestamp(at),
    }));
    const moves: RegisterMovementRow[] = r.movements.map((m) => ({
      id: ++this.ids.mv, businessId: BIZ, documentId: doc.id, registerId: m.register, dimsKey: balanceKey(m.register, m.dims).split("|")[1] ?? "", kind: m.kind,
      qty: m.qty, amountCents: m.amountCents, period: doc.period, postedAt: new Timestamp(at),
    }));
    const balances = new Map(this.s.registerBalances.map((b) => [b.key, b]));
    for (const m of moves) {
      const key = `${BIZ}|${m.registerId}|${m.dimsKey}`;
      const b = balances.get(key) ?? { key, businessId: BIZ, registerId: m.registerId, dimsKey: m.dimsKey, qty: 0n, amountCents: 0n };
      const sgn = m.kind === "in" ? 1n : -1n;
      const next: RegisterBalanceRow = { ...b, qty: b.qty + sgn * m.qty, amountCents: b.amountCents + sgn * m.amountCents };
      const reg = this.config.registers.find((x) => x.id === m.registerId);
      if (reg?.kind === "balance" && !reg.allowNegative && next.qty < 0n) throw new Error(`stock would go negative (${m.dimsKey}: ${next.qty})`);
      balances.set(key, next);
    }
    this.results.set(doc.id, r);
    this.commit({ journalLines: [...this.s.journalLines, ...journal], registerMovements: [...this.s.registerMovements, ...moves], registerBalances: [...balances.values()] });
  }

  private postDoc(docId: bigint, who: Who, at: bigint) {
    const doc = this.s.documents.find((d) => d.id === docId);
    if (!doc) throw new Error("no such document");
    if (doc.status !== "draft") throw new Error(`document is ${doc.status}, only drafts can be posted`);
    const def = this.def(doc.docType);
    if (!def.approval.approverRoles.includes(ROLE[who])) throw new Error(`${ROLE[who]} may not approve ${doc.docType}`);
    if (def.approval.cannotApproveOwn && doc.createdBy.isEqual(PREVIEW_IDS[who])) throw new Error("segregation of duties: the creator of a document cannot approve it");
    const r = post(def, { fields: toRec(doc.fields), lines: doc.lines.map((l) => toRec(l.values)) }, this.ctx);
    const posted: DocumentRow = { ...doc, status: "posted", approvedBy: PREVIEW_IDS[who], approvedByRole: ROLE[who], postedAt: new Timestamp(at) };
    this.writePostings(posted, r, at);
    this.commit({ documents: this.s.documents.map((d) => (d.id === docId ? posted : d)) });
    this.audit(who, "post_document", `${doc.docType} #${doc.number} posted (${r.journal.length} journal lines)`, at);
    return posted;
  }

  private createAndPost(creator: Who, approver: Who, docType: string, fields: Record<string, Scalar>, lines: Record<string, Scalar>[], at: bigint, externalRef = "", note = "") {
    const d = this.createDoc(creator, docType, fields, lines, at, externalRef, note);
    return this.postDoc(d.id, approver, at);
  }

  private reverse(docId: bigint, who: Who, reason: string, at: bigint) {
    const orig = this.s.documents.find((d) => d.id === docId);
    if (!orig) throw new Error("no such document");
    if (orig.status !== "posted") throw new Error(`document is ${orig.status}; only posted documents can be reversed`);
    const res = this.results.get(docId);
    if (!res) throw new Error("no postings recorded for this document");
    const id = ++this.ids.doc;
    const n = (this.numbers.get(orig.docType) ?? 0n) + 1n;
    this.numbers.set(orig.docType, n);
    const rev: DocumentRow = { ...orig, id, number: n, status: "posted", period: this.period(at), createdBy: PREVIEW_IDS[who], createdByRole: ROLE[who], approvedBy: PREVIEW_IDS[who], approvedByRole: ROLE[who], createdAt: new Timestamp(at), postedAt: new Timestamp(at), reversalOf: orig.id, reversedBy: 0n, note: reason };
    this.commit({ documents: [...this.s.documents.map((d) => (d.id === docId ? { ...d, status: "reversed", reversedBy: id } : d)), rev] });
    this.writePostings(rev, reversalOf(res), at);
    this.audit(who, "reverse_document", `${orig.docType} #${orig.number} reversed: ${reason}`, at);
  }

  private audit(who: Who, reducer: string, summary: string, at: bigint, ok = true) {
    const row: AuditLogRow = { id: ++this.ids.audit, businessId: BIZ, actorRole: ROLE[who], reducer, summary, ok, timestamp: new Timestamp(at) };
    this.commit({ audit: [...this.s.audit, row] });
  }

  private decide(who: Who, action: string, outcome: string, ruleIds: string[], reason: string, wouldChangeIf: string, at: bigint, documentRef = "") {
    const row: DecisionRecordRow = { id: ++this.ids.dec, businessId: BIZ, actorKind: who === "system" ? "system" : who === "me" ? "owner" : "agent", actorId: ROLE[who], action, documentRef, ruleIds, evidenceRefs: [], inputsHash: "preview", outcome, reason, wouldChangeIf, timestamp: new Timestamp(at) };
    this.commit({ decisions: [...this.s.decisions, row] });
  }

  private feeCents(total: bigint) {
    // invented preview fee (2.9% + 30¢ rounded half up); the real fee comes from Stripe's balance transaction
    return (total * 29n + 500n) / 1000n + 30n;
  }

  private sale(orderId: string, customerName: string, items: [string, number][], at: bigint, opts: { discountRate?: string; pay?: boolean } = {}) {
    const products = this.config.catalogs.find((c) => c.id === "products")!;
    const lines = items.map(([pid, qty]) => {
      const e = products.entries.find((x) => x.id === pid)!.data;
      return { productId: pid, qty, unitPrice: String(e["price"]), unitCost: String(e["cost"]), stockItem: String(e["stockItem"] ?? ""), stockUnits: String(e["stockUnits"] ?? "0") };
    });
    const doc = this.createDoc("storefront", "sale", { orderId, customerRef: customerName, discountRate: opts.discountRate ?? "0", couponCode: "" }, lines, at, orderId);
    const order: CustomerOrderRow = { id: orderId, businessId: BIZ, status: "pending_payment", saleDocumentId: doc.id, totalCents: doc.totalCents, paidCents: 0n, refundedCents: 0n, customerName, channel: "storefront", createdAt: new Timestamp(at), paidAt: undefined };
    this.commit({ orders: [...this.s.orders, order] });
    if (opts.pay !== false) this.pay(orderId, at + 2n * MIN);
    return order;
  }

  private pay(orderId: string, at: bigint) {
    const order = this.s.orders.find((o) => o.id === orderId)!;
    const evt = `evt_preview_${orderId}`;
    const pr = this.createAndPost("system", "system", "payment_received", { orderId, amount: centsStr(order.totalCents), processorRef: evt }, [], at, orderId);
    this.postDoc(order.saleDocumentId, "system", at);
    const fee = this.feeCents(order.totalCents);
    const fd = this.createAndPost("system", "system", "processor_fee", { orderId, fee: centsStr(fee), processorRef: `${evt}_fee` }, [], at + 1n, orderId);
    const ev: ProcessorEventRow[] = [
      { eventId: evt, businessId: BIZ, kind: "payment_succeeded", orderId, amountCents: order.totalCents, documentId: pr.id, receivedAt: new Timestamp(at) },
      { eventId: `${evt}_fee`, businessId: BIZ, kind: "fee", orderId, amountCents: fee, documentId: fd.id, receivedAt: new Timestamp(at + 1n) },
    ];
    this.commit({ processorEvents: [...this.s.processorEvents, ...ev], orders: this.s.orders.map((o) => (o.id === orderId ? { ...o, status: "paid", paidCents: o.totalCents, paidAt: new Timestamp(at) } : o)) });
    this.decide("system", "record_processor_event", "executed", ["exactly_once.processor_event"], `Payment ${evt} recorded once and the sale posted in the same transaction.`, "", at, `order:${orderId}`);
  }

  private setOrder(orderId: string, status: string) {
    this.commit({ orders: this.s.orders.map((o) => (o.id === orderId ? { ...o, status } : o)) });
  }

  private seed() {
    const t0 = this.now - 26n * HOUR;
    this.createAndPost("system", "system", "opening_balance", {}, [{ stockItem: "choc_chip_cookie", qty: 48, unitCost: "0.80" }], t0, "", "initial stock from configuration (placeholder quantity)");

    // yesterday
    this.sale("MC-7K2Q9", "Sam", [["cookie_box6", 1]], t0 + 2n * HOUR);
    this.setOrder("MC-7K2Q9", "picked_up");
    this.sale("MC-3HD8A", "Ana", [["cookie_single", 3], ["sea_salt", 1]], t0 + 3n * HOUR);
    this.setOrder("MC-3HD8A", "picked_up");
    const payout = this.createDoc("system", "payout", { amount: "14.26", processorRef: "po_preview_1" }, [], t0 + 8n * HOUR, "", "simulated test-mode payout");
    this.postDoc(payout.id, "me", t0 + 8n * HOUR + 5n * MIN);

    const bad = this.createDoc("bookkeeper", "stock_receipt", { supplier: "Home kitchen batch" }, [{ stockItem: "choc_chip_cookie", qty: 240, unitCost: "0.80" }], t0 + 9n * HOUR);
    this.postDoc(bad.id, "me", t0 + 9n * HOUR + MIN);
    this.reverse(bad.id, "me", "typo: 240 entered instead of 24", t0 + 9n * HOUR + 4n * MIN);

    // today
    const t1 = this.now - 5n * HOUR;
    this.sale("MC-P2R4T", "Priya", [["cookie_single", 2], ["sea_salt", 2]], t1);
    this.setOrder("MC-P2R4T", "ready");
    this.sale("MC-J9X1C", "Jordan", [["cookie_box6", 1]], t1 + HOUR, { discountRate: "0.10" });
    this.decide("shopkeeper", "quote", "allowed", ["sale.discount_cap", "sale.margin_floor"], "10% club discount is within the 20% cap and keeps the box above cost + 30%.", "A discount above 20% or a price below cost + 30% would be refused.", t1 + HOUR - 3n * MIN, "order:MC-J9X1C");
    this.sale("MC-L5E2W", "Lee", [["cookie_single", 1]], t1 + 2n * HOUR, { pay: false });
    this.sale("MC-A8N3V", "Alex", [["cookie_box6", 1]], t1 + 2n * HOUR + 20n * MIN);
    const refund = this.createDoc("support", "refund", { orderId: "MC-A8N3V", amount: "15.00", reason: "box arrived crushed", saleTotal: "15.00", saleNet: "15.00", saleCost: "4.80", refundedSoFar: "0", hoursSinceSale: "1" }, [], t1 + 3n * HOUR, "MC-A8N3V", "awaiting approval by owner or bookkeeper");
    this.decide("support", "request_refund", "allowed", ["refund.refund_window", "refund.refund_full_or_floor", "role.support.maxRefundCents"], "Full refund of $15.00 within the 24h window and under the support limit; drafted for approval (support cannot approve its own refund).", "Over $15.00 or after 24 hours it would be escalated to the owner.", t1 + 3n * HOUR, `document:${refund.id}`);
    this.createDoc("bookkeeper", "stock_receipt", { supplier: "Home kitchen batch" }, [{ stockItem: "choc_chip_cookie", qty: 24, unitCost: "0.80" }], t1 + 3n * HOUR + 10n * MIN, "", "fresh batch, needs owner approval");

    this.decide("shopkeeper", "quote", "refused", ["sale.discount_cap", "sale.margin_floor"], "Customer asked for 35% off a Box of 6; the maximum discount is 20%.", "The owner raises the maximum discount in a new configuration.", t1 + 3n * HOUR + 30n * MIN);
    this.decide("shopkeeper", "escalate", "escalated", ["escalation.discount_above_policy"], "Bulk order of 10 boxes with 25% off is above policy; asked the owner.", "A precedent for bulk orders would let me answer directly.", t1 + 3n * HOUR + 40n * MIN, "inbox:1");
    this.decide("bookkeeper", "reconcile", "allowed", ["inv2.stripe_reconciles"], "Stripe clearing (1010) matches processor events: payments minus fees minus payouts.", "Any mismatch would open an inbox item.", t1 + 4n * HOUR);

    const inbox: InboxItemRow[] = [
      { id: ++this.ids.inbox, businessId: BIZ, fromRole: "shopkeeper", question: "A customer wants 10 Boxes of 6 for a club event and asks for 25% off. Our cap is 20%. Should I offer 20%, or do you want to approve 25% for this order?", contextJson: JSON.stringify({ customer: "club (preview)", qty: 10, product: "cookie_box6", requestedDiscount: "0.25" }), documentRef: "", status: "open", answer: "", createdAt: new Timestamp(t1 + 3n * HOUR + 40n * MIN), answeredAt: undefined },
      { id: ++this.ids.inbox, businessId: BIZ, fromRole: "support", question: "A customer says their order was cold. Refund or offer a free cookie next time?", contextJson: "{}", documentRef: "order:MC-3HD8A", status: "answered", answer: "Offer a free cookie next time; refunds only for damaged or missing items.", createdAt: new Timestamp(t0 + 5n * HOUR), answeredAt: new Timestamp(t0 + 6n * HOUR) },
    ];
    this.commit({
      inbox,
      precedents: [{ id: ++this.ids.prec, businessId: BIZ, agentRole: "support", rule: "Cold or late orders: offer a free cookie next time; refund only damaged or missing items.", conditionJson: "{}", sourceInboxId: 2n, createdAt: new Timestamp(t0 + 6n * HOUR) }],
      ownerStatements: [
        { id: ++this.ids.stmt, businessId: BIZ, channel: "phone", text: "Make the box of six sixteen dollars starting tomorrow.", diffJson: JSON.stringify([{ path: "catalogs.products.entries.cookie_box6.data.price", from: "15.00", to: "16.00" }]), status: "queued", createdAt: new Timestamp(t1 + 4n * HOUR), decidedAt: undefined } satisfies OwnerStatementRow,
        { id: ++this.ids.stmt, businessId: BIZ, channel: "app", text: "Sea-salt topping is always $1.", diffJson: "[]", status: "confirmed", createdAt: new Timestamp(t0), decidedAt: new Timestamp(t0) },
      ],
      periods: [{ key: `${BIZ}|${this.period(this.now)}`, businessId: BIZ, month: this.period(this.now), status: "open", closedBy: undefined, closedAt: undefined }],
    });
  }

  // ---------- owner actions (preview) ----------
  private requireOwner() {
    if (!this.signedIn) throw new Error("sign in as the owner first");
  }
  private nowTs() {
    return BigInt(Date.now()) * 1000n;
  }

  actions: Actions & { simulateSale(): void; signIn(): void; signOut(): void } = {
    updateOrderStatus: async (orderId, status) => {
      this.requireOwner();
      const o = this.s.orders.find((x) => x.id === orderId);
      if (!o) throw new Error("no such order");
      const ok = (o.status === "paid" && status === "ready") || (o.status === "ready" && status === "picked_up") || (o.status === "paid" && status === "picked_up");
      if (!ok) throw new Error(`cannot move an order from ${o.status} to ${status}`);
      this.setOrder(orderId, status);
      this.audit("me", "update_order_status", `${orderId} -> ${status}`, this.nowTs());
    },
    postDocument: async (id) => {
      this.requireOwner();
      const at = this.nowTs();
      const doc = this.postDoc(id, "me", at);
      if (doc.docType === "refund") {
        const f = toRec(doc.fields);
        const amt = parseDollars(f["amount"] ?? "0");
        this.commit({ orders: this.s.orders.map((o) => (o.id === f["orderId"] ? { ...o, refundedCents: o.refundedCents + amt, status: o.refundedCents + amt >= o.paidCents ? "refunded" : "partially_refunded" } : o)) });
      }
    },
    reverseDocument: async (id, reason) => {
      this.requireOwner();
      if (!reason.trim()) throw new Error("a reason is required");
      this.reverse(id, "me", reason.trim(), this.nowTs());
    },
    answerInbox: async (id, answer, makePrecedent, precedentRule) => {
      this.requireOwner();
      const at = this.nowTs();
      const item = this.s.inbox.find((i) => i.id === id);
      if (!item || item.status !== "open") throw new Error("inbox item is not open");
      this.commit({ inbox: this.s.inbox.map((i) => (i.id === id ? { ...i, status: "answered", answer, answeredAt: new Timestamp(at) } : i)) });
      if (makePrecedent) this.commit({ precedents: [...this.s.precedents, { id: ++this.ids.prec, businessId: BIZ, agentRole: item.fromRole, rule: precedentRule || answer, conditionJson: "{}", sourceInboxId: id, createdAt: new Timestamp(at) }] });
      this.audit("me", "answer_inbox", `inbox #${id} answered${makePrecedent ? " (precedent)" : ""}`, at);
    },
    decideOwnerStatement: async (id, confirm) => {
      this.requireOwner();
      const at = this.nowTs();
      this.commit({ ownerStatements: this.s.ownerStatements.map((s) => (s.id === id && s.status === "queued" ? { ...s, status: confirm ? "confirmed" : "rejected", decidedAt: new Timestamp(at) } : s)) });
      this.audit("me", "decide_owner_statement", `statement #${id} ${confirm ? "confirmed" : "rejected"}`, at);
    },
    redeemRoleGrant: async () => {
      throw new Error("not used in preview");
    },
    activateConfiguration: async (configId) => {
      this.requireOwner();
      const at = this.nowTs();
      const row = this.s.configVersions.find((c) => c.id === configId);
      if (!row || row.status !== "pending") throw new Error(`configuration ${configId} is not pending`);
      const prev = this.s.businesses[0]!.activeConfigId;
      this.commit({
        configVersions: this.s.configVersions.map((c) => (c.id === configId ? { ...c, status: "active", activatedBy: PREVIEW_IDS.me, activatedAt: new Timestamp(at) } : c.id === prev ? { ...c, status: "superseded" } : c)),
        businesses: this.s.businesses.map((b) => ({ ...b, activeConfigId: configId })),
      });
      this.commit({ business: this.s.businesses[0] });
      this.audit("me", "activate_configuration", `config ${configId} (v${row.version}) active`, at);
    },
    simulateSale: () => {
      const at = this.nowTs();
      const names = ["Riley", "Morgan", "Casey", "Taylor", "Jamie", "Quinn"];
      const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
      const id = "MC-" + Math.random().toString(36).slice(2, 7).toUpperCase();
      const items: [string, number][] = pick([[["cookie_single", 2]], [["cookie_box6", 1]], [["cookie_single", 1], ["sea_salt", 1]]]);
      try {
        this.sale(id, pick(names), items, at);
      } catch (e) {
        this.audit("storefront", "create_order", `refused: ${e instanceof Error ? e.message : String(e)}`, at, false);
      }
    },
    signIn: () => {
      this.signedIn = true;
      this.commit({ actors: [...this.s.actors, { identity: PREVIEW_IDS.me, businessId: BIZ, role: "owner", name: "Owner (preview)", grantedAt: new Timestamp(this.nowTs()) } satisfies ActorRow] });
    },
    signOut: () => {
      this.signedIn = false;
      this.commit({ actors: this.s.actors.filter((a) => !a.identity.isEqual(PREVIEW_IDS.me)) });
    },
  };

  session(): Session {
    return { mode: "preview", status: "connected", ready: true, error: undefined, identityHex: PREVIEW_IDS.me.toHexString(), role: this.signedIn ? "owner" : "", uri: "preview", dbName: "fixture" };
  }
}

function centsStr(c: bigint): string {
  const s = c.toString().padStart(3, "0");
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

let world: PreviewWorld | undefined;
export function previewWorld(): PreviewWorld {
  return (world ??= new PreviewWorld());
}
export type { PreviewWorld };
