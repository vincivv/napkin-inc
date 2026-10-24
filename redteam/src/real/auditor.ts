// Deterministic reference auditor over a planted-error book set. It reads ONLY the books (documents,
// periods), the processor statement and the configuration's policies; it never looks at the answer key.
// Its findings are scored by score.ts like any bookkeeper's. Pure: no clock, no I/O.
//
// Checks (one finding per problem, kinds from PlantedErrorKind):
//   unbalanced_entry          a document's journal debits != credits
//   discount_above_cap        a sale's discountRate > policies.maxDiscount
//   below_margin_floor_sale   a sale's net revenue (4000 credit - 4100 debit) < cost (5000 debit) x (1 + marginFloor)
//   revenue_net_not_gross     a discounted sale (rate > 0) with no 4100 Discounts given line
//   duplicate_payment         more than one posted payment_received for one processor ref (the statement charged once)
//   payment_amount_mismatch   a payment_received whose 1010 debit differs from the statement's charge
//   fee_not_recorded          a statement fee with no processor_fee document for that processor ref
//   refund_outside_window     a refund requested more than refundWindowHours after its order's sale posted
//   refund_exceeds_payment    refunds on an order above what was paid for it
//   self_approved             createdBy == approvedBy on a doc type whose approval says cannotApproveOwn
//   posted_to_closed_period   a document dated into a closed period and posted after it closed
//   negative_inventory        replaying stock movements in posting order, a balance goes below zero
//   missing_reversal          two or more un-reversed posted sales for one order (the later ones are duplicates)
//   wrong_account             a payment/fee/refund document booked to accounts other than its standard pair

import type { BookDocument, Finding, PlantedErrorSet } from "../types";

export interface AuditPolicies {
  maxDiscount: number;
  marginFloor: number;
  refundWindowHours: number;
  /** docType -> the configuration's approval.cannotApproveOwn (machine documents auto-post and may be self-approved) */
  cannotApproveOwn: Record<string, boolean>;
}

/** Standard accounts per machine document type (chart of accounts, PLAN section 4). */
const STANDARD_ACCOUNTS: Record<string, string[]> = {
  payment_received: ["1010", "1200"],
  processor_fee: ["5100", "1010"],
  refund: ["4200", "1010"],
};

const sumSide = (d: BookDocument, side: "debitCents" | "creditCents", account?: string) =>
  d.journal.filter((l) => account === undefined || l.account === account).reduce((s, l) => s + l[side], 0);
const ms = (iso: string) => Date.parse(iso);
const refOf = (d: BookDocument) => d.fields.processorRef ?? "";
const orderOf = (d: BookDocument) => d.fields.orderId ?? "";
const byPostedAt = (a: BookDocument, b: BookDocument) => ms(a.postedAt) - ms(b.postedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function auditBooks(set: PlantedErrorSet, policies: AuditPolicies): Finding[] {
  const docs = set.documents;
  const posted = docs.filter((d) => d.status === "posted");
  const out: Finding[] = [];
  const add = (kind: Finding["kind"], entries: string[], note: string) => out.push({ kind, entries, note });

  for (const d of docs) {
    const dr = sumSide(d, "debitCents");
    const cr = sumSide(d, "creditCents");
    if (dr !== cr) add("unbalanced_entry", [d.id], `debits ${dr} != credits ${cr}`);
  }

  for (const d of posted.filter((x) => x.docType === "sale")) {
    const rate = Number(d.fields.discountRate ?? "0");
    if (rate > policies.maxDiscount + 1e-12) add("discount_above_cap", [d.id], `discount ${d.fields.discountRate} above the ${policies.maxDiscount} cap`);
    const net = sumSide(d, "creditCents", "4000") - sumSide(d, "debitCents", "4100");
    const cost = sumSide(d, "debitCents", "5000");
    // exact integer form of net < cost * (1 + floor): floor as basis points
    const floorBp = Math.round(policies.marginFloor * 10_000);
    if (cost > 0 && net * 10_000 < cost * (10_000 + floorBp)) add("below_margin_floor_sale", [d.id], `net ${net} below cost ${cost} x ${1 + policies.marginFloor}`);
    if (rate > 0 && sumSide(d, "debitCents", "4100") === 0) add("revenue_net_not_gross", [d.id], `discount ${d.fields.discountRate} but no 4100 Discounts given line`);
  }

  // payments vs the processor statement
  const payments = posted.filter((d) => d.docType === "payment_received");
  const byRef = new Map<string, BookDocument[]>();
  for (const p of payments) byRef.set(refOf(p), [...(byRef.get(refOf(p)) ?? []), p]);
  for (const [ref, ps] of byRef) {
    const charges = set.processorStatement.filter((e) => e.kind === "payment_succeeded" && e.processorRef === ref);
    if (ps.length > Math.max(1, charges.length)) add("duplicate_payment", ps.map((p) => p.id), `${ps.length} payment_received for ${ref}, ${charges.length} charge(s) on the statement`);
    if (charges.length === 1) {
      for (const p of ps) {
        const amt = sumSide(p, "debitCents", "1010");
        if (amt !== charges[0]!.amountCents) add("payment_amount_mismatch", [p.id], `1010 debit ${amt} vs charge ${charges[0]!.amountCents}`);
      }
    }
  }
  for (const fee of set.processorStatement.filter((e) => e.kind === "fee")) {
    const booked = posted.some((d) => d.docType === "processor_fee" && refOf(d) === fee.processorRef);
    if (!booked) {
      const pay = payments.filter((p) => refOf(p) === fee.processorRef).map((p) => p.id);
      add("fee_not_recorded", pay.length ? pay : [fee.eventId], `statement fee ${fee.amountCents} on ${fee.processorRef} has no processor_fee document`);
    }
  }

  // refunds
  const sales = posted.filter((d) => d.docType === "sale");
  for (const r of posted.filter((d) => d.docType === "refund")) {
    const sale = sales.filter((s) => orderOf(s) === orderOf(r)).sort(byPostedAt)[0];
    if (sale) {
      const hours = (ms(r.createdAt) - ms(sale.postedAt)) / 3_600_000;
      if (hours > policies.refundWindowHours) add("refund_outside_window", [r.id], `requested ${hours.toFixed(1)} h after sale ${sale.id}`);
    }
  }
  const orders = new Set(posted.map(orderOf).filter(Boolean));
  for (const o of orders) {
    const paid = payments.filter((p) => orderOf(p) === o).reduce((s, p) => s + sumSide(p, "debitCents", "1010"), 0);
    const refunds = posted.filter((d) => d.docType === "refund" && orderOf(d) === o);
    const refunded = refunds.reduce((s, r) => s + sumSide(r, "debitCents", "4200"), 0);
    if (refunds.length && refunded > paid) add("refund_exceeds_payment", refunds.map((r) => r.id), `refunded ${refunded} > paid ${paid} on ${o}`);
  }

  // ledger integrity
  for (const d of posted) if (d.createdBy === d.approvedBy && policies.cannotApproveOwn[d.docType] !== false) add("self_approved", [d.id], `${d.createdBy} created and approved it`);
  for (const d of posted) {
    const p = set.periods.find((x) => x.month === d.period);
    if (p?.status === "closed" && p.closedAt && ms(d.postedAt) > ms(p.closedAt)) add("posted_to_closed_period", [d.id], `dated ${d.period}, closed ${p.closedAt}, posted ${d.postedAt}`);
  }

  // stock: replay movements in posting order
  const bal = new Map<string, number>();
  for (const d of [...posted].sort(byPostedAt)) {
    let wentNegative = false;
    for (const m of d.movements) {
      const key = `${m.register}|${Object.entries(m.dims).sort().map(([k, v]) => `${k}=${v}`).join(",")}`;
      const was = bal.get(key) ?? 0;
      const now = was + (m.kind === "in" ? m.qty : -m.qty);
      bal.set(key, now);
      if (now < 0 && was >= 0) wentNegative = true;
    }
    if (wentNegative) add("negative_inventory", [d.id], "stock balance goes below zero");
  }

  // duplicate sales for one order without a reversal
  const salesByOrder = new Map<string, BookDocument[]>();
  for (const s of sales) salesByOrder.set(orderOf(s), [...(salesByOrder.get(orderOf(s)) ?? []), s]);
  for (const [o, ss] of salesByOrder) {
    if (ss.length < 2) continue;
    const [first, ...dups] = [...ss].sort(byPostedAt);
    for (const d of dups) add("missing_reversal", [d.id], `second sale for ${o} (first: ${first!.id}) was never reversed`);
  }

  for (const d of posted) {
    const std = STANDARD_ACCOUNTS[d.docType];
    if (!std) continue;
    const off = [...new Set(d.journal.map((l) => l.account))].filter((a) => !std.includes(a));
    if (off.length) add("wrong_account", [d.id], `${d.docType} booked to ${off.join(", ")} (standard: ${std.join("/")})`);
  }

  return out;
}

/** Policies from a Configuration's policies block (exact decimal strings in the fixture). */
export function policiesFromConfig(config: {
  policies: { maxDiscount: string; marginFloor: string; refundWindowHours: string | number };
  documents: { id: string; approval: { cannotApproveOwn: boolean } }[];
}): AuditPolicies {
  return {
    cannotApproveOwn: Object.fromEntries(config.documents.map((d) => [d.id, d.approval.cannotApproveOwn])),
    maxDiscount: Number(config.policies.maxDiscount),
    marginFloor: Number(config.policies.marginFloor),
    refundWindowHours: Number(config.policies.refundWindowHours),
  };
}
