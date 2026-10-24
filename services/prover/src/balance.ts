// Balance proof: for every valid input with 1..K lines that passes the document's checks,
// sum(debits) - sum(credits) == 0, every posted amount is a whole number of cents, every register
// quantity is whole, and no division by zero happens. Counterexamples are replayed through
// ledger-core post() so what we report is what the runtime would actually do.

import {
  compile,
  computeDocument,
  evalNum,
  FractionalCentsError,
  names,
  post,
  print,
  Rational,
  UnbalancedPostingError,
  type DocumentInput,
  type PostingRule,
} from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { encodeBool, encodeNum, rationalOf } from "./encode";
import { money } from "./format";
import { asDef, buildSymbolicDoc, DEFAULT_BOUNDS, postingContext, type Bounds, type DocumentType, type SymbolicDoc } from "./symbolic";
import { DEFAULT_TIMEOUT_MS, type ProofResult, type ProveOptions, type ProverDetail } from "./types";
import { check, getZ3, type Z3, type ZArith, type ZBool, type ZModel } from "./z3";

type ObligationKind = "balance" | "cents" | "qty" | "div" | "vacuous";

interface Failure {
  kind: ObligationKind;
  ruleId?: string;
  K: number;
  mode: "free" | "bound";
  sym: SymbolicDoc;
  model?: ZModel;
  unknown?: string;
  imbalanceTerm?: ZArith;
}

interface RunResult {
  failures: Failure[];
  vacuousK: number[];
  checked: number;
}

export function resolveBounds(b?: Partial<Bounds>): Bounds {
  return { ...DEFAULT_BOUNDS, ...(b ?? {}) };
}

const accountRules = (d: DocumentType) => d.postingRules.filter((r) => r.target.kind === "account");

/** Encode the posting rules of a symbolic doc: (when, amount, qty) per rule instance. */
function encodeRules(sym: SymbolicDoc) {
  const z = sym.z;
  return sym.doc.postingRules.map((r) => {
    const scopes = r.scope === "line" ? sym.lineScopes : [sym.docScope];
    const inst = scopes.map((s) => ({
      when: r.when ? encodeBool(compile(r.when), s) : z.Bool.val(true),
      amount: encodeNum(compile(r.amountExpr), s),
      qty: r.target.kind === "register" && r.qtyExpr ? encodeNum(compile(r.qtyExpr), s) : undefined,
    }));
    return { rule: r, inst };
  });
}

async function niceModel(z: Z3, sym: SymbolicDoc, base: ZBool[], model: ZModel, timeoutMs: number): Promise<ZModel> {
  for (const tier of [0, 1]) {
    const extra = sym.vars.flatMap((v) => v.nice(tier));
    if (!extra.length) continue;
    const r = await check(z, [...base, ...extra], Math.min(3000, timeoutMs));
    if (r.status === "sat") return r.model;
  }
  return model;
}

async function runObligations(
  cfg: Configuration,
  doc: DocumentType,
  mode: "free" | "bound",
  opts: ProveOptions,
  only?: Set<ObligationKind>,
): Promise<RunResult> {
  const z = await getZ3();
  const bounds = resolveBounds(opts.bounds);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const failures: Failure[] = [];
  const failed = new Set<string>();
  const vacuousK: number[] = [];
  let checked = 0;
  const Ks = doc.lineFields.length === 0 ? [0] : Array.from({ length: bounds.kMax }, (_, i) => i + 1);
  const want = (k: ObligationKind) => !only || only.has(k);

  for (const K of Ks) {
    const sym = buildSymbolicDoc(z, cfg, doc, { K: Math.max(K, 1), mode, bounds, bindings: opts.bindings });
    const rules = encodeRules(sym);
    const pre: ZBool[] = [...sym.domain, ...sym.checks.map((c) => c.term)];

    const run = async (key: string, kind: ObligationKind, goalNegation: ZBool, extra: Partial<Failure> = {}, withSide = true) => {
      if (failed.has(key)) return;
      const base = [...pre, ...(withSide ? sym.side : []), goalNegation];
      checked++;
      const r = await check(z, base, timeoutMs);
      if (r.status === "unsat") return;
      failed.add(key);
      if (r.status === "unknown") {
        failures.push({ kind, K, mode, sym, unknown: r.reason, ...extra });
        return;
      }
      const model = await niceModel(z, sym, base, r.model, timeoutMs);
      failures.push({ kind, K, mode, sym, model, ...extra });
    };

    // vacuity: some input must pass the checks, or "proved" would mean nothing
    if (want("vacuous")) {
      checked++;
      const r = await check(z, [...pre, ...sym.side], timeoutMs);
      if (r.status === "unsat") {
        vacuousK.push(K);
        continue;
      }
      if (r.status === "unknown") failures.push({ kind: "vacuous", K, mode, sym, unknown: r.reason });
    }

    if (want("balance")) {
      let imb: ZArith = z.Real.val(0);
      for (const { rule, inst } of rules) {
        if (rule.target.kind !== "account") continue;
        for (const x of inst) {
          const signed = rule.side === "debit" ? x.amount : x.amount.neg();
          imb = imb.add(z.If(x.when, signed, z.Real.val(0)) as ZArith);
        }
      }
      await run("balance", "balance", imb.neq(0), { imbalanceTerm: imb });
    }
    if (want("cents")) {
      for (const { rule, inst } of rules) {
        const bad = z.Or(...inst.map((x) => z.And(x.when, z.Not(z.IsInt(x.amount.mul(100))))));
        await run(`cents:${rule.id}`, "cents", bad, { ruleId: rule.id });
      }
    }
    if (want("qty")) {
      for (const { rule, inst } of rules) {
        if (rule.target.kind !== "register" || !rule.qtyExpr) continue;
        const bad = z.Or(...inst.map((x) => z.And(x.when, z.Not(z.IsInt(x.qty!)))));
        await run(`qty:${rule.id}`, "qty", bad, { ruleId: rule.id });
      }
    }
    if (want("div") && sym.side.length) {
      await run("div", "div", z.Not(z.And(...sym.side)), {}, false);
    }
  }
  if (want("vacuous") && vacuousK.length === Ks.length) failures.push({ kind: "vacuous", K: 0, mode, sym: undefined as never });
  return { failures, vacuousK, checked };
}

// ---------- replay & explanation ----------

interface Replay {
  ok: boolean;
  debitCents?: bigint;
  creditCents?: bigint;
  error?: string;
}

function replay(cfg: Configuration, doc: DocumentType, input: DocumentInput, kind: ObligationKind): Replay {
  try {
    post(asDef(doc), input, postingContext(cfg));
    return { ok: false, error: "ledger-core posted it without error" };
  } catch (e) {
    if (e instanceof UnbalancedPostingError) return { ok: kind === "balance", debitCents: e.debitCents, creditCents: e.creditCents, error: e.message };
    if (e instanceof FractionalCentsError) return { ok: kind === "cents", error: e.message };
    const msg = (e as Error).message;
    if (kind === "qty" && /not whole/.test(msg)) return { ok: true, error: msg };
    if (kind === "div" && /division by zero/.test(msg)) return { ok: true, error: msg };
    return { ok: false, error: msg };
  }
}

function describeLines(cx: Record<string, string>, K: number): string {
  const parts: string[] = [];
  for (let i = 0; i < K; i++) {
    const id = cx[`line[${i}].productId`] ?? cx[`line[${i}].stockItem`];
    const qty = cx[`line[${i}].qty`];
    if (qty && id) parts.push(`${qty} × ${id}`);
    else if (qty) parts.push(`qty ${qty}`);
  }
  return parts.join(" + ");
}

function scenario(cx: Record<string, string>, K: number, doc: DocumentType): string {
  const bits: string[] = [];
  const lines = describeLines(cx, K);
  if (lines) bits.push(lines);
  for (const f of doc.fields) {
    const v = cx[`doc.${f.name}`];
    if (v === undefined) continue;
    if (f.type === "rate") bits.push(`a ${v} ${humanize(f.name)}`);
    else bits.push(`${f.name} = ${v}`);
  }
  return bits.join(", ");
}

const humanize = (s: string) =>
  s
    .replace(/Rate$/, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

const words = (s: string) =>
  s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3)
    .map((w) => w.replace(/s$/, ""));

const TYPE_PHRASE: Record<string, string> = {
  asset: "an asset account",
  liability: "a liability account",
  equity: "an equity account",
  revenue: "a revenue account",
  contra_revenue: "a contra-revenue account",
  expense: "an expense account",
};

function pickAccount(cfg: Configuration, field: string, side: "debit" | "credit") {
  const fw = words(field);
  const byName = cfg.chartOfAccounts.find((a) => words(a.name).some((w) => fw.some((f) => w === f || w.startsWith(f))));
  if (byName) return byName;
  const prefer = side === "debit" ? ["contra_revenue", "expense"] : ["revenue", "liability"];
  for (const t of prefer) {
    const a = cfg.chartOfAccounts.find((x) => x.type === t);
    if (a) return a;
  }
  return cfg.chartOfAccounts[0];
}

function withRules(doc: DocumentType, rules: DocumentType["postingRules"]): DocumentType {
  return { ...doc, postingRules: rules };
}

async function proves(cfg: Configuration, doc: DocumentType, opts: ProveOptions, kinds: ObligationKind[]): Promise<boolean> {
  for (const mode of ["free", "bound"] as const) {
    const r = await runObligations(cfg, doc, mode, { ...opts, suggestFixes: false }, new Set(kinds));
    if (r.failures.length === 0) return true;
    if (r.failures.some((f) => f.unknown)) return false;
  }
  return false;
}

async function suggestBalanceFix(cfg: Configuration, doc: DocumentType, input: DocumentInput, imbalance: Rational, opts: ProveOptions) {
  // which derived fields (or rule amounts) equal the imbalance in this counterexample?
  let computed;
  try {
    computed = computeDocument(asDef(doc), input, postingContext(cfg)).computed;
  } catch {
    return undefined;
  }
  const abs = imbalance.lt(Rational.ZERO) ? imbalance.neg() : imbalance;
  const side: "debit" | "credit" = imbalance.lt(Rational.ZERO) ? "debit" : "credit";
  const posted = new Set<string>();
  for (const r of accountRules(doc)) for (const n of names(compile(r.amountExpr))) posted.add(n);

  const cands: Array<{ name: string; scope: "line" | "doc" }> = [];
  for (const d of doc.derived) {
    let v: Rational | undefined;
    if (d.scope === "line") v = computed.lines.reduce((a, l) => a.add(l[d.name] ?? Rational.ZERO), Rational.ZERO);
    else v = computed.doc[d.name];
    if (v && !v.isZero() && v.eq(abs)) cands.push({ name: `${d.scope}.${d.name}`, scope: d.scope });
  }
  cands.sort((a, b) => Number(posted.has(a.name)) - Number(posted.has(b.name)));

  let firstIdea: string | undefined;
  for (const c of cands.slice(0, 4)) {
    const field = c.name.slice(c.name.indexOf(".") + 1);
    const acct = pickAccount(cfg, field, side);
    if (!acct) continue;
    const rule: PostingRule = {
      id: `${doc.id}.${field}`,
      scope: c.scope,
      target: { kind: "account", code: acct.code },
      side,
      amountExpr: c.name,
      memo: acct.name.toLowerCase(),
    };
    const fixed = withRules(doc, [...doc.postingRules, rule as DocumentType["postingRules"][number]]);
    const text = `${side === "debit" ? "Debit" : "Credit"} ${c.name} to ${TYPE_PHRASE[acct.type] ?? "an account"} like '${acct.name}' (${acct.code}): add rule ${rule.id} { scope: ${rule.scope}, account ${acct.code}, ${side}, amount ${c.name} }.`;
    if (await proves(cfg, fixed, opts, ["balance"])) return { text: `${text} Verified: with this rule the balance proof passes.`, rule };
    firstIdea ??= `${text} (not sufficient on its own: the proof still fails with it)`;
  }
  // wrong side? a rule whose amount is exactly half the imbalance
  for (const r of accountRules(doc)) {
    let total = Rational.ZERO;
    try {
      const res = computeDocument(asDef(doc), input, postingContext(cfg));
      const scopes = r.scope === "line" ? input.lines.map((_, i) => res.lineEnv(i)) : [res.docEnv];
      for (const env of scopes) total = total.add(evalNum(compile(r.amountExpr), env));
    } catch {
      continue;
    }
    if (!total.isZero() && total.mul(Rational.of(2)).eq(abs)) {
      const flipped = withRules(doc, doc.postingRules.map((x) => (x.id === r.id ? { ...x, side: x.side === "debit" ? "credit" : "debit" } : x)) as DocumentType["postingRules"]);
      if (await proves(cfg, flipped, opts, ["balance"])) return { text: `Rule ${r.id} posts to the wrong side: make it a ${r.side === "debit" ? "credit" : "debit"}. Verified: with that change the balance proof passes.`, rule: undefined };
    }
  }
  return firstIdea ? { text: firstIdea, rule: undefined } : undefined;
}


async function suggestCentsFix(cfg: Configuration, doc: DocumentType, ruleId: string, opts: ProveOptions) {
  const r = doc.postingRules.find((x) => x.id === ruleId)!;
  const canon = print(compile(r.amountExpr));
  const same = doc.postingRules.filter((x) => print(compile(x.amountExpr)) === canon).map((x) => x.id);
  const fixed = withRules(doc, doc.postingRules.map((x) => (same.includes(x.id) ? { ...x, amountExpr: `round2(${x.amountExpr})` } : x)));
  const ok = await proves(cfg, fixed, opts, ["balance", "cents"]);
  const which = same.length > 1 ? `rules ${same.join(", ")}` : `rule ${ruleId}`;
  return `Round ${which} to cents: amountExpr "round2(${r.amountExpr})" (or a derived field round2(...) that every rule posting it shares).${ok ? " Verified: with that change the balance and whole-cents proofs pass." : " (that alone does not make the proof pass)"}`;
}

// ---------- public ----------

export async function proveBalance(cfg: Configuration, docTypeId: string, opts: ProveOptions = {}): Promise<ProofResult> {
  const t0 = performance.now();
  const doc = cfg.documents.find((d) => d.id === docTypeId);
  if (!doc) return { status: "failed", durationMs: 0, details: [{ subject: docTypeId, status: "failed", message: `unknown document type ${docTypeId}` }] };
  const bounds = resolveBounds(opts.bounds);
  const log = opts.log;
  const z = await getZ3();
  void z;

  const free = await runObligations(cfg, doc, "free", opts);
  let result = free;
  let mode: "free" | "bound" = "free";
  const hasLines = doc.lineFields.length > 0;
  if (free.failures.length && hasLines) {
    const bound = await runObligations(cfg, doc, "bound", opts);
    result = bound;
    mode = "bound";
  }
  const kText = hasLines ? `every cart of 1..${bounds.kMax} lines (qty 1..${bounds.qtyMax})` : "every input";
  const details: ProverDetail[] = [];
  const vacText = result.vacuousK.length && result.vacuousK.length < (hasLines ? bounds.kMax : 1) ? ` (no input passes the checks with ${result.vacuousK.join(", ")} line(s))` : "";

  if (result.failures.length === 0) {
    const rulesN = doc.postingRules.length;
    const how =
      mode === "free"
        ? "for any line values"
        : `with line values taken from the catalog (${(opts.bindings ?? []).length ? "given bindings" : "inferred bindings"}); with free-form line values it would fail: ${firstReason(free)}`;
    details.push({
      subject: doc.id,
      status: "proved",
      lines: hasLines ? bounds.kMax : 0,
      mode,
      message: `debits = credits for ${kText} that passes the checks, ${how}; all ${rulesN} rule amounts are whole cents${doc.postingRules.some((r) => r.qtyExpr) ? ", register quantities are whole" : ""}${vacText}.`,
    });
    log?.push(`balance ${doc.id}: proved (${mode}, ${result.checked + (mode === "bound" ? free.checked : 0)} solver checks)`);
    return { status: "proved", durationMs: Math.round(performance.now() - t0), details };
  }

  for (const f of result.failures) details.push(await explain(cfg, doc, f, opts));
  log?.push(`balance ${doc.id}: FAILED (${details.map((d) => d.subject).join(", ")})`);
  return { status: "failed", durationMs: Math.round(performance.now() - t0), details };
}

function firstReason(r: RunResult): string {
  const f = r.failures[0];
  if (!f) return "";
  return f.kind === "balance" ? "unbalanced" : f.kind === "cents" ? `fractional cents in ${f.ruleId}` : f.kind;
}

async function explain(cfg: Configuration, doc: DocumentType, f: Failure, opts: ProveOptions): Promise<ProverDetail> {
  const subject = f.kind === "balance" ? doc.id : f.kind === "vacuous" ? `${doc.id}/vacuous` : `${doc.id}/${f.kind}${f.ruleId ? ":" + f.ruleId : ""}`;
  if (f.kind === "vacuous" && !f.unknown)
    return { subject, status: "failed", message: `no input passes the checks of ${doc.id}, so a balance proof would be vacuous; check the document's checks and catalog.` };
  if (f.unknown || !f.model)
    return { subject, status: "failed", lines: f.K, mode: f.mode, message: `solver could not decide (${f.unknown ?? "unknown"}) within the time limit; this is NOT a proof.` };

  const z = f.sym.z;
  const input = f.sym.extract(f.model);
  const cx = f.sym.describe(f.model);
  const rep = replay(cfg, doc, input, f.kind);
  const scen = scenario(cx, f.K, doc);
  const repText = rep.ok ? ` Replayed through ledger-core: ${rep.error}.` : ` WARNING: ledger-core replay did not reproduce this (${rep.error}); please report: encoder/evaluator mismatch.`;
  const suggest = opts.suggestFixes !== false;

  if (f.kind === "balance") {
    let imb: Rational;
    if (rep.debitCents !== undefined) imb = Rational.of(rep.debitCents! - rep.creditCents!, 100n);
    else imb = rationalOf(z, f.model.eval(f.imbalanceTerm!, true));
    cx["imbalance"] = money(imb);
    const shortSide = imb.lt(Rational.ZERO) ? "debits are short" : "credits are short";
    const off = money(imb.lt(Rational.ZERO) ? imb.neg() : imb);
    const fix = suggest ? await suggestBalanceFix(cfg, doc, input, imb, opts) : undefined;
    return {
      subject,
      status: "failed",
      counterexample: cx,
      imbalance: imb.toJSON(),
      lines: f.K,
      mode: f.mode,
      message: `${doc.id} breaks at ${scen}: off by ${off} (${shortSide}).${repText}`,
      suggestedFix: fix?.text,
      suggestedRule: fix?.rule,
    };
  }
  if (f.kind === "cents") {
    const fix = suggest ? await suggestCentsFix(cfg, doc, f.ruleId!, opts) : undefined;
    const rule = doc.postingRules.find((r) => r.id === f.ruleId)!;
    return {
      subject,
      status: "failed",
      counterexample: cx,
      lines: f.K,
      mode: f.mode,
      message: `rule ${f.ruleId} ("${rule.amountExpr}") can produce fractional cents, e.g. at ${scen}; the runtime would refuse to post it.${repText}`,
      suggestedFix: fix,
    };
  }
  if (f.kind === "qty")
    return { subject, status: "failed", counterexample: cx, lines: f.K, mode: f.mode, message: `rule ${f.ruleId} can move a fractional quantity at ${scen}.${repText}`, suggestedFix: "Make the quantity expression integral (quantities are whole units)." };
  return { subject, status: "failed", counterexample: cx, lines: f.K, mode: f.mode, message: `a division by zero is possible at ${scen}.${repText}`, suggestedFix: "Guard the divisor with a check (e.g. divisor > 0)." };
}
