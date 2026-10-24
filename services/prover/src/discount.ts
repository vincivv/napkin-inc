// Discount-stacking proof.
//
// Sales: for every product in the catalog, every quantity 1..qtyMax and every combination of a
// base discount plus up to maxCouponsPerOrder coupons (each a rate in basis points) whose TOTAL
// passes the sale document's own checks (so the total is capped at maxDiscount), every line
// still sells at or above cost * (1 + marginFloor). The sale document's margin-floor check is
// left OUT of the preconditions: the point is that the discount policy alone guarantees the
// floor, so the runtime margin check is a backstop that never refuses a policy-compliant sale.
//
// Refunds: every refund the refund document's checks accept leaves the sale fully refunded or
// with retained >= saleCost * (1 + marginFloor) (decision D4).

import { compile, computeDocument, evalBool, names, Rational, runChecks } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { niceModel, resolveBounds } from "./balance";
import { addNV, constNV, encodeBool, intNV, type NV } from "./encode";
import { ceilCents, fractionWithPct, money, rate } from "./format";
import {
  asDef,
  buildSymbolicDoc,
  entryCombos,
  inferCatalogBindings,
  numericPolicies,
  postingContext,
  rootCatalogs,
  type DocumentType,
  type InputVar,
  type SymbolicDoc,
} from "./symbolic";
import { DEFAULT_TIMEOUT_MS, type ProofResult, type ProveOptions, type ProverDetail } from "./types";
import { checkValidated, getZ3, type Z3, type ZArith, type ZBool, type ZModel } from "./z3";

const DEFAULT_GOAL = "line.net >= line.cost * (1 + policy.marginFloor)";
const REFUND_GOAL = "doc.refundedAfter == doc.saleTotal || doc.retained >= doc.saleCost * (1 + policy.marginFloor)";

type Outcome = { status: "proved" } | { status: "failed"; sym: SymbolicDoc; model: ZModel } | { status: "unknown"; reason: string } | { status: "vacuous" };

interface SaleSetup {
  sale: DocumentType;
  rateField: string;
  goal: string;
  omit: Set<string>;
  coupons: number;
}

function saleSetup(cfg: Configuration): SaleSetup | string {
  const sale = cfg.documents.find((d) => d.id === "sale") ?? cfg.documents.find((d) => d.derived.some((x) => x.name === "net") && d.derived.some((x) => x.name === "cost"));
  if (!sale) return "no sale document";
  const rateField = sale.fields.find((f) => f.type === "rate")?.name;
  if (!rateField) return "the sale document has no discount rate field";
  if (numericPolicies(cfg).marginFloor === undefined) return "no numeric marginFloor policy";
  const marginChecks = sale.checks.filter((c) => names(compile(c.assert)).has("policy.marginFloor"));
  const goal = marginChecks.find((c) => c.scope === "line")?.assert ?? DEFAULT_GOAL;
  try {
    names(compile(goal));
  } catch (e) {
    return `cannot parse the margin-floor condition: ${(e as Error).message}`;
  }
  const coupons = cfg.policies.couponsAllowed ? cfg.policies.maxCouponsPerOrder : 0;
  return { sale, rateField, goal, omit: new Set(marginChecks.map((c) => c.id)), coupons };
}

/** discountRate = base + coupon_1 + ... + coupon_m, each a rate in [0,1] (basis points), total in [0,1]. */
function stackedRate(z: Z3, prefix: string, coupons: number, RD: bigint) {
  const vars: InputVar[] = [];
  const domain: ZBool[] = [];
  let total: NV = constNV(z, Rational.ZERO);
  const steps = [500n, 100n, 50n, 10n].map((bp) => (RD * bp) / 10_000n);
  for (let j = 0; j <= coupons; j++) {
    const key = j === 0 ? "discount.base" : `discount.coupon${j}`;
    const b = z.Int.const(`${prefix}.${key}`) as unknown as ZArith;
    domain.push(b.ge(0), b.le(z.Int.val(RD)));
    vars.push({ key, type: "component", term: b, nice: (t) => (steps[t] && steps[t]! > 1n ? [b.mod(z.Int.val(steps[t]!)).eq(0)] : []) });
    total = addNV(z, total, intNV(b, RD));
  }
  const totalTerm = total as NV & { k: "i" };
  domain.push(totalTerm.t.le(z.Int.val(RD)));
  return { value: total, vars, domain };
}

let uid = 0;

async function checkProduct(z: Z3, cfg: Configuration, S: SaleSetup, lineEntries: Record<string, string>, opts: ProveOptions): Promise<Outcome> {
  const bounds = resolveBounds(opts.bounds);
  const prefix = `d${++uid}`;
  const ov = stackedRate(z, prefix, S.coupons, bounds.rateDenominator);
  const sym = buildSymbolicDoc(z, cfg, S.sale, {
    K: 1,
    mode: "bound",
    bounds,
    bindings: opts.bindings,
    lineEntries: [lineEntries],
    docOverrides: { [S.rateField]: ov },
    omitChecks: S.omit,
    policyOverrides: opts.policyOverrides,
    prefix,
  });
  const pre = [...sym.domain, ...sym.checks.map((c) => c.term), ...sym.side];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const vac = await checkValidated(z, pre, timeoutMs);
  if (vac.status === "unsat") return { status: "vacuous" };
  const goal = encodeBool(compile(S.goal), sym.lineScopes[0]!);
  const base = [...pre, z.Not(goal)];
  const r = await checkValidated(z, base, timeoutMs);
  if (r.status === "unsat") return { status: "proved" };
  if (r.status === "unknown") return { status: "unknown", reason: r.reason };
  return { status: "failed", sym, model: await niceModel(z, sym, base, r.model) };
}

/** Per-unit price and cost of a product at qty 1 with no discount (via the ledger-core evaluator). */
function unitEconomics(cfg: Configuration, S: SaleSetup, cx: ReturnType<SymbolicDoc["extract"]>) {
  const input = structuredClone(cx);
  input.fields[S.rateField] = "0";
  input.lines[0]!.qty = "1";
  try {
    const c = computeDocument(asDef(S.sale), input, postingContext(cfg)).computed.lines[0]!;
    const P = c.net ?? c.gross;
    const C = c.cost;
    return P && C ? { P, C } : undefined;
  } catch {
    return undefined;
  }
}

const bpFloor = (r: Rational, RD: bigint) => Rational.of(r.mul(Rational.of(RD)).floor(), RD);

export async function proveDiscountStacking(cfg: Configuration, opts: ProveOptions = {}): Promise<ProofResult> {
  const t0 = performance.now();
  const z = await getZ3();
  const bounds = resolveBounds(opts.bounds);
  const RD = bounds.rateDenominator;
  const log = opts.log;
  const details: ProverDetail[] = [];
  const policies = { ...numericPolicies(cfg), ...(opts.policyOverrides ?? {}) };
  const mf = policies.marginFloor;
  const maxD = policies.maxDiscount;

  const S = saleSetup(cfg);
  if (typeof S === "string") {
    log?.push(`discount proof skipped: ${S}`);
    return { status: "skipped", durationMs: Math.round(performance.now() - t0), details: [] };
  }
  const bindings = opts.bindings ?? inferCatalogBindings(cfg, S.sale);
  const roots = rootCatalogs(cfg, S.sale, bindings);
  const independent = !S.sale.derived.some((d) => d.scope === "line" && [...names(compile(d.expr))].some((n) => S.sale.derived.some((x) => x.scope === "doc" && n === `doc.${x.name}`)));
  const stackText = S.coupons > 0 ? `a base discount plus up to ${S.coupons} coupon${S.coupons > 1 ? "s" : ""}` : "a single discount (coupons not allowed)";
  const capText = maxD ? `total capped at ${rate(maxD)} by the sale's checks` : "total limited by the sale's checks";
  const safeMaxes: Rational[] = [];
  const failedProducts: string[] = [];

  for (const [entries] of entryCombos(cfg, S.sale, 1, bindings)) {
    const id = Object.values(entries!).join("+");
    const subject = `${S.sale.id}/${id}`;
    const out = await checkProduct(z, cfg, S, entries!, opts);
    if (out.status === "vacuous") {
      log?.push(`discount ${id}: no valid sale exists (skipped)`);
      continue;
    }
    if (out.status === "unknown") {
      details.push({ subject, status: "failed", message: `solver could not decide (${out.reason}); this is NOT a proof.` });
      continue;
    }
    if (out.status === "proved") {
      details.push({
        subject,
        status: "proved",
        message: `every sale of 1..${bounds.qtyMax} × ${id} with ${stackText} (${capText}) nets at least cost × (1 + ${mf ? rate(mf) : "marginFloor"}) on the line${independent ? "; lines are independent, so this covers every cart" : ""}.`,
      });
      continue;
    }
    failedProducts.push(id);
    const input = out.sym.extract(out.model);
    const cx = out.sym.describe(out.model);
    let replay = "";
    let netText = "";
    try {
      const ctx = postingContext(cfg);
      if (opts.policyOverrides) for (const [k, v] of Object.entries(opts.policyOverrides)) ctx.policies[k] = `${v.num}/${v.den}`;
      const envs = computeDocument(asDef(S.sale), input, ctx);
      const line = envs.computed.lines[0]!;
      const holds = evalBool(compile(S.goal), envs.lineEnv(0));
      const accepted = runChecks(asDef({ ...S.sale, checks: S.sale.checks.filter((c) => !S.omit.has(c.id)) }), input, ctx, envs).length === 0;
      replay = !holds && accepted ? " Replayed through ledger-core: the discount checks accept it and the margin floor fails." : " WARNING: ledger-core replay disagrees (encoder/evaluator mismatch; please report).";
      if (line.net && line.cost && mf) {
        cx["line[0].net"] = money(line.net);
        cx["line[0].floor"] = money(line.cost.mul(Rational.ONE.add(mf)));
        netText = ` it nets ${money(line.net)}, below cost ${money(line.cost)} × ${Rational.ONE.add(mf).toDecimal(4)} = ${money(line.cost.mul(Rational.ONE.add(mf)))}`;
      }
    } catch (e) {
      replay = ` (replay error: ${(e as Error).message})`;
    }
    const totalRate = Rational.parse(String(input.fields[S.rateField]));
    cx[`doc.${S.rateField}`] = rate(totalRate);

    // fixes: the exact max safe discount for this product, verified; or the min price at the current cap
    const fixes: string[] = [];
    const econ = unitEconomics(cfg, S, input);
    if (econ && mf && econ.P.gt(Rational.ZERO)) {
      const exactMax = Rational.ONE.sub(Rational.ONE.add(mf).mul(econ.C).div(econ.P));
      if (exactMax.lt(Rational.ZERO)) fixes.push(`even with no discount ${id} sells below cost × (1 + marginFloor); raise its price.`);
      else {
        const cand = bpFloor(exactMax, RD);
        const ok = await checkProduct(z, cfg, S, entries!, { ...opts, policyOverrides: { ...(opts.policyOverrides ?? {}), maxDiscount: cand } });
        if (ok.status === "proved") {
          safeMaxes.push(cand);
          fixes.push(`max safe total discount for ${id} is ${fractionWithPct(exactMax)} = 1 - (1 + ${mf.toDecimal(4)}) × ${money(econ.C)} / ${money(econ.P)}; verified: with maxDiscount ${cand.eq(exactMax) ? fractionWithPct(cand) : rate(cand)} it holds`);
        } else fixes.push(`the break-even discount for ${id} is ${fractionWithPct(exactMax)} (rounding makes it unsafe; use a lower cap)`);
      }
      if (maxD && maxD.lt(Rational.ONE)) {
        const priceBinding = bindings.find((b) => /price/i.test(b.lineField) && entries![b.catalogId]);
        const minPrice = ceilCents(Rational.ONE.add(mf).mul(econ.C).div(Rational.ONE.sub(maxD)));
        if (priceBinding) {
          const cfg2 = structuredClone(cfg);
          const entry = cfg2.catalogs.find((c) => c.id === priceBinding.catalogId)!.entries.find((e) => e.id === entries![priceBinding.catalogId])!;
          entry.data[priceBinding.field] = minPrice.toDecimal(2);
          const ok = await checkProduct(z, cfg2, S, entries!, opts);
          fixes.push(`or raise the price of ${id} to at least ${money(minPrice)} (= cost × (1 + marginFloor) / (1 - maxDiscount), rounded up to a cent)${ok.status === "proved" ? "; verified" : " (not sufficient because of rounding)"}`);
        }
      }
    }
    details.push({
      subject,
      status: "failed",
      counterexample: cx,
      input,
      message: `${cx["line[0].qty"] ?? "?"} × ${id} with a ${rate(totalRate)} total discount (${stackText}) passes the discount checks but${netText || " breaks the margin floor"}.${replay}`,
      suggestedFix: fixes.length ? fixes.join("; ") + "." : undefined,
    });
  }

  // one cap that is safe for every product, verified
  if (failedProducts.length && safeMaxes.length === failedProducts.length) {
    const cap = safeMaxes.reduce((a, b) => (a.lt(b) ? a : b));
    let allOk = true;
    for (const [entries] of entryCombos(cfg, S.sale, 1, bindings)) {
      const r = await checkProduct(z, cfg, S, entries!, { ...opts, policyOverrides: { ...(opts.policyOverrides ?? {}), maxDiscount: cap } });
      if (r.status !== "proved" && r.status !== "vacuous") allOk = false;
    }
    const first = details.find((d) => d.status === "failed" && d.counterexample);
    if (first && allOk) first.suggestedFix = `Set maxDiscount to at most ${fractionWithPct(cap)} (the smallest per-product safe cap); verified for every product. ${first.suggestedFix ?? ""}`.trim();
  }
  if (!roots.length) log?.push("discount proof: the sale has no catalog-chosen lines; checked one free line");

  // ---------- refunds (D4) ----------
  const refund = cfg.documents.find((d) => d.id === "refund");
  const refundNames = refund ? new Set([...refund.fields.map((f) => `doc.${f.name}`), ...refund.derived.map((d) => `doc.${d.name}`)]) : new Set<string>();
  const needed = [...names(compile(REFUND_GOAL))].filter((n) => n.startsWith("doc."));
  if (refund && needed.every((n) => refundNames.has(n))) {
    const sym = buildSymbolicDoc(z, cfg, refund, { K: 0, mode: "free", bounds, policyOverrides: opts.policyOverrides, prefix: `r${++uid}` });
    const pre = [...sym.domain, ...sym.checks.map((c) => c.term), ...sym.side];
    const base = [...pre, z.Not(encodeBool(compile(REFUND_GOAL), sym.docScope))];
    const r = await checkValidated(z, base, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (r.status === "unsat")
      details.push({ subject: `${refund.id}/margin_floor`, status: "proved", message: `every refund the ${refund.id} checks accept leaves the sale fully refunded or with retained ≥ saleCost × (1 + marginFloor), for any sale amounts.` });
    else if (r.status === "unknown") details.push({ subject: `${refund.id}/margin_floor`, status: "failed", message: `solver could not decide (${r.reason}); this is NOT a proof.` });
    else {
      const m = await niceModel(z, sym, base, r.model);
      details.push({
        subject: `${refund.id}/margin_floor`,
        status: "failed",
        counterexample: sym.describe(m),
        message: `a partial refund the ${refund.id} checks accept leaves the sale below cost plus the margin floor.`,
        suggestedFix: `Add a doc-scope check to ${refund.id}: "${REFUND_GOAL}" (refund in full, or keep retained ≥ cost × (1 + marginFloor)).`,
      });
    }
  } else log?.push("refund margin-floor proof skipped: no refund document with saleTotal/saleCost/refundedAfter/retained");

  const failed = details.some((d) => d.status === "failed");
  const durationMs = Math.round(performance.now() - t0);
  log?.push(`discount stacking: ${failed ? "FAILED" : "proved"} (${details.length} subjects, ${durationMs} ms)`);
  return { status: details.length === 0 ? "skipped" : failed ? "failed" : "proved", durationMs, details };
}
