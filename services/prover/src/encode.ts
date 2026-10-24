// DSL AST -> Z3, with exactly the ledger-core evaluator's semantics.
//
// Representation. Every numeric DSL value is encoded as a "scaled integer" t/d where t is a Z3
// Int term and d a positive bigint constant, whenever that is possible (literals, money in cents,
// quantities, and every +, -, *, min, max, round2 and comparison over them). This is exact: a
// decimal literal 0.30 is 30/100, money is cents/100, round2(t/d) = floor((200t + d) / 2d) / 100
// with Z3's integer division (floor for a positive divisor), the same arithmetic Rational.round2
// does. Only when a genuinely real-valued input is involved (a rate in [0,1], a free "number"
// field, or division by a non-constant) do we fall back to Z3 Real; there round2 uses ToInt
// (floor), again exactly floor(100x + 1/2)/100. Keeping money in Int keeps most proof
// obligations in linear integer arithmetic, which is what makes the proofs fast.
//
// min/max pick the left operand on ties (the values are equal then anyway); comparisons and
// and/or/not are the obvious ones; sum() ranges over a FIXED number of symbolic lines.
// Division: the evaluator throws on x/0; Z3 leaves x/0 unspecified, so every non-constant division
// records a side condition "denominator != 0" that callers prove (or assume) explicitly.

import { DslTypeError, Rational, UnknownNameError, type Expr } from "@napkin/ledger-core";
import type { Z3, ZArith, ZBool } from "./z3";

/** A numeric value: Int term scaled by 1/d, or a Real term. */
export type NV = { k: "i"; t: ZArith; d: bigint; c?: Rational } | { k: "r"; t: ZArith; c?: Rational };
export type ZVal = NV | { k: "b"; t: ZBool };
export type ZTerm = ZArith | ZBool;

/** What a scope may return for a name: an NV, or a plain Z3 arithmetic term (Int or Real sort). */
export type ScopeValue = NV | ZArith;

export interface EncodeScope {
  z: Z3;
  /** doc.x / line.x / policy.x, or undefined if the name is unknown here. */
  get(name: string): ScopeValue | undefined;
  /** lookup(catalog.field) for the current line. */
  lookup(path: string): ScopeValue | undefined;
  /** line scopes for sum(); only in doc scope. */
  lines?(): EncodeScope[];
  /** where division side conditions are collected (denominator != 0). */
  sideConditions?: ZBool[];
}

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b) [a, b] = [b, a % b];
  return a;
};
const lcm = (a: bigint, b: bigint) => (a / gcd(a, b)) * b;

export function realVal(z: Z3, r: Rational): ZArith {
  return z.Real.val({ numerator: r.num, denominator: r.den });
}

export function constNV(z: Z3, r: Rational): NV {
  return { k: "i", t: z.Int.val(r.num), d: r.den, c: r };
}

/** Int variable t meaning t/d. */
export function intNV(t: ZArith, d: bigint = 1n): NV {
  return { k: "i", t, d };
}

export function realNV(t: ZArith): NV {
  return { k: "r", t };
}

export function normalize(z: Z3, v: ScopeValue): NV {
  if ((v as NV).k === "i" || (v as NV).k === "r") return v as NV;
  const t = v as ZArith;
  return z.isIntSort(t.sort) ? { k: "i", t, d: 1n } : { k: "r", t };
}

/** The value as a Z3 Real term. */
export function toReal(z: Z3, v: NV): ZArith {
  if (v.k === "r") return v.t;
  if (v.c) return realVal(z, v.c);
  const r = z.ToReal(v.t);
  return v.d === 1n ? r : r.div(realVal(z, Rational.of(v.d)));
}

function scaleTo(z: Z3, v: NV & { k: "i" }, L: bigint): ZArith {
  const f = L / v.d;
  if (v.c) return z.Int.val(v.c.num * f);
  return f === 1n ? v.t : v.t.mul(z.Int.val(f));
}

function both(a: NV, b: NV): a is NV & { k: "i" } {
  return a.k === "i" && b.k === "i";
}

export function addNV(z: Z3, a: NV, b: NV, sign: 1 | -1 = 1): NV {
  if (a.c && b.c) return constNV(z, sign === 1 ? a.c.add(b.c) : a.c.sub(b.c));
  if (b.c?.isZero()) return a;
  if (both(a, b)) {
    const bi = b as NV & { k: "i" };
    const L = lcm(a.d, bi.d);
    const x = scaleTo(z, a, L);
    const y = scaleTo(z, bi, L);
    return { k: "i", t: sign === 1 ? x.add(y) : x.sub(y), d: L };
  }
  const x = toReal(z, a);
  const y = toReal(z, b);
  return { k: "r", t: sign === 1 ? x.add(y) : x.sub(y) };
}

export function mulNV(z: Z3, a: NV, b: NV): NV {
  if (a.c && b.c) return constNV(z, a.c.mul(b.c));
  if (both(a, b)) {
    const bi = b as NV & { k: "i" };
    // constant factor n/m: keep linear and fold the denominator
    if (a.c) return { k: "i", t: bi.t.mul(z.Int.val(a.c.num)), d: bi.d * a.c.den };
    if (bi.c) return { k: "i", t: a.t.mul(z.Int.val(bi.c.num)), d: a.d * bi.c.den };
    return { k: "i", t: a.t.mul(bi.t), d: a.d * bi.d };
  }
  return { k: "r", t: toReal(z, a).mul(toReal(z, b)) };
}

export function iteNV(z: Z3, c: ZBool, a: NV, b: NV): NV {
  if (both(a, b)) {
    const bi = b as NV & { k: "i" };
    const L = lcm(a.d, bi.d);
    return { k: "i", t: z.If(c, scaleTo(z, a, L), scaleTo(z, bi, L)) as ZArith, d: L };
  }
  return { k: "r", t: z.If(c, toReal(z, a), toReal(z, b)) as ZArith };
}

export type Cmp = "ge" | "gt" | "le" | "lt" | "eq" | "ne";
export function cmpNV(z: Z3, op: Cmp, a: NV, b: NV): ZBool {
  if (a.c && b.c) {
    const c = a.c.cmp(b.c);
    const r = { ge: c >= 0, gt: c > 0, le: c <= 0, lt: c < 0, eq: c === 0, ne: c !== 0 }[op];
    return z.Bool.val(r);
  }
  let x: ZArith, y: ZArith;
  if (both(a, b)) {
    const bi = b as NV & { k: "i" };
    const L = lcm(a.d, bi.d);
    x = scaleTo(z, a, L);
    y = scaleTo(z, bi, L);
  } else {
    x = toReal(z, a);
    y = toReal(z, b);
  }
  switch (op) {
    case "ge":
      return x.ge(y);
    case "gt":
      return x.gt(y);
    case "le":
      return x.le(y);
    case "lt":
      return x.lt(y);
    case "eq":
      return x.eq(y);
    case "ne":
      return x.neq(y);
  }
}

/** round2(x) = floor(100x + 1/2) / 100, exactly as Rational.round2. Always returns Int-scaled cents. */
export function round2NV(z: Z3, v: NV): NV {
  if (v.c) return constNV(z, v.c.round2());
  if (v.k === "i") {
    if (100n % v.d === 0n) return { k: "i", t: v.d === 100n ? v.t : v.t.mul(z.Int.val(100n / v.d)), d: 100n }; // already whole cents
    // floor((100t/d) + 1/2) = floor((200t + d) / (2d)); Z3 Int div is floor for a positive divisor
    return { k: "i", t: v.t.mul(z.Int.val(200n)).add(z.Int.val(v.d)).div(z.Int.val(2n * v.d)), d: 100n };
  }
  return { k: "i", t: z.ToInt(v.t.mul(100).add(z.Real.val({ numerator: 1n, denominator: 2n }))), d: 100n };
}

/** Real-term version (kept for callers that work with Real terms). */
export function round2Term(z: Z3, x: ZArith): ZArith {
  return z.ToReal(z.ToInt(x.mul(100).add(z.Real.val({ numerator: 1n, denominator: 2n })))).div(100);
}

/** "this value is a whole number of cents" */
export function isCents(z: Z3, v: NV): ZBool {
  if (v.c) return z.Bool.val(v.c.mul(Rational.of(100)).isInteger());
  if (v.k === "i") {
    const g = v.d / gcd(v.d, 100n); // t*100/d integral <=> t divisible by d/gcd(d,100)
    return g === 1n ? z.Bool.val(true) : v.t.mod(z.Int.val(g)).eq(0);
  }
  return z.IsInt(v.t.mul(100));
}

/** "this value is a whole number" */
export function isWhole(z: Z3, v: NV): ZBool {
  if (v.c) return z.Bool.val(v.c.isInteger());
  if (v.k === "i") return v.d === 1n ? z.Bool.val(true) : v.t.mod(z.Int.val(v.d)).eq(0);
  return z.IsInt(v.t);
}

/** value * 100 as an Int term when the value is known to be whole cents (i-form with d | 100). */
export function centsTerm(z: Z3, v: NV): ZArith | undefined {
  if (v.c) return v.c.mul(Rational.of(100)).isInteger() ? z.Int.val(v.c.mul(Rational.of(100)).num) : undefined;
  if (v.k === "i" && 100n % v.d === 0n) return v.d === 100n ? v.t : v.t.mul(z.Int.val(100n / v.d));
  return undefined;
}

const isNum = (v: ZVal): v is NV => v.k !== "b";

function num(v: ZVal, where: string): NV {
  if (!isNum(v)) throw new DslTypeError(`${where}: expected a number, got a boolean`);
  return v;
}
function bool(v: ZVal, where: string): ZBool {
  if (v.k !== "b") throw new DslTypeError(`${where}: expected a boolean, got a number`);
  return v.t;
}

/** Encode to the internal value representation. */
export function encodeValue(e: Expr, scope: EncodeScope): ZVal {
  const z = scope.z;
  const rec = (x: Expr, s: EncodeScope = scope) => encodeValue(x, s);
  switch (e.op) {
    case "num":
      return constNV(z, Rational.parse(e.value));
    case "var": {
      const t = scope.get(e.name);
      if (t === undefined) throw new UnknownNameError(e.name);
      return normalize(z, t);
    }
    case "lookup": {
      const t = scope.lookup(e.path);
      if (t === undefined) throw new UnknownNameError(`lookup(${e.path})`);
      return normalize(z, t);
    }
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "min":
    case "max": {
      const a = num(rec(e.args[0]), e.op);
      const b = num(rec(e.args[1]), e.op);
      switch (e.op) {
        case "add":
          return addNV(z, a, b, 1);
        case "sub":
          return addNV(z, a, b, -1);
        case "mul":
          return mulNV(z, a, b);
        case "div":
          if (b.c) {
            if (b.c.isZero()) {
              scope.sideConditions?.push(z.Bool.val(false));
              return a;
            }
            return mulNV(z, a, constNV(z, Rational.ONE.div(b.c)));
          }
          scope.sideConditions?.push(cmpNV(z, "ne", b, constNV(z, Rational.ZERO)));
          return { k: "r", t: toReal(z, a).div(toReal(z, b)) };
        case "min":
          return iteNV(z, cmpNV(z, "le", a, b), a, b);
        case "max":
          return iteNV(z, cmpNV(z, "ge", a, b), a, b);
      }
      break;
    }
    case "round2":
      return round2NV(z, num(rec(e.arg), "round2"));
    case "sum": {
      if (!scope.lines) throw new DslTypeError("sum() is only valid in document scope");
      let acc: NV = constNV(z, Rational.ZERO);
      for (const ls of scope.lines()) acc = addNV(z, acc, num(rec(e.arg, ls), "sum"));
      return acc;
    }
    case "ge":
    case "gt":
    case "le":
    case "lt":
    case "eq":
    case "ne":
      return { k: "b", t: cmpNV(z, e.op, num(rec(e.args[0]), e.op), num(rec(e.args[1]), e.op)) };
    case "and":
      return { k: "b", t: z.And(bool(rec(e.args[0]), "and"), bool(rec(e.args[1]), "and")) };
    case "or":
      return { k: "b", t: z.Or(bool(rec(e.args[0]), "or"), bool(rec(e.args[1]), "or")) };
    case "not":
      return { k: "b", t: z.Not(bool(rec(e.arg), "not")) };
  }
  throw new DslTypeError(`unknown op ${(e as { op: string }).op}`);
}

/** Public: encode an expression to a Z3 term (Real for numbers, Bool for conditions). */
export function encode(e: Expr, scope: EncodeScope): ZTerm {
  const v = encodeValue(e, scope);
  return v.k === "b" ? v.t : toReal(scope.z, v);
}

export function encodeNum(e: Expr, scope: EncodeScope): NV {
  return num(encodeValue(e, scope), "expression");
}
export function encodeBool(e: Expr, scope: EncodeScope): ZBool {
  return bool(encodeValue(e, scope), "condition");
}

/** Read an exact rational out of a Z3 numeral (Int or Real). */
export function rationalOf(z: Z3, t: ZTerm): Rational {
  if (z.isIntVal(t)) return Rational.of(t.value());
  if (z.isRealVal(t)) {
    const v = t.value();
    return Rational.of(BigInt(v.numerator), BigInt(v.denominator));
  }
  throw new Error(`not a numeral: ${t.toString()}`);
}

/** Value of an NV in a model. */
export function evalNV(z: Z3, m: { eval(t: ZArith, completion?: boolean): ZArith }, v: NV): Rational {
  if (v.c) return v.c;
  const r = rationalOf(z, m.eval(v.t, true));
  return v.k === "i" ? r.div(Rational.of(v.d)) : r;
}
