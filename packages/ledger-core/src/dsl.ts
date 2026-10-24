// Posting-rule expression language. One AST, three consumers:
//   - this evaluator (platform posting, storefront pricing, runtime guards)
//   - the Z3 encoder in services/prover (balance + discount proofs)
//   - the enumerator in services/prover (posting synthesis)
// Semantics are exact rationals. round2 = floor(x*100 + 1/2)/100.

import { Rational } from "./rational";

export type BinOp = "add" | "sub" | "mul" | "div" | "min" | "max";
export type CmpOp = "ge" | "gt" | "le" | "lt" | "eq" | "ne";

export type Expr =
  | { op: "num"; value: string } // exact decimal literal
  | { op: "var"; name: string } // doc.x | line.x | policy.x
  | { op: "lookup"; path: string } // catalog.field, resolved against the current line
  | { op: BinOp; args: [Expr, Expr] }
  | { op: "round2"; arg: Expr }
  | { op: "sum"; arg: Expr } // doc scope only: sum of arg over lines
  | { op: CmpOp; args: [Expr, Expr] }
  | { op: "and" | "or"; args: [Expr, Expr] }
  | { op: "not"; arg: Expr };

export type Value = Rational | boolean;

export interface Env {
  /** Resolve doc.x / line.x / policy.x. Return undefined if unknown: we never assume a default. */
  get(name: string): Rational | undefined;
  /** Resolve lookup(catalog.field) for the current line. */
  lookup(path: string): Rational | undefined;
  /** For sum(): environments for each line. Only available in doc scope. */
  lines?(): Env[];
}

export class UnknownNameError extends Error {
  constructor(readonly ref: string) {
    super(`unknown name "${ref}" (no default is assumed)`);
    this.name = "UnknownNameError";
  }
}

export class DslTypeError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "DslTypeError";
  }
}

// ---------- constructors (handy for synthesis and tests) ----------
export const num = (v: string | number): Expr => ({ op: "num", value: Rational.from(v).toDecimal(12) });
export const v = (name: string): Expr => ({ op: "var", name });
export const lookup = (path: string): Expr => ({ op: "lookup", path });
export const add = (a: Expr, b: Expr): Expr => ({ op: "add", args: [a, b] });
export const sub = (a: Expr, b: Expr): Expr => ({ op: "sub", args: [a, b] });
export const mul = (a: Expr, b: Expr): Expr => ({ op: "mul", args: [a, b] });
export const oneMinus = (a: Expr): Expr => sub(num(1), a);
export const round2 = (a: Expr): Expr => ({ op: "round2", arg: a });

// ---------- evaluation ----------
export function evaluate(e: Expr, env: Env): Value {
  switch (e.op) {
    case "num":
      return Rational.parse(e.value);
    case "var": {
      const r = env.get(e.name);
      if (r === undefined) throw new UnknownNameError(e.name);
      return r;
    }
    case "lookup": {
      const r = env.lookup(e.path);
      if (r === undefined) throw new UnknownNameError(`lookup(${e.path})`);
      return r;
    }
    case "add":
    case "sub":
    case "mul":
    case "div":
    case "min":
    case "max": {
      const a = num_(evaluate(e.args[0], env), e.op);
      const b = num_(evaluate(e.args[1], env), e.op);
      if (e.op === "add") return a.add(b);
      if (e.op === "sub") return a.sub(b);
      if (e.op === "mul") return a.mul(b);
      if (e.op === "div") return a.div(b);
      if (e.op === "min") return a.le(b) ? a : b;
      return a.ge(b) ? a : b;
    }
    case "round2":
      return num_(evaluate(e.arg, env), "round2").round2();
    case "sum": {
      if (!env.lines) throw new DslTypeError("sum() is only valid in document scope");
      let acc = Rational.ZERO;
      for (const le of env.lines()) acc = acc.add(num_(evaluate(e.arg, le), "sum"));
      return acc;
    }
    case "ge":
    case "gt":
    case "le":
    case "lt":
    case "eq":
    case "ne": {
      const c = num_(evaluate(e.args[0], env), e.op).cmp(num_(evaluate(e.args[1], env), e.op));
      switch (e.op) {
        case "ge":
          return c >= 0;
        case "gt":
          return c > 0;
        case "le":
          return c <= 0;
        case "lt":
          return c < 0;
        case "eq":
          return c === 0;
        case "ne":
          return c !== 0;
      }
    }
    // falls through is impossible; TS needs the return above
    case "and":
      return bool_(evaluate(e.args[0], env), "and") && bool_(evaluate(e.args[1], env), "and");
    case "or":
      return bool_(evaluate(e.args[0], env), "or") || bool_(evaluate(e.args[1], env), "or");
    case "not":
      return !bool_(evaluate(e.arg, env), "not");
  }
}

export function evalNum(e: Expr, env: Env): Rational {
  return num_(evaluate(e, env), "expression");
}
export function evalBool(e: Expr, env: Env): boolean {
  return bool_(evaluate(e, env), "condition");
}

function num_(x: Value, where: string): Rational {
  if (typeof x === "boolean") throw new DslTypeError(`${where}: expected a number, got a boolean`);
  return x;
}
function bool_(x: Value, where: string): boolean {
  if (typeof x !== "boolean") throw new DslTypeError(`${where}: expected a boolean, got a number`);
  return x;
}

// ---------- structure ----------
export function depth(e: Expr): number {
  switch (e.op) {
    case "num":
    case "var":
    case "lookup":
      return 1;
    case "round2":
    case "sum":
    case "not":
      return 1 + depth(e.arg);
    default:
      return 1 + Math.max(depth(e.args[0]), depth(e.args[1]));
  }
}

export function size(e: Expr): number {
  switch (e.op) {
    case "num":
    case "var":
    case "lookup":
      return 1;
    case "round2":
    case "sum":
    case "not":
      return 1 + size(e.arg);
    default:
      return 1 + size(e.args[0]) + size(e.args[1]);
  }
}

/** All names an expression reads: "doc.x", "line.x", "policy.x", "lookup:catalog.field". */
export function names(e: Expr, out = new Set<string>()): Set<string> {
  switch (e.op) {
    case "num":
      break;
    case "var":
      out.add(e.name);
      break;
    case "lookup":
      out.add(`lookup:${e.path}`);
      break;
    case "round2":
    case "sum":
    case "not":
      names(e.arg, out);
      break;
    default:
      names(e.args[0], out);
      names(e.args[1], out);
  }
  return out;
}

// ---------- printing (canonical, re-parseable) ----------
const PREC: Record<string, number> = { or: 1, and: 2, ge: 3, gt: 3, le: 3, lt: 3, eq: 3, ne: 3, add: 4, sub: 4, mul: 5, div: 5 };
const SYM: Record<string, string> = { or: "||", and: "&&", ge: ">=", gt: ">", le: "<=", lt: "<", eq: "==", ne: "!=", add: "+", sub: "-", mul: "*", div: "/" };

export function print(e: Expr): string {
  return pr(e, 0);
}
function pr(e: Expr, parent: number): string {
  switch (e.op) {
    case "num":
      return e.value;
    case "var":
      return e.name;
    case "lookup":
      return `lookup(${e.path})`;
    case "round2":
      return `round2(${pr(e.arg, 0)})`;
    case "sum":
      return `sum(${pr(e.arg, 0)})`;
    case "not":
      return `!${pr(e.arg, 9)}`;
    case "min":
    case "max":
      return `${e.op}(${pr(e.args[0], 0)}, ${pr(e.args[1], 0)})`;
    default: {
      const p = PREC[e.op]!;
      // left-assoc: right child needs parens at equal precedence for - and /
      const s = `${pr(e.args[0], p)} ${SYM[e.op]} ${pr(e.args[1], p + 1)}`;
      return p < parent ? `(${s})` : s;
    }
  }
}

// ---------- parsing ----------
type Tok = { t: "num" | "id" | "op" | "(" | ")" | "," | "eof"; s: string; pos: number };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if ((m = /^\d+(?:\.\d+)?/.exec(rest))) {
      out.push({ t: "num", s: m[0], pos: i });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(rest))) {
      out.push({ t: "id", s: m[0], pos: i });
      i += m[0].length;
    } else if ((m = /^(>=|<=|==|!=|&&|\|\||[+\-*/<>!])/.exec(rest))) {
      out.push({ t: "op", s: m[0], pos: i });
      i += m[0].length;
    } else if (c === "(" || c === ")" || c === ",") {
      out.push({ t: c, s: c, pos: i });
      i++;
    } else {
      throw new SyntaxError(`unexpected "${c}" at ${i} in: ${src}`);
    }
  }
  out.push({ t: "eof", s: "", pos: src.length });
  return out;
}

export function parse(src: string): Expr {
  const toks = lex(src);
  let k = 0;
  const peek = () => toks[k]!;
  const next = () => toks[k++]!;
  const expect = (t: Tok["t"], s?: string) => {
    const x = next();
    if (x.t !== t || (s !== undefined && x.s !== s)) throw new SyntaxError(`expected ${s ?? t} at ${x.pos} in: ${src}`);
    return x;
  };
  const isOp = (...ss: string[]) => peek().t === "op" && ss.includes(peek().s);

  const BIN: Record<string, Expr["op"]> = { "||": "or", "&&": "and", ">=": "ge", ">": "gt", "<=": "le", "<": "lt", "==": "eq", "!=": "ne", "+": "add", "-": "sub", "*": "mul", "/": "div" };
  const bin = (op: string, a: Expr, b: Expr) => ({ op: BIN[op], args: [a, b] }) as Expr;

  function or(): Expr {
    let a = and();
    while (isOp("||")) a = bin(next().s, a, and());
    return a;
  }
  function and(): Expr {
    let a = cmp();
    while (isOp("&&")) a = bin(next().s, a, cmp());
    return a;
  }
  function cmp(): Expr {
    const a = sum();
    if (isOp(">=", "<=", ">", "<", "==", "!=")) return bin(next().s, a, sum());
    return a;
  }
  function sum(): Expr {
    let a = term();
    while (isOp("+", "-")) a = bin(next().s, a, term());
    return a;
  }
  function term(): Expr {
    let a = unary();
    while (isOp("*", "/")) a = bin(next().s, a, unary());
    return a;
  }
  function unary(): Expr {
    if (isOp("-")) {
      next();
      return sub({ op: "num", value: "0" }, unary());
    }
    if (isOp("!")) {
      next();
      return { op: "not", arg: unary() };
    }
    return primary();
  }
  function primary(): Expr {
    const x = next();
    if (x.t === "num") return { op: "num", value: x.s };
    if (x.t === "(") {
      const e = or();
      expect(")");
      return e;
    }
    if (x.t === "id") {
      if (peek().t !== "(") return { op: "var", name: x.s };
      next();
      switch (x.s) {
        case "lookup": {
          const p = expect("id").s;
          expect(")");
          return { op: "lookup", path: p };
        }
        case "round2":
        case "sum": {
          const arg = or();
          expect(")");
          return { op: x.s, arg };
        }
        case "min":
        case "max": {
          const a = or();
          expect(",");
          const b = or();
          expect(")");
          return { op: x.s, args: [a, b] };
        }
        default:
          throw new SyntaxError(`unknown function ${x.s}() at ${x.pos}`);
      }
    }
    throw new SyntaxError(`unexpected "${x.s || x.t}" at ${x.pos} in: ${src}`);
  }

  const e = or();
  if (peek().t !== "eof") throw new SyntaxError(`trailing input at ${peek().pos} in: ${src}`);
  return e;
}

const cache = new Map<string, Expr>();
/** Parse with memoization (rules are re-evaluated on every posting). */
export function compile(src: string): Expr {
  let e = cache.get(src);
  if (!e) {
    e = parse(src);
    cache.set(src, e);
  }
  return e;
}
