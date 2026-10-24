// Posting-rule synthesis from examples.
//
// Bottom-up enumeration by program size over the grammar
//   e ::= var | lookup(catalog.field) | constant | e + e | e - e | e * e | (1 - e) | round2(e)
// with AST depth <= maxDepth (default 4), a light unit discipline (money/qty/rate) that drops
// meaningless programs like price + rate, and observational-equivalence pruning: two programs
// that produce the same values on the examples AND on a fixed set of probe inputs are one
// behaviour, and only the smallest is kept. Probes matter: on examples that all have a 0%
// discount, "qty * price" and "qty * price * (1 - discountRate)" agree, and keeping both is
// what lets us notice the examples do not determine the rule.
//
// Every value is computed by the ledger-core evaluator (each new node is evaluated by
// ledger-core `evaluate` on its children's exact values), and every returned rule is re-checked
// against the examples with ledger-core `evaluate` on the whole expression.
//
// Choice: the simplest fitting behaviour wins. It is ambiguous when several distinct behaviours
// share the minimal size, or when a slightly larger fitting rule reads an input the simplest one
// ignores (the examples never exercised that input, so we must not assume it does not matter).
// Then we pick the extra input that best splits the candidates and phrase an owner question.

import { evaluate, print, Rational, type Env, type Expr } from "@napkin/ledger-core";
import { exact, money } from "./format";

export type VocabType = "money" | "qty" | "rate" | "number";

export interface SynthExample {
  /** values by vocabulary name: "line.qty": 6, "doc.discountRate": "0.1", "lookup(products.price)": "2.50" */
  inputs: Record<string, string | number>;
  output: string | number;
}

export interface SynthesisRequest {
  examples: SynthExample[];
  /** "line.qty", "doc.discountRate", "policy.taxRate", "lookup(products.price)"; types are inferred if omitted */
  vocabulary: Array<string | { name: string; type?: VocabType }>;
  /** extra numeric literals the rule may use, e.g. ["0.5"] */
  constants?: string[];
  maxDepth?: number;
  /** what the rule computes, for the owner question ("revenue") */
  target?: string;
  /** phrase an input for the owner question (default: generated from the vocabulary) */
  describeInputs?: (inputs: Record<string, string>) => string;
  /** how much larger than the simplest rule an alternative may be and still be asked about (default 3) */
  slack?: number;
  /** stop after this many enumerated programs (default 400k) */
  budget?: number;
}

export interface SynthCandidate {
  expr: Expr;
  rule: string;
  size: number;
}

export type SynthesisResult =
  | ({ status: "unique" } & SynthCandidate & { log: string[] })
  | {
      status: "ambiguous";
      candidates: SynthCandidate[];
      question: { inputs: Record<string, string>; answersByCandidate: Record<string, string>; text: string };
      log: string[];
    }
  | { status: "none"; reason: string; log: string[] };

type Ty = VocabType;
interface Prog {
  expr: Expr;
  ty: Ty;
  size: number;
  depth: number;
  vals: Rational[]; // examples first, then probes
  vars: Set<string>;
}

const POOLS: Record<Ty, string[]> = {
  qty: ["1", "2", "3", "6", "7", "12"],
  money: ["0.99", "2.50", "3.00", "15.00", "4.80", "1.25"],
  rate: ["0.1", "0.15", "0.2", "0.05", "0.125"],
  number: ["1", "2", "5", "24"],
};

function inferType(name: string, values: Rational[]): Ty {
  const n = name.replace(/^lookup\(|\)$/g, "");
  const ws = n
    .slice(n.lastIndexOf(".") + 1)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const last = ws[ws.length - 1] ?? "";
  if (["qty", "quantity", "units", "count"].includes(last)) return "qty";
  if (["rate", "pct", "percent", "floor", "ratio"].includes(last)) return "rate";
  if (ws.some((w) => ["price", "cost", "amount", "total", "fee", "gross", "net", "tax", "discount", "value", "paid"].includes(w))) return "money";
  if (values.length && values.every((v) => v.isInteger() && v.ge(Rational.ZERO))) return "qty";
  if (values.length && values.every((v) => v.ge(Rational.ZERO) && v.le(Rational.ONE))) return "rate";
  return "money";
}

const lit = (r: Rational): Expr => ({ op: "num", value: r.isInteger() ? r.num.toString() : `${r.num}/${r.den}` });
const NO_ENV: Env = { get: () => undefined, lookup: () => undefined };

/** ledger-core evaluator applied to one node over exact child values */
function evalNode(op: Expr["op"], a: Rational, b?: Rational): Rational {
  let e: Expr;
  if (op === "round2") e = { op: "round2", arg: lit(a) };
  else e = { op: op as "add", args: [lit(a), lit(b!)] };
  const v = evaluate(e, NO_ENV);
  if (typeof v === "boolean") throw new Error("boolean");
  return v;
}

function mulType(a: Ty, b: Ty): Ty | null {
  if (a === "number") return b;
  if (b === "number") return a;
  if (a === "rate") return b;
  if (b === "rate") return a;
  if ((a === "money" && b === "qty") || (a === "qty" && b === "money")) return "money";
  return null;
}
function addType(a: Ty, b: Ty): Ty | null {
  if (a === b) return a;
  if (a === "number") return b;
  if (b === "number") return a;
  return null;
}

function envFor(inputs: Record<string, string | number>): Env {
  const get = (k: string) => (inputs[k] === undefined ? undefined : Rational.from(inputs[k] as string | number));
  return { get, lookup: (p) => get(`lookup(${p})`) };
}

function leafExpr(name: string): Expr {
  const m = /^lookup\((.+)\)$/.exec(name) ?? /^lookup:(.+)$/.exec(name);
  return m ? { op: "lookup", path: m[1]! } : { op: "var", name };
}

/** deterministic LCG so probes (and therefore results) are reproducible */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const words = (name: string) =>
  name
    .replace(/^lookup\(|\)$/g, "")
    .replace(/^.*\./, "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

function defaultDescribe(vocab: Array<{ name: string; type: Ty }>) {
  return (inputs: Record<string, string>) => {
    const parts: string[] = [];
    for (const v of vocab) {
      const raw = inputs[v.name];
      if (raw === undefined) continue;
      const r = Rational.parse(raw);
      const w = words(v.name);
      if (v.type === "rate") parts.push(`a ${exact(r.mul(Rational.of(100)))}% ${w.replace(/ ?rate$/, "") || "rate"}`);
      else if (v.type === "money") parts.push(`${w} ${money(r)}`);
      else parts.push(`${w} ${exact(r)}`);
    }
    if (parts.length <= 1) return parts.join("");
    return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
  };
}

export function synthesizePostingRule(req: SynthesisRequest): SynthesisResult {
  const t0 = performance.now();
  const log: string[] = [];
  const maxDepth = req.maxDepth ?? 4;
  const slack = req.slack ?? 3;
  const budget = req.budget ?? 400_000;
  if (!req.examples.length) return { status: "none", reason: "no examples", log };

  const vocab = req.vocabulary.map((v) => {
    const name = typeof v === "string" ? v : v.name;
    const seen = req.examples.map((e) => e.inputs[name]).filter((x) => x !== undefined).map((x) => Rational.from(x as string | number));
    return { name, type: (typeof v === "string" ? undefined : v.type) ?? inferType(name, seen) };
  });
  const expected = req.examples.map((e) => Rational.from(e.output));
  const targetTy: Ty = expected.every((x) => x.mul(Rational.of(100)).isInteger()) ? "money" : "number";

  // probe environments (part of the observational-equivalence signature)
  const rnd = lcg(0x6e61706b);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const probes: Array<Record<string, string>> = [];
  for (let i = 0; i < 10; i++) {
    const p: Record<string, string> = {};
    for (const v of vocab) p[v.name] = pick(POOLS[v.type]);
    probes.push(p);
  }
  const envs = [...req.examples.map((e) => envFor(e.inputs)), ...probes.map((p) => envFor(p))];
  const nEx = req.examples.length;

  // ---------- leaves ----------
  const bank: Prog[][] = [[]];
  const seen = new Set<string>();
  const sig = (ty: Ty, vals: Rational[]) => ty + "|" + vals.map((v) => `${v.num}/${v.den}`).join(",");
  const add = (p: Prog, out: Prog[]) => {
    const k = sig(p.ty, p.vals);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(p);
  };
  const leaves: Prog[] = [];
  for (const v of vocab) {
    const expr = leafExpr(v.name);
    try {
      const vals = envs.map((env) => {
        const r = evaluate(expr, env);
        if (typeof r === "boolean") throw new Error("boolean");
        return r;
      });
      add({ expr, ty: v.type, size: 1, depth: 1, vals, vars: new Set([v.name]) }, leaves);
    } catch {
      log.push(`synthesis: ${v.name} is missing from some example; not used`);
    }
  }
  for (const c of req.constants ?? []) {
    const r = Rational.parse(c);
    add({ expr: { op: "num", value: c }, ty: "number", size: 1, depth: 1, vals: envs.map(() => r), vars: new Set() }, leaves);
  }
  bank.push(leaves);

  const fits = (p: Prog) => p.ty === targetTy || p.ty === "number" ? expected.every((x, i) => x.eq(p.vals[i]!)) : false;
  const found: Prog[] = [];
  let s0: number | undefined;
  let enumerated = leaves.length;
  for (const p of leaves) if (fits(p)) found.push(p);
  if (found.length) s0 = 1;

  const MAX_SIZE = 15;
  let truncated = false;
  for (let s = 2; s <= MAX_SIZE && (s0 === undefined || s <= s0 + slack); s++) {
    const out: Prog[] = [];
    // unary: round2, (1 - x)  [(1 - x) is one grammar operator]
    for (const a of bank[s - 1] ?? []) {
      if (a.depth + 1 > maxDepth) continue;
      if (a.ty === "money") {
        try {
          add({ expr: { op: "round2", arg: a.expr }, ty: "money", size: s, depth: a.depth + 1, vals: a.vals.map((x) => evalNode("round2", x)), vars: a.vars }, out);
        } catch {
          /* skip */
        }
      }
      if (a.ty === "rate" || a.ty === "number") {
        try {
          add({ expr: { op: "sub", args: [{ op: "num", value: "1" }, a.expr] }, ty: a.ty, size: s, depth: a.depth + 1, vals: a.vals.map((x) => evalNode("sub", Rational.ONE, x)), vars: a.vars }, out);
        } catch {
          /* skip */
        }
      }
    }
    // binary
    // larger left operand first, so products print left-deep: qty * price * rate
    for (let sa = s - 2; sa >= 1; sa--) {
      const sb = s - 1 - sa;
      for (const [ia, a] of (bank[sa] ?? []).entries()) {
        for (const [ib, b] of (bank[sb] ?? []).entries()) {
          if (Math.max(a.depth, b.depth) + 1 > maxDepth) continue;
          const sym = sa > sb || (sa === sb && ia <= ib); // commutative ops: one order is enough
          for (const op of ["add", "sub", "mul"] as const) {
            if (op !== "sub" && !sym) continue;
            const ty = op === "mul" ? mulType(a.ty, b.ty) : addType(a.ty, b.ty);
            if (!ty) continue;
            enumerated++;
            try {
              const vals = a.vals.map((x, i) => evalNode(op, x, b.vals[i]!));
              add({ expr: { op, args: [a.expr, b.expr] }, ty, size: s, depth: Math.max(a.depth, b.depth) + 1, vals, vars: new Set([...a.vars, ...b.vars]) }, out);
            } catch {
              /* skip */
            }
          }
          if (enumerated > budget) {
            truncated = true;
            break;
          }
        }
        if (truncated) break;
      }
      if (truncated) break;
    }
    bank[s] = out;
    for (const p of out) if (fits(p)) found.push(p);
    if (s0 === undefined && found.length) s0 = s;
    if (truncated) {
      log.push(`synthesis: search budget of ${budget} programs reached at size ${s}`);
      break;
    }
  }
  const ms = Math.round(performance.now() - t0);
  log.push(`synthesis: enumerated ${enumerated} programs, ${seen.size} distinct behaviours, sizes 1..${bank.length - 1}, ${ms} ms`);

  // re-check every fitting candidate with the ledger-core evaluator on the whole expression
  const verified = found.filter((p) => req.examples.every((ex, i) => {
    try {
      const v = evaluate(p.expr, envFor(ex.inputs));
      return typeof v !== "boolean" && v.eq(expected[i]!);
    } catch {
      return false;
    }
  }));
  if (!verified.length || s0 === undefined) return { status: "none", reason: `no rule of depth <= ${maxDepth} over [${vocab.map((v) => v.name).join(", ")}] fits all ${nEx} examples`, log };

  verified.sort((a, b) => a.size - b.size || print(a.expr).length - print(b.expr).length);
  const minimal = verified.filter((p) => p.size === s0);
  const extended = verified.filter((p) => p.size > s0! && minimal.some((m) => [...m.vars].every((v) => p.vars.has(v)) && p.vars.size > m.vars.size));
  const pool = [...minimal, ...extended].slice(0, 4);
  const cand = (p: Prog): SynthCandidate => ({ expr: p.expr, rule: print(p.expr), size: p.size });

  if (pool.length === 1) {
    log.push(`synthesis: unique simplest rule ${print(pool[0]!.expr)} (size ${pool[0]!.size}) fits ${nEx} examples`);
    return { status: "unique", ...cand(pool[0]!), log };
  }

  // ---------- the question: which extra input best splits the candidates? ----------
  const options: Array<{ inputs: Record<string, string>; changed: number }> = [];
  for (const ex of req.examples) {
    const base: Record<string, string> = {};
    for (const v of vocab) base[v.name] = String(ex.inputs[v.name]);
    for (const v of vocab) for (const val of POOLS[v.type]) if (val !== base[v.name]) options.push({ inputs: { ...base, [v.name]: val }, changed: 1 });
  }
  for (const p of probes) options.push({ inputs: p, changed: vocab.length });
  const evalAt = (p: Prog, inputs: Record<string, string>) => {
    try {
      const v = evaluate(p.expr, envFor(inputs));
      return typeof v === "boolean" ? undefined : v;
    } catch {
      return undefined;
    }
  };
  let best: { inputs: Record<string, string>; distinct: number; changed: number; answers: Rational[] } | undefined;
  for (const o of options) {
    const answers = pool.map((p) => evalAt(p, o.inputs));
    if (answers.some((a) => a === undefined)) continue;
    const distinct = new Set(answers.map((a) => `${a!.num}/${a!.den}`)).size;
    if (!best || distinct > best.distinct || (distinct === best.distinct && o.changed < best.changed)) best = { inputs: o.inputs, distinct, changed: o.changed, answers: answers as Rational[] };
  }
  if (!best || best.distinct < 2) {
    log.push(`synthesis: ${pool.length} candidates but no probe input separates them; returning the simplest`);
    return { status: "unique", ...cand(pool[0]!), log };
  }
  // keep one candidate per distinct answer (the simplest), so the question has no duplicate options
  const byAnswer = new Map<string, number>();
  best.answers.forEach((a, i) => {
    const k = `${a.num}/${a.den}`;
    if (!byAnswer.has(k)) byAnswer.set(k, i);
  });
  const keep = [...byAnswer.values()];
  const candidates = keep.map((i) => cand(pool[i]!));
  const fmt = (r: Rational) => (targetTy === "money" && r.mul(Rational.of(100)).isInteger() ? money(r) : exact(r));
  const answersByCandidate: Record<string, string> = {};
  keep.forEach((i) => (answersByCandidate[print(pool[i]!.expr)] = fmt(best!.answers[i]!)));
  const opts = keep.map((i) => fmt(best!.answers[i]!));
  const optText = opts.length === 2 ? `${opts[0]} or ${opts[1]}` : `${opts.slice(0, -1).join(", ")} or ${opts[opts.length - 1]}`;
  const describe = req.describeInputs ?? defaultDescribe(vocab);
  const text = `For ${describe(best.inputs)}, should ${req.target ?? "the amount"} be ${optText}?`;
  log.push(`synthesis: ambiguous between ${candidates.map((c) => c.rule).join(" | ")}; asking: ${text}`);
  return { status: "ambiguous", candidates, question: { inputs: best.inputs, answersByCandidate, text }, log };
}
