// The guard's rules, as ONE pure function of structured inputs: evaluate(call, world).
// It reads the active configuration, precedents and platform-computed facts; it never reads free text.
// Money checks run the real posting engine (@napkin/ledger-core post()) on catalog prices, so the guard
// and the platform cannot disagree about what a sale or refund does.

import { post, PolicyCheckError, Rational, type PostingContext } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { z } from "zod";
import { docDef, postingContext, productCatalog, saleInput } from "../compiler/dryrun";
import { fixed2 } from "../compiler";
import { TOOLS, type ToolSpec } from "./tools";
import { SOURCES, type GuardCall, type GuardDecision, type GuardWorld, type MaxAllowed, type PrecedentRow } from "./types";

export type Evaluation = Omit<GuardDecision, "inputsHash" | "escalation">;

// ---------- precedents ----------

const Dec = z.string().regex(/^\d+(\.\d+)?$/);
/** Structured precedent condition (precedent.conditionJson). Every field can only TIGHTEN. */
export const PrecedentCondition = z.object({
  tool: z.union([z.string(), z.array(z.string())]).optional(),
  productIds: z.array(z.string()).optional(),
  maxDiscount: Dec.optional(),
  maxRefundCents: z.number().int().min(0).optional(),
  refundWindowHours: Dec.optional(),
  outcome: z.enum(["refuse", "escalate"]).optional(),
});
export type PrecedentCondition = z.infer<typeof PrecedentCondition>;

interface ActivePrecedent {
  id: string;
  rule: string;
  cond: PrecedentCondition;
}

function matchingPrecedents(precedents: PrecedentRow[], role: string, tool: string, productIds: string[], notes: string[]): ActivePrecedent[] {
  const out: ActivePrecedent[] = [];
  for (const p of precedents) {
    if (p.agentRole !== role && p.agentRole !== "*") continue;
    let raw: unknown;
    try {
      raw = p.conditionJson.trim() === "" ? {} : JSON.parse(p.conditionJson);
    } catch {
      notes.push(`precedent ${p.id} ignored (conditionJson is not JSON); policy applies`);
      continue;
    }
    const c = PrecedentCondition.safeParse(raw);
    if (!c.success) {
      notes.push(`precedent ${p.id} ignored (unrecognized condition); policy applies`);
      continue;
    }
    const tools = c.data.tool === undefined ? undefined : Array.isArray(c.data.tool) ? c.data.tool : [c.data.tool];
    if (tools && !tools.includes(tool)) continue;
    if (c.data.productIds && !c.data.productIds.some((id) => productIds.includes(id))) continue;
    out.push({ id: p.id, rule: p.rule, cond: c.data });
  }
  return out;
}

/** min of the policy value and every precedent value; values above policy are ignored (cannot loosen). */
function tightened<T extends "maxDiscount" | "refundWindowHours">(policy: Rational | undefined, field: T, ps: ActivePrecedent[], notes: string[], rules: Set<string>): Rational | undefined {
  let v = policy;
  for (const p of ps) {
    const raw = p.cond[field];
    if (raw === undefined) continue;
    const r = Rational.parse(raw);
    if (policy && r.gt(policy)) {
      notes.push(`precedent ${p.id} would loosen ${field} to ${raw}; ignored (precedents only tighten)`);
      continue;
    }
    rules.add(`precedent:${p.id}`);
    if (!v || r.lt(v)) v = r;
  }
  return v;
}

// ---------- helpers ----------

const permitted = (perms: readonly string[], need: string) => perms.some((p) => p === "*" || p === need || (p.endsWith(".*") && need.startsWith(p.slice(0, -1))));

const fracStr = (r: Rational) => r.toJSON();
const show = (r: Rational) => r.toDecimal(6);
const BP = Rational.of(10_000n);
/** The platform's rate domain (platform checkRate): whole basis points in [0, 1]. */
const inRateDomain = (r: Rational) => !r.lt(Rational.ZERO) && !r.gt(Rational.ONE) && r.mul(BP).isInteger();
const bpFloor = (r: Rational) => Rational.of(r.mul(BP).floor(), 10_000n);
const centsStr = (c: bigint) => fixed2(Rational.fromCents(c));

const minR = (xs: (Rational | undefined)[]) => xs.filter((x): x is Rational => x !== undefined).reduce<Rational | undefined>((m, x) => (!m || x.lt(m) ? x : m), undefined);

function roleLimit(cfg: Configuration, role: string, key: string): Rational | undefined {
  const v = cfg.roles.find((r) => r.id === role)?.limits[key];
  if (v === undefined) return undefined;
  try {
    return Rational.parse(String(v));
  } catch {
    return Rational.ZERO; // a malformed limit fails closed
  }
}

/**
 * Largest discount rate r such that, for every line, the exact discount gross*r fits within the margin
 * slack gross - cost*(1+floor) rounded down to whole cents; capped by `caps`. Any r <= this value is
 * accepted by post() (round2 never rounds a whole-cent amount up, and acceptance is monotone in r).
 * Returns undefined when even r = 0 breaks the floor.
 */
export function maxDiscountRate(cfg: Configuration, lines: { productId: string; qty: number }[], caps: (Rational | undefined)[]): Rational | undefined {
  const floor = Rational.parse(cfg.policies.marginFloor);
  const cat = productCatalog(cfg);
  let bound: Rational | undefined;
  for (const l of lines) {
    const e = cat.entries.find((x) => x.id === l.productId)!;
    const gross = Rational.parse(String(e.data["price"])).mul(Rational.of(BigInt(l.qty)));
    const cost = Rational.parse(String(e.data["cost"])).mul(Rational.of(BigInt(l.qty)));
    const slack = gross.sub(cost.mul(Rational.ONE.add(floor)));
    if (slack.lt(Rational.ZERO)) return undefined;
    if (gross.isZero()) continue;
    const r = Rational.of(slack.mul(Rational.of(100n)).floor(), 100n).div(gross);
    if (!bound || r.lt(bound)) bound = r;
  }
  return minR([bound, ...caps]);
}

// ---------- evaluate ----------

export function evaluate(call: GuardCall, world: GuardWorld | undefined): Evaluation {
  const refused: { rule: string; reason: string }[] = [];
  const escalated: { rule: string; reason: string }[] = [];
  const notes: string[] = [];
  const rules = new Set<string>();
  const evidence = new Set<string>([`provenance:${(SOURCES as readonly string[]).includes(call.provenance?.source) ? call.provenance.source : "invalid"}`, `actor:${call.actor.role}`]);
  let maxAllowed: MaxAllowed | undefined;
  let wouldChangeIf: string | null = null;
  let checkedArgs: unknown;

  const done = (): Evaluation => {
    const outcome = refused.length ? "refused" : escalated.length ? "escalated" : "allowed";
    const list = outcome === "refused" ? refused : outcome === "escalated" ? escalated : [];
    for (const x of [...refused, ...escalated]) rules.add(x.rule);
    const reason = [...list.map((x) => x.reason), ...notes].join("; ") || "within policy";
    return {
      allow: outcome === "allowed",
      outcome,
      ruleIds: [...rules],
      reason,
      ...(maxAllowed ? { maxAllowed } : {}),
      wouldChangeIf: outcome === "allowed" ? null : wouldChangeIf,
      ...(checkedArgs !== undefined ? { checkedArgs } : {}),
      evidenceRefs: [...evidence],
    };
  };
  const refuse = (rule: string, reason: string, would: string | null = null) => {
    refused.push({ rule, reason });
    if (would && !wouldChangeIf) wouldChangeIf = would;
  };
  const escalate = (rule: string, reason: string, would: string | null = null) => {
    escalated.push({ rule, reason });
    if (would && !wouldChangeIf) wouldChangeIf = would;
  };

  const spec: ToolSpec | undefined = Object.hasOwn(TOOLS, call.tool) ? TOOLS[call.tool] : undefined;
  if (!spec) {
    refuse("unknown_tool", `unknown tool "${String(call.tool).slice(0, 64)}"`);
    return done();
  }
  if (!(SOURCES as readonly string[]).includes(call.provenance?.source)) {
    refuse("invalid_provenance", "provenance.source is not one of the known sources");
    return done();
  }
  if (!world) {
    refuse("no_active_config", `business "${call.businessId}" has no active configuration`);
    return done();
  }
  const cfg = world.config;
  evidence.add(`config:${world.configId}`);
  const role = cfg.roles.find((r) => r.id === call.actor.role);
  if (!role) {
    refuse("unknown_role", `role "${call.actor.role}" does not exist in configuration ${cfg.id}`);
    return done();
  }
  const parsed = spec.args.safeParse(call.args);
  if (!parsed.success) {
    refuse("invalid_args", `arguments do not match ${call.tool}: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return done();
  }
  checkedArgs = parsed.data;
  const src = call.provenance.source;
  const isOwner = role.id === "owner";

  // Invariant 6: policy / price / configuration changes.
  if (spec.family === "config_change") {
    if (isOwner && src === "owner_app") {
      rules.add("inv6.owner_app");
      notes.push("owner change from the owner app; it takes effect only when the owner activates a new configuration");
    } else if (src === "owner_phone_verified") {
      escalate("inv6.phone_needs_app_confirmation", "a change requested by phone is queued as an owner statement; it applies only after the owner confirms it in the owner app", "the owner confirms the statement in the owner app");
    } else {
      refuse("inv6.owner_only", `prices, policies and configuration change only through the owner in the owner app (role=${role.id}, source=${src})`, "the owner makes the change in the owner app");
    }
    return done();
  }

  // Permissions and agent tool sets.
  if (!permitted(role.permissions, spec.permission)) {
    refuse("permission", `role ${role.id} lacks permission ${spec.permission}`);
    return done();
  }
  const agent = cfg.agents.find((a) => a.role === role.id);
  if (agent && !agent.tools.includes(call.tool)) {
    refuse("agent_tools", `${call.tool} is not one of the ${agent.id} agent's tools`);
    return done();
  }

  const args = parsed.data as Record<string, unknown>;
  const productIds = spec.family === "sale" ? (args["lines"] as { productId: string }[]).map((l) => l.productId) : [];
  const precedents = isOwner ? [] : matchingPrecedents(world.precedents, role.id, call.tool, productIds, notes);
  for (const p of precedents) evidence.add(`precedent:${p.id}`);

  if (spec.family === "sale") checkSale(cfg, role.id, isOwner, args as SaleArgs, call.args, precedents);
  else if (spec.family === "refund") checkRefund(cfg, role.id, isOwner, args as { orderId: string; amountCents: number }, world, precedents);
  else if (spec.family === "approve_refund") checkApproval(cfg, role.id, isOwner, call.actor.identity, args as { documentId: string }, world, precedents);
  else rules.add(spec.family === "escalate" ? "escalate" : "read");

  // Precedent outcomes: tighten only (allowed -> escalated/refused, escalated -> refused).
  for (const p of precedents) {
    if (p.cond.outcome === "refuse") refuse(`precedent:${p.id}`, `owner precedent: ${p.rule}`, "the owner changes this precedent");
    else if (p.cond.outcome === "escalate" && !refused.length) escalate(`precedent:${p.id}`, `owner precedent: ${p.rule}`, "the owner approves it");
  }
  return done();

  // ----- family checks (closures over the accumulators) -----

  function checkSale(cfg: Configuration, roleId: string, owner: boolean, a: SaleArgs, raw: unknown, ps: ActivePrecedent[]) {
    const cat = productCatalog(cfg);
    const unknown = a.lines.filter((l) => !cat.entries.some((e) => e.id === l.productId)).map((l) => l.productId);
    if (unknown.length) return refuse("catalog.unknown_product", `unknown product(s): ${unknown.join(", ")}`);
    if (callerPriced(raw)) {
      rules.add("inv6.catalog_prices");
      notes.push("caller-supplied prices/costs ignored; catalog prices used");
    }
    const coupons = a.discounts.filter((d) => d.source === "coupon").length;
    if (coupons > 0 && !cfg.policies.couponsAllowed) refuse("D5.coupons_not_allowed", "coupons are not allowed for this business");
    else if (coupons > cfg.policies.maxCouponsPerOrder) refuse("D5.coupon_stacking", `at most ${cfg.policies.maxCouponsPerOrder} coupon(s) per order, got ${coupons}`, `use at most ${cfg.policies.maxCouponsPerOrder} coupon`);

    const total = a.discounts.reduce((s, d) => s.add(Rational.parse(d.rate)), Rational.ZERO);
    const offDomain = [...a.discounts.map((d) => d.rate).filter((r) => !inRateDomain(Rational.parse(r))), ...(inRateDomain(total) ? [] : [`total ${show(total)}`])];
    if (offDomain.length) refuse("rate_domain", `discount rates must be whole basis points in [0, 1] (at most 4 decimals): ${offDomain.join(", ")}`, "each rate and the total have at most 4 decimals and are between 0 and 1");
    const policyCap = Rational.parse(cfg.policies.maxDiscount);
    const roleCap = owner ? undefined : roleLimit(cfg, roleId, "maxDiscount");
    const tight = tightened(policyCap, "maxDiscount", ps, notes, rules)!;
    const precCapChecked = tight.lt(policyCap) ? tight : undefined;
    const best = maxDiscountRate(cfg, a.lines, [policyCap, roleCap, precCapChecked]);
    if (best) maxAllowed = { discountRate: fracStr(best), discountRateDecimal: show(best), discountRateBasisPoints: bpFloor(best).toDecimal(4) };
    const would = best ? `the total discount is at most ${bpFloor(best).toDecimal(4)} (exact limit ${fracStr(best)})` : "the owner raises the price or lowers the margin floor";

    try {
      post(docDef(cfg, "sale"), saleInput(cfg, a.lines, fracStr(total)), postingContext(cfg));
      rules.add("inv4.ledger_accepts");
    } catch (e) {
      if (e instanceof PolicyCheckError) {
        for (const f of e.failures) {
          if (f.checkId === "discount_cap") refuse("D5.discount_cap", `total discount ${show(total)} exceeds the maximum ${cfg.policies.maxDiscount}`, would);
          else if (f.checkId === "margin_floor") refuse("inv4.margin_floor", `line ${f.lineIndex}: ${f.message}`, would);
          else refuse(`check.${f.checkId}`, f.message, would);
        }
      } else refuse("ledger", `the posting engine refused the sale: ${(e as Error).message}`);
      return;
    }
    if (roleCap && total.gt(roleCap)) escalate("role_limit.maxDiscount", `${roleId} may give at most ${show(roleCap)} discount, asked ${show(total)}`, would);
    if (precCapChecked && total.gt(precCapChecked)) escalate([...rules].find((r) => r.startsWith("precedent:")) ?? "precedent", `owner precedent caps the discount at ${show(precCapChecked)}`, would);
  }

  function checkRefund(cfg: Configuration, roleId: string, owner: boolean, a: { orderId: string; amountCents: number }, w: GuardWorld, ps: ActivePrecedent[]) {
    const f = w.refundFacts;
    evidence.add(`order:${a.orderId}`);
    if (!f || f.orderId !== a.orderId) return refuse("order.unknown", `order ${a.orderId} has no posted sale to refund`);
    const ctx: PostingContext = postingContext(cfg);
    const window = tightened(Rational.parse(cfg.policies.refundWindowHours), "refundWindowHours", ps, notes, rules)!;
    ctx.policies = { ...ctx.policies, refundWindowHours: fracStr(window) };
    const amount = Rational.fromCents(BigInt(a.amountCents));
    const saleTotal = Rational.parse(f.saleTotal);
    // pending drafts count as already refunded: splitting one refund into several drafts changes nothing
    const committedCents = f.refundedSoFarCents + (f.pendingRefundCents ?? 0n);
    const remaining = saleTotal.sub(Rational.fromCents(committedCents));
    const floorAmt = Rational.parse(f.saleCost).mul(Rational.ONE.add(Rational.parse(cfg.policies.marginFloor)));
    const maxPartial = Rational.parse(f.saleNet).sub(Rational.fromCents(committedCents)).sub(floorAmt);
    const maxPartialCents = maxPartial.lt(Rational.ZERO) ? 0n : maxPartial.mul(Rational.of(100n)).floor();
    try {
      post(
        docDef(cfg, "refund"),
        {
          fields: { orderId: a.orderId, amount: fracStr(amount), reason: "", saleTotal: f.saleTotal, saleNet: f.saleNet, saleCost: f.saleCost, refundedSoFar: fracStr(Rational.fromCents(committedCents)), hoursSinceSale: f.hoursSinceSale },
          lines: [],
        },
        ctx,
      );
      rules.add("refund.ledger_accepts");
    } catch (e) {
      if (!(e instanceof PolicyCheckError)) return refuse("ledger", `the posting engine refused the refund: ${(e as Error).message}`);
      for (const x of e.failures) {
        if (x.checkId === "refund_window") escalate("refund_window", `${show(Rational.parse(f.hoursSinceSale))} h since the sale is past the ${show(window)} h refund window`, "the owner approves a late refund");
        else if (x.checkId === "refund_full_or_floor")
          refuse("D4.full_or_floor", "a partial refund cannot take the sale below cost plus the margin floor", `refund the full remaining ${fixed2(remaining)} instead, or at most ${centsStr(maxPartialCents)} as a partial refund`);
        else if (x.checkId === "refund_not_over") refuse("refund.not_over", `refunds would exceed what was paid (remaining ${fixed2(remaining)})`, `refund at most ${fixed2(remaining)}`);
        else refuse(`check.${x.checkId}`, x.message);
      }
    }
    if (!owner) {
      const lim = minR([roleLimit(cfg, roleId, "maxRefundCents"), ...ps.filter((p) => p.cond.maxRefundCents !== undefined).map((p) => (rules.add(`precedent:${p.id}`), Rational.of(BigInt(p.cond.maxRefundCents!))))]);
      if (lim) {
        maxAllowed = { refundCents: lim.toDecimal(0) };
        const orderTotal = committedCents + BigInt(a.amountCents);
        if (Rational.of(orderTotal).gt(lim))
          escalate(
            "role_limit.maxRefundCents",
            committedCents > 0n
              ? `${roleId} may refund up to ${lim.toDecimal(0)} cents per order; this order would reach ${orderTotal} (already ${committedCents} refunded or pending, asked ${a.amountCents})`
              : `${roleId} may refund up to ${lim.toDecimal(0)} cents, asked ${a.amountCents}`,
            "the owner approves this refund",
          );
      }
    }
  }

  function checkApproval(cfg: Configuration, roleId: string, owner: boolean, identity: string, a: { documentId: string }, w: GuardWorld, ps: ActivePrecedent[]) {
    const d = w.document;
    evidence.add(`document:${a.documentId}`);
    if (!d || d.id !== a.documentId) return refuse("document.unknown", `document ${a.documentId} not found`);
    if (d.docType !== "refund") return refuse("document.type", `document ${d.id} is a ${d.docType}, not a refund`);
    if (d.status !== "draft") return refuse("document.status", `document ${d.id} is ${d.status}, not a draft`);
    const def = cfg.documents.find((x) => x.id === "refund")!;
    if (!owner && !def.approval.approverRoles.includes(roleId)) return refuse("approval.role", `${roleId} is not an approver of refunds`);
    if (d.createdByIdentity === identity || (!owner && d.createdByRole === roleId)) return refuse("inv5.sod", "the creator of a document cannot approve it (segregation of duties)", "a different role approves it");
    if (!owner) {
      const lim = minR([roleLimit(cfg, roleId, "maxRefundCents"), ...ps.filter((p) => p.cond.maxRefundCents !== undefined).map((p) => Rational.of(BigInt(p.cond.maxRefundCents!)))]);
      const orderTotal = d.totalCents + (d.orderRefundedOtherCents ?? 0n);
      if (lim && Rational.of(orderTotal).gt(lim))
        escalate("role_limit.maxRefundCents", `${roleId} may approve refunds up to ${lim.toDecimal(0)} cents per order; this order would reach ${orderTotal} (this draft ${d.totalCents})`, "the owner approves this refund");
    }
    rules.add("inv5.sod_ok");
  }
}

type SaleArgs = { lines: { productId: string; qty: number }[]; discounts: { source: "manual" | "coupon"; code?: string; rate: string }[] };

const PRICE_KEYS = ["unitPrice", "price", "unitCost", "cost", "total", "amount", "gross", "net"];
function callerPriced(raw: unknown): boolean {
  const lines = (raw as { lines?: unknown })?.lines;
  if (Array.isArray(lines) && lines.some((l) => l && typeof l === "object" && PRICE_KEYS.some((k) => k in l))) return true;
  return !!raw && typeof raw === "object" && PRICE_KEYS.some((k) => k in (raw as object));
}
