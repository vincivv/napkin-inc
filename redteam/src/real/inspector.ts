// The real Inspector: prepares an attack's world on the scratch database napkin-l and reads platform state.
//
// prepare(attack, mode): re-publishes napkin-l clean and bootstraps it (see db.ts), then creates the attack's
// setup orders through the same identities and reducers the system uses: storefront createOrder (or a
// shopkeeper sale document when the attack plants an order note), payment through the brain's
// handlePaymentSucceeded with DEV SIMULATOR ids, prior refunds through requestRefund (support) +
// postDocument (bookkeeper) + the brain's outbox worker.
//
// What it cannot do honestly is refused with SetupUnsupported (the runner reports the attack "not run"):
//   - a sale older than the 24 h refund window: the platform stamps postings with its own clock and has
//     no backdating hook, so "paid 40 hours ago" cannot be created;
//   - planted text the platform refuses as input (e.g. customerName longer than 64 characters).
// Sales 0-24 h old are created now; the window outcome is the same, and the run notes the approximation.

import { businessFor, type ScratchWorld } from "./db";
import { handlePaymentSucceeded, SIM } from "./brain";
import { SimProcessor } from "./processor";
import { drainOutbox, syncOutbox } from "./outbox-drain";
import { decodeRows, normalizeBusinessRows, snapshotFromTables, SNAPSHOT_TABLES, type RawTables } from "./snapshot";
import type { Inspector } from "../run";
import type { Attack, Mode, PlatformSnapshot } from "../types";

export class SetupUnsupported extends Error {
  override name = "SetupUnsupported";
}

const REFUND_WINDOW_HOURS = 24;
const CUSTOMER_NAME_MAX = 64; // platform createSale: "customerName is too long (first name only)"

/** Pure check of what prepare() can build. Returns the reasons it cannot (empty = supported). */
export function unsupportedSetup(attack: Attack): string[] {
  const s = attack.setup ?? {};
  const out: string[] = [];
  for (const o of s.existingOrders ?? []) {
    if (o.ageHours > REFUND_WINDOW_HOURS) {
      out.push(`order ${o.orderId} must have been paid ${o.ageHours} h ago (outside the ${REFUND_WINDOW_HOURS} h refund window); the platform stamps postings with its own clock and has no backdating hook`);
    }
  }
  if (s.orderNote?.field === "customerName" && s.orderNote.text.length > CUSTOMER_NAME_MAX) {
    out.push(`the planted customerName is ${s.orderNote.text.length} characters; the platform refuses customer names over ${CUSTOMER_NAME_MAX} (input limit, both modes), so the injection cannot be planted`);
  }
  if (s.orderNote && !(s.existingOrders ?? []).some((o) => o.orderId === (s.orderNote!.orderId ?? s.existingOrders?.[0]?.orderId))) {
    out.push("the order note names an order that is not in setup.existingOrders");
  }
  return out;
}

/** Reads every snapshot table from napkin-l over HTTP SQL (one consistent read per table). */
export async function readTables(world: ScratchWorld): Promise<RawTables> {
  const out = {} as RawTables;
  for (const t of SNAPSHOT_TABLES) {
    const res = await world.sql(`SELECT * FROM ${t}`);
    const rows = res[0] ? decodeRows(res[0]) : [];
    out[t] = t === "business" ? normalizeBusinessRows(rows) : rows;
  }
  return out;
}

export async function readSnapshot(world: ScratchWorld, mode: Mode, processor: SimProcessor): Promise<PlatformSnapshot> {
  return snapshotFromTables(businessFor(mode), await readTables(world), processor.snapshotTruth());
}

export class RealInspector implements Inspector {
  processor = new SimProcessor();
  /** approximations made by the last prepare(), for the run file */
  notes: string[] = [];

  constructor(readonly world: ScratchWorld) {}

  async prepare(attack: Attack, mode: Mode): Promise<void> {
    const problems = unsupportedSetup(attack);
    if (problems.length > 0) throw new SetupUnsupported(problems.join("; "));
    this.notes = [];
    this.processor = new SimProcessor();
    await this.world.reset();

    const w = this.world;
    const biz = businessFor(mode);
    const s = attack.setup ?? {};
    const noteOrder = s.orderNote ? (s.orderNote.orderId ?? s.existingOrders?.[0]?.orderId) : undefined;

    for (const o of s.existingOrders ?? []) {
      if (o.ageHours > 0) this.notes.push(`${o.orderId}: created now, the attack says ${o.ageHours} h old (inside the refund window either way)`);
      if (o.phone) this.notes.push(`${o.orderId}: phone ${o.phone} is not stored (the platform has no phone column)`);
      const planted = o.orderId === noteOrder ? s.orderNote : undefined;
      const customerName = planted?.field === "customerName" ? planted.text : o.customerName;
      const couponCode = planted?.field === "couponCode" ? planted.text : "";

      if (planted?.field === "note") {
        // A free-text note exists only on sale documents (createOrder has no note): an agent-created order.
        const fields = [
          { name: "orderId", value: o.orderId },
          { name: "customerRef", value: customerName },
          { name: "discountRate", value: o.discountRate },
          { name: "couponCode", value: couponCode },
        ];
        const lines = o.items.map((it) => ({ values: [{ name: "productId", value: it.productId }, { name: "qty", value: String(it.qty) }] }));
        await w.hub.call(w.key("shopkeeper", mode), "createDocument", (c) =>
          c.reducers.createDocument({ businessId: biz, docType: "sale", externalRef: o.orderId, fields, lines, note: planted.text }),
        );
        this.notes.push(`${o.orderId}: created by the shopkeeper identity as a sale document so the planted note can be stored`);
      } else {
        await w.platform.createOrder({ businessId: biz, orderId: o.orderId, customerName, channel: "storefront", discountRate: o.discountRate, couponCode, lines: o.items });
      }
      const order = await w.platform.awaitOrder(o.orderId);
      if (!order) throw new Error(`setup order ${o.orderId} did not appear`);

      if (o.paid) {
        const gateway = this.processor.gateway(w.platform);
        this.processor.record({ kind: "charge", orderId: o.orderId, processorRef: SIM.paymentIntentId(o.orderId), amountCents: Number(order.totalCents) });
        await handlePaymentSucceeded(
          { eventId: SIM.eventId(o.orderId), businessId: biz, orderId: o.orderId, amountCents: order.totalCents, paymentIntentId: SIM.paymentIntentId(o.orderId) },
          { platform: w.platform, fees: gateway },
        );
      }
      if (o.refundedCents > 0) {
        if (!o.paid) throw new SetupUnsupported(`${o.orderId}: a refund needs a paid order`);
        await w.hub.call(w.key("support", mode), "requestRefund", (c) => c.reducers.requestRefund({ orderId: o.orderId, amountCents: BigInt(o.refundedCents), reason: "setup: earlier refund" }));
        const draft = await this.refundDraftId(o.orderId);
        await w.hub.call(w.key("bookkeeper", mode), "postDocument", (c) => c.reducers.postDocument({ documentId: draft }));
        await syncOutbox(w);
        await drainOutbox(w, this.processor.gateway(w.platform), { offsetMs: 0 }, 2);
      }
    }
  }

  async refundDraftId(orderId: string): Promise<bigint> {
    const res = await this.world.sql(`SELECT id FROM document WHERE doc_type = 'refund' AND status = 'draft' AND external_ref = '${orderId.replace(/'/g, "''")}'`);
    const id = res[0]?.rows.map((r) => BigInt(String(r[0]))).sort((a, b) => (a < b ? 1 : -1))[0];
    if (id === undefined) throw new Error(`no refund draft for ${orderId}`);
    return id;
  }

  snapshot(mode: Mode): Promise<PlatformSnapshot> {
    return readSnapshot(this.world, mode, this.processor);
  }
}
