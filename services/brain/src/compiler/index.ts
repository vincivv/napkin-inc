// The compiler: owner-confirmed BusinessSpec -> Configuration v(n) + ProofReport.
//
// AI vs deterministic: everything that touches money (catalog prices and costs, stock, policies,
// accounts, posting rules, role limits) is filled here by code from confirmed facts. An LLM may only
// propose storefront look/wording and agent goal wording (storefront.ts); posting-rule synthesis and
// proofs go through the ProverPort. If the LLM were swapped or removed, the money output is identical.

import { post, PolicyCheckError, Rational } from "@napkin/ledger-core";
import { checkConfigurationSemantics, parseConfiguration, type BusinessSpec, type Configuration, type OpenQuestion, type ProofReport } from "@napkin/schema";
import { CompileRefused, NeedsOwnerAnswer, ownerQuestion } from "./errors";
import { checkMoneyFacts, unconfirmedDisplayPaths } from "./facts";
import { docDef, dryRun, postingContext, saleInput, type DryRunReport } from "./dryrun";
import { proofFailed, type ProverPort, type SpecExample } from "./prover-port";
import { acceptProposal, type CopyProposer } from "./storefront";
import * as T from "./templates/item_seller";
import { coerceTimeZone } from "../spec/coerce";

function zoneOrEmpty(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) return "";
  try {
    return coerceTimeZone(v);
  } catch {
    return "";
  }
}

export { CompileRefused, NeedsOwnerAnswer, UnconfirmedMoneyFacts } from "./errors";
export { StubProver, type ProverPort } from "./prover-port";

export const COMPILE_STEPS = ["facts", "template", "synthesis", "proofs", "configuration", "storefront", "agents"] as const;
export type CompileStep = (typeof COMPILE_STEPS)[number];

export interface StepEvent {
  step: CompileStep;
  status: "running" | "done" | "skipped" | "failed";
  message: string;
  data?: unknown;
}

export interface CompileOptions {
  businessId: string;
  /** version to emit: v(n+1) of the business's configurations */
  version: number;
  prover: ProverPort;
  /** optional LLM proposer for storefront look and agent goal wording */
  proposer?: CopyProposer;
  /** money limits per role, owner-approved (the route carries them over from the active configuration) */
  roleLimits?: T.RoleLimits;
  onStep?: (e: StepEvent) => void;
}

export interface CompileResult {
  config: Configuration;
  proofReport: ProofReport;
  dryRun: DryRunReport;
  log: string[];
}

const ZERO_LIMITS: T.RoleLimits = { maxRefundCents: { support: 0, bookkeeper: 0 } };

/** Exact rate from a percentage string ("30" -> "0.30"). Values strictly between 0 and 1 are ambiguous. */
export function percentToRate(pct: string, path: string): string {
  const r = Rational.parse(pct);
  if (r.gt(Rational.ZERO) && r.lt(Rational.ONE)) {
    throw new NeedsOwnerAnswer(`${path} = "${pct}" is ambiguous`, [
      ownerQuestion(path, `Is ${path.split(".").pop()} ${pct}% or ${r.mul(Rational.of(100n)).toDecimal()}%?`, [`${pct}%`, `${r.mul(Rational.of(100n)).toDecimal()}%`]),
    ]);
  }
  return fixed2(r.div(Rational.of(100n)));
}

/** Exact decimal string with at least two fraction digits ("0.3" -> "0.30", "15" -> "15.00"). */
export function fixed2(r: Rational): string {
  const s = r.toDecimal(12);
  if (s.includes("…")) throw new Error(`${s} does not terminate`);
  const [w, f = ""] = s.split(".");
  return `${w}.${f.padEnd(2, "0")}`;
}
const money = (s: string) => fixed2(Rational.parse(s));

/** The money-relevant sections; must be byte-identical before and after the LLM steps. */
export function moneyFingerprint(c: Configuration): string {
  return JSON.stringify({
    catalogs: c.catalogs,
    initialStock: c.initialStock ?? null,
    chartOfAccounts: c.chartOfAccounts,
    registers: c.registers,
    policies: c.policies,
    documents: c.documents,
    roles: c.roles,
    agents: c.agents.map((a) => ({ id: a.id, role: a.role, tools: a.tools, limits: a.limits, escalationRules: a.escalationRules })),
  });
}

/** Template + confirmed facts -> catalogs, stock and policies. Deterministic; raises owner questions on conflicts. */
export function fillTemplate(spec: BusinessSpec, opts: Pick<CompileOptions, "businessId" | "version" | "roleLimits">, log: string[]): Configuration {
  const questions: OpenQuestion[] = [];
  const products: Configuration["catalogs"][number]["entries"] = [];
  const stockItems: Configuration["catalogs"][number]["entries"] = [];
  const initialStock: Record<string, number> = {};
  const addOns = new Map<string, { price: string; cost: string; from: string }>();

  for (const o of spec.offerings) {
    const tracked = o.stockTracked.value === true;
    if (tracked) {
      // One stock item per tracked offering; its unit cost must agree across every variant.
      const unitCosts = new Map<string, { r: Rational; ids: string[] }>();
      for (const v of o.variants) {
        const r = Rational.parse(v.cost.value).div(Rational.parse(v.stockUnits!.value));
        const k = r.toJSON();
        unitCosts.set(k, { r, ids: [...(unitCosts.get(k)?.ids ?? []), v.id] });
      }
      const ucR = [...unitCosts.values()][0]!.r;
      if (unitCosts.size > 1) {
        const desc = [...unitCosts.values()].map((u) => `${u.ids.join("/")} -> ${u.r.toDecimal(4)}`).join("; ");
        questions.push(ownerQuestion(`offerings[${o.id}].variants`, `The variants of "${o.name.value}" imply different costs per unit of stock (${desc}). What does one unit of stock cost?`));
      } else if (!ucR.mul(Rational.of(100n)).isInteger()) {
        questions.push(ownerQuestion(`offerings[${o.id}].variants`, `One unit of "${o.name.value}" stock would cost ${ucR.toDecimal(6)} dollars, which is not a whole number of cents. What is the exact cost per unit?`));
      } else {
        stockItems.push({ id: o.id, data: { name: o.name.value, unitCost: fixed2(ucR) } });
        initialStock[o.id] = o.initialStock!.value;
      }
    }
    for (const v of o.variants) {
      if (products.some((p) => p.id === v.id)) questions.push(ownerQuestion(`offerings[${o.id}].variants[${v.id}]`, `Two products share the id "${v.id}". Which name should each have?`));
      products.push({
        id: v.id,
        data: {
          name: v.name.value,
          kind: "variant",
          price: money(v.price.value),
          cost: money(v.cost.value),
          stockItem: tracked ? o.id : "",
          stockUnits: tracked ? Rational.parse(v.stockUnits!.value).toDecimal() : "0",
          ...(o.description ? { description: o.description.value } : {}),
        },
      });
    }
    for (const a of o.addOns) {
      const prev = addOns.get(a.id);
      const price = money(a.price.value);
      const cost = money(a.cost.value);
      if (prev) {
        if (prev.price !== price || prev.cost !== cost) {
          const on = (id: string) => String(spec.offerings.find((x) => x.id === id)?.name.value ?? id);
          const said = (p: string, c: string, where: string) => `$${p} (costs you $${c}) on ${where}`;
          questions.push(ownerQuestion(`offerings[${o.id}].addOns[${a.id}]`, `"${a.name.value}" is ${said(prev.price, prev.cost, on(prev.from))} but ${said(price, cost, on(o.id))}. It's one add-on for every item, so which is right?`));
        }
        continue;
      }
      addOns.set(a.id, { price, cost, from: o.id });
    }
  }
  for (const o of spec.offerings) {
    for (const a of o.addOns) {
      const info = addOns.get(a.id);
      if (!info || info.from !== o.id) continue;
      if (products.some((p) => p.id === a.id)) {
        questions.push(ownerQuestion(`offerings[${o.id}].addOns[${a.id}]`, `The add-on id "${a.id}" is also a product id. Which name should each have?`));
        continue;
      }
      products.push({ id: a.id, data: { name: a.name.value, kind: "addon", price: info.price, cost: info.cost, stockItem: "", stockUnits: "0" } });
    }
  }
  if (questions.length) throw new NeedsOwnerAnswer(`the facts need ${questions.length} owner answer(s) before compiling`, questions);

  const p = spec.policies;
  const maxDiscount = percentToRate(p.maxDiscountPct.value, "policies.maxDiscountPct");
  const marginFloor = percentToRate(p.marginFloorPct.value, "policies.marginFloorPct");
  const policies: Configuration["policies"] = {
    currency: p.currency.value,
    taxRate: Rational.parse(p.taxRate.value).toDecimal(12),
    marginFloor,
    refundWindowHours: Rational.parse(p.refundWindowHours.value).toDecimal(12),
    refundMethod: p.refundMethod.value,
    maxDiscount,
    couponsAllowed: p.couponsAllowed.value,
    maxCouponsPerOrder: p.couponsAllowed.value ? T.PLATFORM_POLICY.couponsPerOrderWhenAllowed : 0,
    backordersAllowed: T.PLATFORM_POLICY.backordersAllowed,
    paymentMethods: [...p.paymentMethods.value],
    fulfillment: spec.operations.fulfillment.value,
  };
  const limits = opts.roleLimits ?? ZERO_LIMITS;
  if (!opts.roleLimits) log.push("template: no owner-approved refund limits yet -> support/bookkeeper maxRefundCents = 0 (every agent refund goes to the owner)");
  const roles = T.roles(maxDiscount, limits);
  const unconfirmed = unconfirmedDisplayPaths(spec);
  const b = spec.business;

  const cfg: Configuration = {
    id: `${opts.businessId}@${opts.version}`,
    businessId: opts.businessId,
    version: opts.version,
    pattern: "item_seller",
    source: `compiled from BusinessSpec (template ${T.TEMPLATE_ID})`,
    ...(unconfirmed.length
      ? { _unconfirmed: { note: "Display facts the owner has not confirmed yet (names, hours, places). Money facts are always confirmed before compiling.", paths: unconfirmed } }
      : {}),
    business: {
      name: b.name.value,
      slug: opts.businessId,
      oneLiner: b.oneLiner.value,
      community: b.community.value,
      pickupLocation: spec.operations.pickupLocation.value,
      hours: b.hours.value,
      // an IANA id or nothing: a spec saved before zones were checked may hold "Pacific time", which crashes clocks
      timezone: zoneOrEmpty(b.timezone.value),
    },
    catalogs: [
      { id: T.PRODUCTS_CATALOG.id, name: T.PRODUCTS_CATALOG.name, lineKey: T.PRODUCTS_CATALOG.lineKey, fields: structuredClone([...T.PRODUCT_FIELDS]), entries: products },
      { id: T.STOCK_ITEMS_CATALOG.id, name: T.STOCK_ITEMS_CATALOG.name, lineKey: T.STOCK_ITEMS_CATALOG.lineKey, fields: structuredClone([...T.STOCK_ITEM_FIELDS]), entries: stockItems },
    ],
    initialStock,
    chartOfAccounts: T.chartOfAccounts(),
    registers: T.registers(),
    policies,
    documents: T.documents(),
    roles,
    agents: T.agents(roles),
    storefront: { theme: { ...T.DEFAULT_THEME }, headline: b.name.value, tagline: b.oneLiner.value, pages: [...T.STOREFRONT_PAGES], qr: { ...T.STOREFRONT_QR } },
    reports: [...T.REPORTS],
  };
  log.push(`template: ${T.TEMPLATE_ID}; ${products.length} products, ${stockItems.length} stock items, ${cfg.documents.length} document types, ${cfg.chartOfAccounts.length} accounts`);
  return cfg;
}

const EXAMPLE_DOC: Record<SpecExample["kind"], string> = { sale: "sale", refund: "refund", purchase: "stock_receipt" };

/**
 * Deterministic check of the owner's sale examples against the rules: post the example through
 * ledger-core and compare per-account debits/credits. Supports inputs { lines: [{productId, qty}], discountRate? }.
 */
export function checkSaleExamples(cfg: Configuration, examples: SpecExample[], log: string[]): OpenQuestion[] {
  const out: OpenQuestion[] = [];
  examples.forEach((ex, i) => {
    if (ex.kind !== "sale") return;
    const inp = ex.inputs as { lines?: { productId: string; qty: number | string }[]; discountRate?: string };
    if (!Array.isArray(inp.lines)) {
      log.push(`examples[${i}]: sale example without inputs.lines; left to the prover`);
      return;
    }
    const want = new Map<string, bigint>();
    for (const e of ex.expectedPostings) {
      const k = `${e.account}:${e.side}`;
      want.set(k, (want.get(k) ?? 0n) + Rational.parse(e.amount).toCents());
    }
    let got = new Map<string, bigint>();
    let err = "";
    try {
      const r = post(docDef(cfg, "sale"), saleInput(cfg, inp.lines, inp.discountRate ?? "0"), postingContext(cfg));
      got = new Map();
      for (const j of r.journal) {
        if (j.debitCents) got.set(`${j.account}:debit`, (got.get(`${j.account}:debit`) ?? 0n) + j.debitCents);
        if (j.creditCents) got.set(`${j.account}:credit`, (got.get(`${j.account}:credit`) ?? 0n) + j.creditCents);
      }
    } catch (e) {
      err = e instanceof PolicyCheckError ? e.message : (e as Error).message;
    }
    const keys = new Set([...want.keys(), ...got.keys()]);
    const diff = [...keys].filter((k) => (want.get(k) ?? 0n) !== (got.get(k) ?? 0n));
    if (err || diff.length) {
      const fmt = (m: Map<string, bigint>, k: string) => Rational.fromCents(m.get(k) ?? 0n).toDecimal();
      const detail = err ? `the rules refuse it (${err})` : diff.map((k) => `${k} expected ${fmt(want, k)}, rules give ${fmt(got, k)}`).join("; ");
      out.push(ownerQuestion(`examples[${i}]`, `Your example sale (${inp.lines.map((l) => `${l.qty}x ${l.productId}`).join(", ")}) does not match how the books would record it: ${detail}. Is the example or the rule right?`, ["the example is right", "the rule is right"]));
      log.push(`examples[${i}]: MISMATCH ${detail}`);
    } else log.push(`examples[${i}]: sale example reproduced exactly by the posting rules`);
  });
  return out;
}

export async function compile(spec: BusinessSpec, opts: CompileOptions): Promise<CompileResult> {
  const log: string[] = [];
  const emit = (step: CompileStep, status: StepEvent["status"], message: string, data?: unknown) => {
    log.push(`[${step}] ${status}: ${message}`);
    opts.onStep?.({ step, status, message, ...(data === undefined ? {} : { data }) });
  };
  const run = async <R>(step: CompileStep, fn: () => R | Promise<R>): Promise<R> => {
    emit(step, "running", `${step}…`);
    try {
      return await fn();
    } catch (e) {
      const qs = e instanceof CompileRefused ? e.questions : [];
      emit(step, "failed", (e as Error).message, qs.length ? { questions: qs } : undefined);
      throw e;
    }
  };

  // (a) facts check
  await run("facts", () => {
    checkMoneyFacts(spec);
    emit("facts", "done", "every money-relevant fact is owner-confirmed");
  });

  // (b) template fill
  const cfg = await run("template", () => {
    const sub: string[] = [];
    const c = fillTemplate(spec, opts, sub);
    log.push(...sub);
    emit("template", "done", sub.join("; "));
    return c;
  });

  // (c) posting-rule synthesis from examples (prover) + deterministic example check
  await run("synthesis", async () => {
    if (spec.examples.length === 0) {
      emit("synthesis", "skipped", "no worked examples in the spec; template posting rules used");
      return;
    }
    const questions: OpenQuestion[] = [];
    const byDoc = new Map<string, SpecExample[]>();
    for (const ex of spec.examples) byDoc.set(EXAMPLE_DOC[ex.kind], [...(byDoc.get(EXAMPLE_DOC[ex.kind]) ?? []), ex]);
    const notes: string[] = [];
    for (const [docType, examples] of byDoc) {
      const def = cfg.documents.find((d) => d.id === docType)!;
      const r = await opts.prover.synthesizePostingRule({ docType, definition: def, examples, chartOfAccounts: cfg.chartOfAccounts, policies: cfg.policies });
      log.push(...r.log);
      if (r.status === "synthesized") {
        def.postingRules = r.rules;
        notes.push(`${docType}: ${r.rules.length} rules synthesized`);
      } else if (r.status === "ambiguous") {
        questions.push({ id: `compile:synthesis:${docType}`, fieldPath: r.question.fieldPath, question: r.question.question, impactScore: 1, moneyRelevant: true, status: "open", ...(r.question.candidates ? { candidates: r.question.candidates } : {}) });
      } else if (r.status === "no_solution") {
        questions.push(ownerQuestion(`examples:${docType}`, `No posting rule fits all your ${docType} examples (${r.reason}). Could one of them be wrong?`));
      } else notes.push(`${docType}: ${r.reason}`);
    }
    if (questions.length) throw new NeedsOwnerAnswer("posting-rule synthesis needs an owner answer (the compiler does not guess)", questions);
    const exQ = checkSaleExamples(cfg, spec.examples, log);
    if (exQ.length) throw new NeedsOwnerAnswer("an owner example disagrees with the posting rules", exQ);
    emit("synthesis", opts.prover.isStub ? "skipped" : "done", notes.join("; ") || "examples checked");
  });

  // (d) validate + dry run + proofs. Never emit a configuration whose proofs failed.
  const { proofReport, dry } = await run("proofs", async () => {
    let parsed: Configuration;
    try {
      parsed = parseConfiguration(cfg);
    } catch (e) {
      throw new CompileRefused("invalid_configuration", (e as Error).message);
    }
    const issues = checkConfigurationSemantics(parsed);
    if (issues.length) throw new CompileRefused("invalid_configuration", `semantic issues: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    const dry = dryRun(parsed);
    if (dry.belowFloor.length) {
      throw new NeedsOwnerAnswer(
        "some products cannot be sold at their own price",
        dry.belowFloor.map((b) => ownerQuestion(`catalogs.products.${b.productId}`, `"${b.productId}" sells below cost plus the margin floor even with no discount. Raise its price, lower the margin floor, or check its cost?`)),
      );
    }
    if (!dry.ok) throw new CompileRefused("dry_run_failed", `ledger dry run failed: ${dry.cases.filter((c) => !c.ok).map((c) => `${c.subject}: ${c.error}`).join("; ")}`);
    const proofReport = await opts.prover.proveConfiguration(parsed);
    proofReport.synthesisLog = [...log.filter((l) => l.startsWith("synthesis") || l.startsWith("examples")), ...proofReport.synthesisLog];
    const failed = proofFailed(proofReport);
    if (failed) throw new CompileRefused("proof_failed", `proof failed: ${failed}; the configuration is not emitted`);
    const statuses = `balance ${proofReport.balanceProof.status}, discount ${proofReport.discountProof.status}, flow ${proofReport.flowCheck.status}`;
    emit("proofs", opts.prover.isStub ? "skipped" : "done", `dry run: ${dry.cases.length} sample postings balanced; proofs (${opts.prover.name}): ${statuses}`, { dryRun: dry.cases.map((c) => ({ subject: c.subject, ok: c.ok, refused: c.refused ?? null })) });
    return { proofReport, dry };
  });

  const fingerprint = moneyFingerprint(cfg);
  await run("configuration", () => {
    cfg.proofReport = proofReport;
    emit("configuration", "done", `configuration v${cfg.version} (${cfg.id})`);
  });

  // storefront + agents: optional LLM proposal, validated; failures fall back to deterministic defaults
  const copy = await run("storefront", async () => {
    let proposal;
    let note = "";
    if (opts.proposer) {
      try {
        proposal = await opts.proposer.propose({
          businessName: cfg.business.name,
          oneLiner: cfg.business.oneLiner,
          community: cfg.business.community ?? "",
          offerings: productNames(cfg),
        });
      } catch (e) {
        note = ` (proposer failed: ${(e as Error).message}; defaults used)`;
      }
    } else note = " (no LLM configured; defaults used)";
    const acc = acceptProposal(proposal, { headline: cfg.storefront.headline, tagline: cfg.storefront.tagline });
    cfg.storefront = { ...cfg.storefront, theme: acc.theme, headline: acc.headline, tagline: acc.tagline };
    emit("storefront", "done", `theme ${acc.theme.primary}/${acc.theme.background}, headline "${acc.headline}"${acc.used.length ? `; from ${opts.proposer?.name}: ${acc.used.join(", ")}` : ""}${acc.rejected.length ? `; rejected: ${acc.rejected.join("; ")}` : ""}${note}`);
    return acc;
  });

  await run("agents", () => {
    for (const a of cfg.agents) a.goals = copy.goals[a.id as keyof typeof copy.goals] ?? a.goals;
    const final = parseConfiguration(cfg);
    const issues = checkConfigurationSemantics(final);
    if (issues.length) throw new CompileRefused("invalid_configuration", `semantic issues after copy: ${issues.map((i) => i.message).join("; ")}`);
    if (moneyFingerprint(final) !== fingerprint) throw new CompileRefused("money_changed_after_proof", "a money section changed after the proofs ran; refusing");
    emit("agents", "done", cfg.agents.map((a) => `${a.id}: ${a.tools.join(", ")}`).join(" · "));
  });

  return { config: parseConfiguration(cfg), proofReport, dryRun: dry, log };
}

function productNames(cfg: Configuration): string[] {
  return (cfg.catalogs.find((c) => c.lineKey === "productId")?.entries ?? []).map((e) => String(e.data["name"] ?? e.id));
}
