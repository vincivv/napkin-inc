// DSL AST -> Z3, with exactly the ledger-core evaluator's semantics:
//   numbers are exact rationals (Z3 Real), round2(x) = floor(100x + 1/2)/100 (Z3 ToInt is floor),
//   min/max pick the left operand on ties (values are equal then anyway), comparisons and
//   and/or/not are the obvious ones, sum() ranges over a FIXED number of symbolic lines.
// Division: the evaluator throws on x/0, Z3 leaves x/0 unspecified, so every division records a
// side condition "denominator != 0" that callers prove (or assume) explicitly.

import { DslTypeError, Rational, UnknownNameError, type Expr } from "@napkin/ledger-core";
import type { Z3, ZArith, ZBool } from "./z3";

export type ZTerm = ZArith | ZBool;

export interface EncodeScope {
  z: Z3;
  /** doc.x / line.x / policy.x as a Real term, or undefined if the name is unknown here. */
  get(name: string): ZArith | undefined;
  /** lookup(catalog.field) for the current line. */
  lookup(path: string): ZArith | undefined;
  /** line scopes for sum(); only in doc scope. */
  lines?(): EncodeScope[];
  /** where division side conditions are collected (denominator != 0). */
  sideConditions?: ZBool[];
}

export function realVal(z: Z3, r: Rational): ZArith {
  return z.Real.val({ numerator: r.num, denominator: r.den });
}

/** round2(x) = floor(100x + 1/2) / 100, exactly as Rational.round2. */
export function round2Term(z: Z3, x: ZArith): ZArith {
  return z.ToReal(z.ToInt(x.mul(100).add(z.Real.val({ numerator: 1n, denominator: 2n })))).div(100);
}

const isBool = (z: Z3, t: ZTerm): t is ZBool => z.isBool(t);

function num(z: Z3, t: ZTerm, where: string): ZArith {
  if (isBool(z, t)) throw new DslTypeError(`${where}: expected a number, got a boolean`);
  return t as ZArith;
}
function bool(z: Z3, t: ZTerm, where: string): ZBool {
  if (!isBool(z, t)) throw new DslTypeError(`${where}: expected a boolean, got a number`);
  return t;
}

export function encode(e: Expr, scope: EncodeScope): ZTerm {
  const z = scope.z;
  const rec = (x: Expr, s: EncodeScope = scope) => encode(x, s);
  switch (e.op) {
    case "num":
      return realVal(z, Rational.parse(e.value));
    case "var": {
      const t = scope.get(e.name);
      if (t === undefined) throw new UnknownNameError(e.name);
      return t;
    }
    case "lookup": {
      const t = scope.lookup(e.path);
      if (t === undefined) throw new UnknownNameError(`lookup(${e.path})`);
      return t;
    }
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "min":
    case "max": {
      const a = num(z, rec(e.args[0]), e.op);
      const b = num(z, rec(e.args[1]), e.op);
      switch (e.op) {
        case "add":
          return a.add(b);
        case "sub":
          return a.sub(b);
        case "mul":
          return a.mul(b);
        case "div":
          scope.sideConditions?.push(b.neq(0));
          return a.div(b);
        case "min":
          return z.If(a.le(b), a, b);
        case "max":
          return z.If(a.ge(b), a, b);
      }
      break;
    }
    case "round2":
      return round2Term(z, num(z, rec(e.arg), "round2"));
    case "sum": {
      if (!scope.lines) throw new DslTypeError("sum() is only valid in document scope");
      let acc: ZArith = z.Real.val(0);
      for (const ls of scope.lines()) acc = acc.add(num(z, rec(e.arg, ls), "sum"));
      return acc;
    }
    case "ge":
    case "gt":
    case "le":
    case "lt":
    case "eq":
    case "ne": {
      const a = num(z, rec(e.args[0]), e.op);
      const b = num(z, rec(e.args[1]), e.op);
      switch (e.op) {
        case "ge":
          return a.ge(b);
        case "gt":
          return a.gt(b);
        case "le":
          return a.le(b);
        case "lt":
          return a.lt(b);
        case "eq":
          return a.eq(b);
        case "ne":
          return a.neq(b);
      }
      break;
    }
    case "and":
      return z.And(bool(z, rec(e.args[0]), "and"), bool(z, rec(e.args[1]), "and"));
    case "or":
      return z.Or(bool(z, rec(e.args[0]), "or"), bool(z, rec(e.args[1]), "or"));
    case "not":
      return z.Not(bool(z, rec(e.arg), "not"));
  }
  throw new DslTypeError(`unknown op ${(e as { op: string }).op}`);
}

export function encodeNum(e: Expr, scope: EncodeScope): ZArith {
  return num(scope.z, encode(e, scope), "expression");
}
export function encodeBool(e: Expr, scope: EncodeScope): ZBool {
  return bool(scope.z, encode(e, scope), "condition");
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
