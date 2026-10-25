// Step (d), part 2: a ledger-core dry run. Before a configuration is emitted, a sample of every document
// is posted through the SAME engine the platform uses (@napkin/ledger-core post()): a sale and a full
// refund of every product, at 0% and at the maximum discount, plus payment, fee, payout, stock receipt,
// opening stock and one expense per category and paying side. Any unbalanced rule or failing check refuses the configuration.
// All amounts here are DRY-RUN SAMPLES built from the configuration's own catalog, never business facts.

import { PolicyCheckError, post, Rational, type DocumentDef, type DocumentInput, type PostingContext, type PostingResult, type Scalar } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";

export function postingContext(cfg: Configuration): PostingContext {
  const policies: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(cfg.policies)) if (typeof v === "string" || typeof v === "number") policies[k] = v;
  return { policies, catalogs: cfg.catalogs.map((c) => ({ id: c.id, lineKey: c.lineKey, entries: c.entries.map((e) => ({ id: e.id, data: e.data })) })) };
}

export function docDef(cfg: Configuration, id: string): DocumentDef {
  const d = cfg.documents.find((x) => x.id === id);
  if (!d) throw new Error(`configuration has no "${id}" document type`);
  return d as unknown as DocumentDef;
}

export function productCatalog(cfg: Configuration) {
  const c = cfg.catalogs.find((x) => x.lineKey === "productId");
  if (!c) throw new Error("configuration has no product catalog (lineKey productId)");
  return c;
}

/** A sale line priced from the catalog, exactly like the platform's fillSaleLine (invariant 6: never caller prices). */
export function saleLine(cfg: Configuration, productId: string, qty: number | string): Record<string, Scalar> {
  const e = productCatalog(cfg).entries.find((x) => x.id === productId);
  if (!e) throw new Error(`unknown product "${productId}"`);
  const get = (k: string) => {
    const v = e.data[k];
    if (v === undefined || v === null || typeof v === "boolean") throw new Error(`product "${productId}" has no ${k}`);
    return String(v);
  };
  return { productId, qty: String(qty), unitPrice: get("price"), unitCost: get("cost"), stockItem: get("stockItem"), stockUnits: get("stockUnits") };
}

export function saleInput(cfg: Configuration, lines: { productId: string; qty: number | string }[], discountRate: string, orderId = "DRYRUN"): DocumentInput {
  return { fields: { orderId, customerRef: "", discountRate, couponCode: "" }, lines: lines.map((l) => saleLine(cfg, l.productId, l.qty)) };
}

const dec = (r: Rational) => r.toDecimal(12);

export interface SaleFacts {
  saleTotal: Rational;
  saleNet: Rational;
  saleCost: Rational;
}

export function saleFacts(r: PostingResult): SaleFacts {
  let net = Rational.ZERO;
  let cost = Rational.ZERO;
  for (const l of r.computed.lines) {
    net = net.add(l["net"]!);
    cost = cost.add(l["cost"]!);
  }
  return { saleTotal: r.computed.doc["total"]!, saleNet: net, saleCost: cost };
}

export function refundInput(f: SaleFacts, amount: Rational, refundedSoFar = Rational.ZERO, hoursSinceSale: Rational = Rational.ZERO, orderId = "DRYRUN"): DocumentInput {
  return {
    fields: {
      orderId,
      amount: dec(amount),
      reason: "dry run",
      saleTotal: dec(f.saleTotal),
      saleNet: dec(f.saleNet),
      saleCost: dec(f.saleCost),
      refundedSoFar: dec(refundedSoFar),
      hoursSinceSale: dec(hoursSinceSale),
    },
    lines: [],
  };
}

/** A one-line expense (dry-run sample: the amount is not a business fact). */
export function expenseInput(account: string, amount: string, paidFrom: string): DocumentInput {
  return { fields: { vendor: "dry run", date: "2026-01-01", paidFrom, receiptRef: "" }, lines: [{ account, amount, description: "dry run" }] };
}

export interface DryRunCase {
  subject: string;
  ok: boolean;
  /** expected refusals (e.g. a sale refused at max discount by the margin floor) are ok=true, refused=true */
  refused?: string;
  debitCents?: bigint;
  creditCents?: bigint;
  error?: string;
}

export interface DryRunReport {
  ok: boolean;
  cases: DryRunCase[];
  /** products whose plain (0% discount) sale is refused: price below cost + margin floor */
  belowFloor: { productId: string; message: string }[];
}

function attempt(subject: string, fn: () => PostingResult, refusalOk = false): { c: DryRunCase; r?: PostingResult } {
  try {
    const r = fn();
    return { c: { subject, ok: true, debitCents: r.totalDebitCents, creditCents: r.totalCreditCents }, r };
  } catch (e) {
    if (refusalOk && e instanceof PolicyCheckError) return { c: { subject, ok: true, refused: e.message } };
    return { c: { subject, ok: false, error: `${(e as Error).name}: ${(e as Error).message}` } };
  }
}

export function dryRun(cfg: Configuration): DryRunReport {
  const ctx = postingContext(cfg);
  const cases: DryRunCase[] = [];
  const belowFloor: DryRunReport["belowFloor"] = [];
  const sale = docDef(cfg, "sale");
  const refund = docDef(cfg, "refund");

  for (const p of productCatalog(cfg).entries) {
    const plain = attempt(`sale/${p.id}@0`, () => post(sale, saleInput(cfg, [{ productId: p.id, qty: 1 }], "0"), ctx));
    if (!plain.r) {
      cases.push(plain.c);
      if (/margin_floor/.test(plain.c.error ?? "")) belowFloor.push({ productId: p.id, message: plain.c.error! });
      continue;
    }
    cases.push(plain.c);
    cases.push(attempt(`sale/${p.id}@maxDiscount(${cfg.policies.maxDiscount})`, () => post(sale, saleInput(cfg, [{ productId: p.id, qty: 1 }], cfg.policies.maxDiscount), ctx), true).c);
    const f = saleFacts(plain.r);
    cases.push(attempt(`refund/${p.id}/full`, () => post(refund, refundInput(f, f.saleTotal), ctx)).c);
    cases.push(attempt(`payment_received/${p.id}`, () => post(docDef(cfg, "payment_received"), { fields: { orderId: "DRYRUN", amount: dec(f.saleTotal), processorRef: "dryrun" }, lines: [] }, ctx)).c);
  }
  cases.push(attempt("processor_fee", () => post(docDef(cfg, "processor_fee"), { fields: { orderId: "DRYRUN", fee: "0.30", processorRef: "dryrun" }, lines: [] }, ctx)).c);
  cases.push(attempt("payout", () => post(docDef(cfg, "payout"), { fields: { amount: "1.00", processorRef: "dryrun" }, lines: [] }, ctx)).c);

  const stock = cfg.catalogs.find((c) => c.lineKey === "stockItem");
  for (const s of stock?.entries ?? []) {
    const unitCost = String(s.data["unitCost"] ?? "");
    cases.push(attempt(`stock_receipt/${s.id}`, () => post(docDef(cfg, "stock_receipt"), { fields: { supplier: "dryrun" }, lines: [{ stockItem: s.id, qty: "1", unitCost }] }, ctx)).c);
  }
  const opening = Object.entries(cfg.initialStock ?? {}).filter(([, q]) => q > 0);
  if (opening.length) {
    const lines = opening.map(([item, qty]) => {
      const e = stock?.entries.find((x) => x.id === item);
      return { stockItem: item, qty: String(qty), unitCost: String(e?.data["unitCost"] ?? "") };
    });
    cases.push(attempt("opening_balance", () => post(docDef(cfg, "opening_balance"), { fields: {}, lines }, ctx)).c);
  }
  // Expenses (configurations compiled before expenses existed have no such document type).
  const expense = cfg.documents.find((d) => d.id === "expense");
  if (expense) {
    const def = expense as unknown as DocumentDef;
    const accountsFrom = (side: "debit" | "credit") => expense.postingRules.flatMap((r) => (r.target.kind === "account" && r.side === side ? [r.target.code] : []));
    for (const paidFrom of accountsFrom("credit")) {
      for (const account of accountsFrom("debit")) {
        cases.push(attempt(`expense/${account}/from-${paidFrom}`, () => post(def, expenseInput(account, "1.00", paidFrom), ctx)).c);
      }
    }
  }
  return { ok: cases.every((c) => c.ok), cases, belowFloor };
}
