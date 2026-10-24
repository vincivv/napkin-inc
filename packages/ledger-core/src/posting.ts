// Posting engine: document + definition -> journal lines + register movements.
// Pure and deterministic. The SpacetimeDB module calls this inside the posting transaction;
// the storefront and guards call it to price carts; the prover encodes the same rules into Z3.

import { compile, evalBool, evalNum, type Env } from "./dsl";
import { Rational } from "./rational";

export type Side = "debit" | "credit" | "in" | "out";
export type Scope = "doc" | "line";

export interface FieldDef {
  name: string;
  type: "number" | "string" | "money" | "rate" | "qty";
  required?: boolean;
}

export interface DerivedField {
  name: string;
  scope: Scope;
  expr: string;
}

export type PostingTarget =
  | { kind: "account"; code: string }
  /** dims map dimension name -> a string field reference, e.g. { item: "line.stockItem" } */
  | { kind: "register"; id: string; dims?: Record<string, string> };

export interface PostingRule {
  id: string;
  scope: Scope;
  target: PostingTarget;
  side: Side;
  amountExpr: string;
  qtyExpr?: string;
  when?: string;
  memo?: string;
}

export interface PolicyCheck {
  id: string;
  scope: Scope;
  /** boolean DSL expression that must hold, e.g. "line.net >= line.cost * (1 + policy.marginFloor)" */
  assert: string;
  message: string;
}

export interface CatalogDef {
  id: string;
  /** line field holding the entry id used by lookup(catalog.field) */
  lineKey: string;
}

export interface DocumentDef {
  id: string;
  name: string;
  fields: FieldDef[];
  lineFields: FieldDef[];
  derived: DerivedField[];
  postingRules: PostingRule[];
  checks: PolicyCheck[];
}

export type Scalar = string | number;
export interface DocumentInput {
  fields: Record<string, Scalar>;
  lines: Array<Record<string, Scalar>>;
}

export interface CatalogEntry {
  id: string;
  data: Record<string, Scalar | boolean | null>;
}

export interface PostingContext {
  /** numeric policy values as exact decimal strings, e.g. { marginFloor: "0.30" } */
  policies: Record<string, Scalar>;
  catalogs: Array<CatalogDef & { entries: CatalogEntry[] }>;
}

export interface JournalLine {
  ruleId: string;
  account: string;
  debitCents: bigint;
  creditCents: bigint;
  lineIndex: number | null;
  memo?: string;
}

export interface Movement {
  ruleId: string;
  register: string;
  kind: "in" | "out";
  dims: Record<string, string>;
  qty: bigint;
  amountCents: bigint;
  lineIndex: number | null;
}

export interface CheckFailure {
  checkId: string;
  lineIndex: number | null;
  message: string;
}

export interface Computed {
  doc: Record<string, Rational>;
  lines: Array<Record<string, Rational>>;
}

export interface PostingResult {
  computed: Computed;
  journal: JournalLine[];
  movements: Movement[];
  checkFailures: CheckFailure[];
  totalDebitCents: bigint;
  totalCreditCents: bigint;
}

export class UnbalancedPostingError extends Error {
  constructor(
    readonly docType: string,
    readonly debitCents: bigint,
    readonly creditCents: bigint,
    readonly journal: JournalLine[],
  ) {
    super(`${docType}: debits ${debitCents} != credits ${creditCents} (off by ${debitCents - creditCents} cents)`);
    this.name = "UnbalancedPostingError";
  }
}

export class PolicyCheckError extends Error {
  constructor(readonly failures: CheckFailure[]) {
    super(failures.map((f) => `${f.checkId}${f.lineIndex === null ? "" : `[line ${f.lineIndex}]`}: ${f.message}`).join("; "));
    this.name = "PolicyCheckError";
  }
}

const numericTypes = new Set(["number", "money", "rate", "qty"]);

function toRational(v: Scalar | boolean | null | undefined): Rational | undefined {
  if (v === undefined || v === null || typeof v === "boolean") return undefined;
  if (typeof v === "number") return Rational.from(v);
  try {
    return Rational.parse(v);
  } catch {
    return undefined;
  }
}

/** Build the evaluation environments for a document. */
export function buildEnvs(def: DocumentDef, input: DocumentInput, ctx: PostingContext) {
  const docNumeric = new Set(def.fields.filter((f) => numericTypes.has(f.type)).map((f) => f.name));
  const lineNumeric = new Set(def.lineFields.filter((f) => numericTypes.has(f.type)).map((f) => f.name));
  const computed: Computed = { doc: {}, lines: input.lines.map(() => ({})) };

  const policy = (name: string) => toRational(ctx.policies[name]);

  const lookupFor = (line: Record<string, Scalar> | null) => (path: string) => {
    if (!line) return undefined;
    const dot = path.indexOf(".");
    if (dot < 0) return undefined;
    const cat = ctx.catalogs.find((c) => c.id === path.slice(0, dot));
    if (!cat) return undefined;
    const key = line[cat.lineKey];
    const entry = cat.entries.find((e) => e.id === String(key));
    return entry ? toRational(entry.data[path.slice(dot + 1)]) : undefined;
  };

  const lineEnv = (i: number): Env => {
    const line = input.lines[i]!;
    return {
      get(name) {
        if (name.startsWith("line.")) {
          const k = name.slice(5);
          if (k in computed.lines[i]!) return computed.lines[i]![k];
          return lineNumeric.has(k) ? toRational(line[k]) : undefined;
        }
        return docGet(name);
      },
      lookup: lookupFor(line),
    };
  };

  function docGet(name: string): Rational | undefined {
    if (name.startsWith("doc.")) {
      const k = name.slice(4);
      if (k in computed.doc) return computed.doc[k];
      return docNumeric.has(k) ? toRational(input.fields[k]) : undefined;
    }
    if (name.startsWith("policy.")) return policy(name.slice(7));
    return undefined;
  }

  const docEnv: Env = {
    get: docGet,
    lookup: lookupFor(null),
    lines: () => input.lines.map((_, i) => lineEnv(i)),
  };

  return { docEnv, lineEnv, computed };
}

/** Evaluate derived fields in declaration order (line-scoped ones for every line). */
export function computeDocument(def: DocumentDef, input: DocumentInput, ctx: PostingContext) {
  const envs = buildEnvs(def, input, ctx);
  for (const d of def.derived) {
    const e = compile(d.expr);
    if (d.scope === "line") {
      input.lines.forEach((_, i) => {
        envs.computed.lines[i]![d.name] = evalNum(e, envs.lineEnv(i));
      });
    } else {
      envs.computed.doc[d.name] = evalNum(e, envs.docEnv);
    }
  }
  return envs;
}

/** Run policy checks; returns failures (empty = all hold). */
export function runChecks(def: DocumentDef, input: DocumentInput, ctx: PostingContext, envs = computeDocument(def, input, ctx)): CheckFailure[] {
  const failures: CheckFailure[] = [];
  for (const c of def.checks) {
    const e = compile(c.assert);
    if (c.scope === "line") {
      input.lines.forEach((_, i) => {
        if (!evalBool(e, envs.lineEnv(i))) failures.push({ checkId: c.id, lineIndex: i, message: c.message });
      });
    } else if (!evalBool(e, envs.docEnv)) {
      failures.push({ checkId: c.id, lineIndex: null, message: c.message });
    }
  }
  return failures;
}

function resolveDims(dims: Record<string, string> | undefined, input: DocumentInput, lineIndex: number | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [dim, ref] of Object.entries(dims ?? {})) {
    let val: Scalar | undefined;
    if (ref.startsWith("line.") && lineIndex !== null) val = input.lines[lineIndex]![ref.slice(5)];
    else if (ref.startsWith("doc.")) val = input.fields[ref.slice(4)];
    else if (ref.startsWith("'") && ref.endsWith("'")) val = ref.slice(1, -1);
    if (val === undefined || val === "") throw new Error(`dimension ${dim}: "${ref}" has no value`);
    out[dim] = String(val);
  }
  return out;
}

export interface PostOptions {
  /**
   * Red-team BASELINE only (business.enforce = false): skip the document's policy checks
   * (invariant 4). The balance check (invariant 1) is never skipped.
   */
  skipChecks?: boolean;
}

/**
 * Produce the postings for a document. Throws PolicyCheckError if a policy check fails and
 * UnbalancedPostingError if debits != credits (invariant 1). The balance check cannot be bypassed:
 * there is no "force" flag. Policy checks are skipped only with `skipChecks` (the red-team baseline).
 */
export function post(def: DocumentDef, input: DocumentInput, ctx: PostingContext, opts: PostOptions = {}): PostingResult {
  const envs = computeDocument(def, input, ctx);
  const checkFailures = opts.skipChecks ? [] : runChecks(def, input, ctx, envs);
  if (checkFailures.length) throw new PolicyCheckError(checkFailures);

  const journal: JournalLine[] = [];
  const movements: Movement[] = [];

  const apply = (r: PostingRule, env: Env, lineIndex: number | null) => {
    if (r.when && !evalBool(compile(r.when), env)) return;
    const amount = evalNum(compile(r.amountExpr), env).toCents();
    if (r.target.kind === "account") {
      if (r.side !== "debit" && r.side !== "credit") throw new Error(`rule ${r.id}: account rules must be debit or credit`);
      if (amount === 0n) return;
      // Negative amounts flip sides so every journal line is non-negative.
      const debit = (r.side === "debit") === amount > 0n;
      const abs = amount < 0n ? -amount : amount;
      journal.push({ ruleId: r.id, account: r.target.code, debitCents: debit ? abs : 0n, creditCents: debit ? 0n : abs, lineIndex, memo: r.memo });
    } else {
      if (r.side !== "in" && r.side !== "out") throw new Error(`rule ${r.id}: register rules must be in or out`);
      const q = r.qtyExpr ? evalNum(compile(r.qtyExpr), env) : Rational.ZERO;
      if (!q.isInteger()) throw new Error(`rule ${r.id}: quantity ${q.toDecimal()} is not whole`);
      if (q.isZero() && amount === 0n) return;
      movements.push({ ruleId: r.id, register: r.target.id, kind: r.side, dims: resolveDims(r.target.dims, input, lineIndex), qty: q.num, amountCents: amount, lineIndex });
    }
  };

  for (const r of def.postingRules) {
    if (r.scope === "line") input.lines.forEach((_, i) => apply(r, envs.lineEnv(i), i));
    else apply(r, envs.docEnv, null);
  }

  let dr = 0n;
  let cr = 0n;
  for (const j of journal) {
    dr += j.debitCents;
    cr += j.creditCents;
  }
  if (dr !== cr) throw new UnbalancedPostingError(def.id, dr, cr, journal);

  return { computed: envs.computed, journal, movements, checkFailures, totalDebitCents: dr, totalCreditCents: cr };
}

/** Reversal = the same lines with sides swapped and movements inverted. Posted documents are never edited. */
export function reversalOf(result: Pick<PostingResult, "journal" | "movements">): Pick<PostingResult, "journal" | "movements"> {
  return {
    journal: result.journal.map((j) => ({ ...j, debitCents: j.creditCents, creditCents: j.debitCents, memo: `reversal: ${j.memo ?? j.ruleId}` })),
    movements: result.movements.map((m) => ({ ...m, kind: m.kind === "in" ? "out" : "in" })),
  };
}
