// A document type instantiated symbolically: every numeric input is a Z3 constant constrained to
// its valid domain, derived fields are encoded in declaration order (exactly like ledger-core
// computeDocument), and checks become Z3 booleans. A model of the resulting formula is turned back
// into a concrete DocumentInput and replayed through ledger-core post().
//
// Two modes:
//   free  - every numeric line field is an unconstrained input of its type (strongest result)
//   bound - line fields that the platform fills from a catalog entry take that entry's exact
//           values; the caller fixes WHICH entry each line uses (one solver query per entry
//           combination), so catalog values are constants and qty * unitPrice stays linear.

import { compile, Rational, type DocumentDef, type DocumentInput, type PostingContext, type Scalar } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { constNV, encodeBool, encodeNum, evalNV, intNV, iteNV, realNV, type EncodeScope, type NV } from "./encode";
import { exact } from "./format";
import type { Z3, ZArith, ZBool, ZModel } from "./z3";

export type DocumentType = Configuration["documents"][number];
export type CatalogCfg = Configuration["catalogs"][number];
export type FieldType = "number" | "string" | "money" | "rate" | "qty";

export interface Bounds {
  /** maximum number of lines a document is proven for (1..kMax are all checked) */
  kMax: number;
  qtyMax: number;
  moneyMaxCents: bigint;
  /**
   * rates are proven for every multiple of 1/rateDenominator in [0, 1] (default: basis points,
   * as PLAN section 2 specifies). Encoding rates as Int numerators keeps the arithmetic in
   * integers; Z3's mixed Int/Real nonlinear reasoning returned spurious models in testing.
   */
  rateDenominator: bigint;
}
export const NICE_TIERS = 4;
export const DEFAULT_BOUNDS: Bounds = { kMax: 3, qtyMax: 10_000, moneyMaxCents: 100_000_000n, rateDenominator: 10_000n };

/** line.<lineField> is filled by the platform from <catalogId>.<field> of the line's catalog entry. */
export interface CatalogBinding {
  lineField: string;
  catalogId: string;
  field: string;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Infer which line fields come from the catalog: a line field f is bound to catalog C's field g
 * when C's lineKey is also a line field of the document and (g == f or f == "unit" + G).
 * First catalog in configuration order wins. This is a naming heuristic, so the balance proof
 * first tries with these fields FREE (a stronger result) and only falls back to the binding.
 */
export function inferCatalogBindings(cfg: Configuration, doc: DocumentType): CatalogBinding[] {
  const lineNames = new Set(doc.lineFields.map((f) => f.name));
  const out: CatalogBinding[] = [];
  for (const lf of doc.lineFields) {
    for (const cat of cfg.catalogs) {
      if (!lineNames.has(cat.lineKey) || cat.lineKey === lf.name) continue;
      const g = cat.fields.find((f) => f.name === lf.name || `unit${cap(f.name)}` === lf.name);
      if (g) {
        out.push({ lineField: lf.name, catalogId: cat.id, field: g.name });
        break;
      }
    }
  }
  return out;
}

/** Catalogs whose entry a line chooses directly (its lineKey is a line field not filled from another catalog). */
export function rootCatalogs(cfg: Configuration, doc: DocumentType, bindings: CatalogBinding[]): CatalogCfg[] {
  const lineNames = new Set(doc.lineFields.map((f) => f.name));
  return cfg.catalogs.filter((c) => lineNames.has(c.lineKey) && !bindings.some((b) => b.lineField === c.lineKey));
}

export function numericPolicies(cfg: Configuration): Record<string, Rational> {
  const out: Record<string, Rational> = {};
  for (const [k, v] of Object.entries(cfg.policies)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = Rational.from(v);
    else if (typeof v === "string") {
      try {
        out[k] = Rational.parse(v);
      } catch {
        /* non-numeric policy (currency etc.) */
      }
    }
  }
  return out;
}

export function postingContext(cfg: Configuration): PostingContext {
  const policies: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(cfg.policies)) if (typeof v === "string" || typeof v === "number") policies[k] = v;
  return { policies, catalogs: cfg.catalogs.map((c) => ({ id: c.id, lineKey: c.lineKey, entries: c.entries as never })) };
}

export const asDef = (d: DocumentType) => d as unknown as DocumentDef;

export function catalogValue(v: unknown): Rational | undefined {
  if (v === null || v === undefined || typeof v === "boolean") return undefined;
  if (typeof v === "number") return Rational.from(v);
  if (typeof v === "string") {
    try {
      return Rational.parse(v);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export interface InputVar {
  /** "doc.discountRate", "line[0].qty", "line[0].productId" */
  key: string;
  type: FieldType | "key" | "component";
  /** the Z3 constant */
  term: ZArith;
  /** extra constraints that make a counterexample human-friendly, by tier (0 = nicest) */
  nice(tier: number): ZBool[];
}

export interface SymbolicDoc {
  z: Z3;
  doc: DocumentType;
  K: number;
  mode: "free" | "bound";
  /** bound mode: the catalog entry each line uses, per root catalog */
  lineEntries?: Array<Record<string, string>>;
  /** input domains, catalog-definedness */
  domain: ZBool[];
  /** policy checks (preconditions for posting), each tagged */
  checks: Array<{ id: string; lineIndex: number | null; term: ZBool }>;
  /** division side conditions (denominator != 0) */
  side: ZBool[];
  docScope: EncodeScope;
  lineScopes: EncodeScope[];
  vars: InputVar[];
  /** turn a model into a concrete document input */
  extract(m: ZModel): DocumentInput;
  /** human-readable inputs for the counterexample */
  describe(m: ZModel): Record<string, string>;
}

export interface BuildOptions {
  K: number;
  mode: "free" | "bound";
  bounds?: Bounds;
  bindings?: CatalogBinding[];
  /** bound mode: line i uses entry lineEntries[i][catalogId] of each root catalog */
  lineEntries?: Array<Record<string, string>>;
  /** replace a doc field by a value (used to model stacked discount components) */
  docOverrides?: Record<string, { value: NV; vars: InputVar[]; domain: ZBool[] }>;
  /** override numeric policies (used to verify suggested fixes) */
  policyOverrides?: Record<string, Rational>;
  /** skip encoding these checks (by id) */
  omitChecks?: Set<string>;
  prefix?: string;
}

let uid = 0;

type Entry = CatalogCfg["entries"][number];

export function buildSymbolicDoc(z: Z3, cfg: Configuration, doc: DocumentType, o: BuildOptions): SymbolicDoc {
  const bounds = o.bounds ?? DEFAULT_BOUNDS;
  const P = o.prefix ?? `q${++uid}`;
  const allBindings = o.bindings ?? inferCatalogBindings(cfg, doc);
  const bindings = o.mode === "bound" ? allBindings : [];
  const policies = { ...numericPolicies(cfg), ...(o.policyOverrides ?? {}) };
  const catalogs = new Map(cfg.catalogs.map((c) => [c.id, c]));
  const roots = new Set(rootCatalogs(cfg, doc, allBindings).map((c) => c.id));
  const lineFieldNames = new Set(doc.lineFields.map((f) => f.name));
  const domain: ZBool[] = [];
  const side: ZBool[] = [];
  const vars: InputVar[] = [];
  const K = doc.lineFields.length === 0 ? 0 : o.K;
  if (o.mode === "bound" && K > 0 && (!o.lineEntries || o.lineEntries.length < K)) throw new Error("bound mode needs lineEntries for every line");

  const C = (r: Rational) => constNV(z, r);
  const bindingOf = (lf: string, list: CatalogBinding[]) => list.find((b) => b.lineField === lf);

  // ---------- variables ----------
  // tiers 0..3, nicest first: [qty cap, money: multiple of 25c and <= $100?, rate step in bp]
  const TIERS = [
    { qty: 6, coarseMoney: true, rateBp: 500n },
    { qty: 24, coarseMoney: false, rateBp: 100n },
    { qty: 6, coarseMoney: true, rateBp: 50n },
    { qty: 24, coarseMoney: false, rateBp: 10n },
  ];
  const niceInt = (n: ZArith, t: FieldType) => (tier: number): ZBool[] => {
    const T = TIERS[tier];
    if (!T) return [];
    if (t === "money") return T.coarseMoney ? [n.mod(z.Int.val(25)).eq(0), n.le(10_000)] : [n.le(100_000)];
    if (t === "qty") return [n.le(T.qty)];
    if (t === "rate") {
      const step = (bounds.rateDenominator * T.rateBp) / 10_000n;
      return step > 1n ? [n.mod(z.Int.val(step)).eq(0)] : [];
    }
    return [];
  };
  const niceReal = (x: ZArith, t: FieldType) => (tier: number): ZBool[] => {
    const T = TIERS[tier];
    if (!T) return [];
    if (t === "rate") return [z.IsInt(x.mul(Number(10_000n / T.rateBp)))];
    if (t === "number") return [z.IsInt(x), x.ge(0), x.le(T.coarseMoney ? 48 : 1000)];
    if (t === "money") return [z.IsInt(x.mul(T.coarseMoney ? 4 : 100)), x.le(T.coarseMoney ? 100 : 1000)];
    if (t === "qty") return [x.le(T.qty)];
    return [];
  };

  const mkVar = (key: string, t: FieldType, extras: Rational[] = []): NV => {
    const name = `${P}.${key}`;
    if (t === "money" && extras.every((e) => e.mul(Rational.of(100)).isInteger())) {
      const c = z.Int.const(name) as unknown as ZArith;
      const dom = z.And(c.ge(0), c.le(z.Int.val(bounds.moneyMaxCents)));
      domain.push(extras.length ? z.Or(dom, ...extras.map((e) => c.eq(z.Int.val(e.mul(Rational.of(100)).num)))) : dom);
      vars.push({ key, type: t, term: c, nice: niceInt(c, t) });
      return intNV(c, 100n);
    }
    if (t === "qty" && extras.every((e) => e.isInteger())) {
      const n = z.Int.const(name) as unknown as ZArith;
      const dom = z.And(n.ge(1), n.le(bounds.qtyMax));
      domain.push(extras.length ? z.Or(dom, ...extras.map((e) => n.eq(z.Int.val(e.num)))) : dom);
      vars.push({ key, type: t, term: n, nice: niceInt(n, t) });
      return intNV(n, 1n);
    }
    const RD = bounds.rateDenominator;
    if (t === "rate" && extras.every((e) => e.mul(Rational.of(RD)).isInteger())) {
      const b = z.Int.const(name) as unknown as ZArith;
      const dom = z.And(b.ge(0), b.le(z.Int.val(RD)));
      domain.push(extras.length ? z.Or(dom, ...extras.map((e) => b.eq(z.Int.val(e.mul(Rational.of(RD)).num)))) : dom);
      vars.push({ key, type: t, term: b, nice: niceInt(b, t) });
      return intNV(b, RD);
    }
    const x = z.Real.const(name);
    const R = (r: Rational) => z.Real.val({ numerator: r.num, denominator: r.den });
    let dom: ZBool;
    switch (t) {
      case "money":
        dom = z.And(z.IsInt(x.mul(100)), x.ge(0), x.le(R(Rational.of(bounds.moneyMaxCents, 100n))));
        break;
      case "qty":
        dom = z.And(z.IsInt(x), x.ge(1), x.le(bounds.qtyMax));
        break;
      case "rate":
        dom = z.And(x.ge(0), x.le(1));
        break;
      default:
        dom = z.Bool.val(true);
    }
    const ex = t === "rate" || t === "number" ? [] : extras.map((e) => x.eq(R(e)));
    domain.push(ex.length ? z.Or(dom, ...ex) : dom);
    vars.push({ key, type: t, term: x, nice: niceReal(x, t) });
    return realNV(x);
  };

  // ---------- doc inputs ----------
  const docInputs: Record<string, NV> = {};
  for (const f of doc.fields) {
    if (f.type === "string") continue;
    const ov = o.docOverrides?.[f.name];
    if (ov) {
      docInputs[f.name] = ov.value;
      domain.push(...ov.domain);
      vars.push(...ov.vars);
      continue;
    }
    docInputs[f.name] = mkVar(`doc.${f.name}`, f.type);
  }

  // ---------- catalog entries per line ----------
  // bound mode: entries are fixed per line (resolved statically, chains included)
  const fixedEntry = (i: number, catalogId: string, depth = 0): Entry | undefined => {
    const cat = catalogs.get(catalogId);
    if (!cat || depth > 4) return undefined;
    if (roots.has(catalogId)) {
      const id = o.lineEntries?.[i]?.[catalogId];
      return cat.entries.find((e) => e.id === id);
    }
    const chain = bindingOf(cat.lineKey, allBindings);
    if (!chain) return undefined;
    const src = fixedEntry(i, chain.catalogId, depth + 1);
    if (!src) return undefined;
    return cat.entries.find((e) => e.id === String(src.data[chain.field] ?? ""));
  };

  // free mode: symbolic entry index per (line, catalog)
  const keyIdx: Array<Map<string, ZArith>> = Array.from({ length: K }, () => new Map());
  const keyIndex = (i: number, catalogId: string, depth = 0): ZArith | undefined => {
    const have = keyIdx[i]!.get(catalogId);
    if (have) return have;
    const cat = catalogs.get(catalogId);
    if (!cat || !lineFieldNames.has(cat.lineKey) || depth > 4) return undefined;
    const chain = bindingOf(cat.lineKey, allBindings);
    let idx: ZArith;
    if (chain && !roots.has(catalogId)) {
      const src = catalogs.get(chain.catalogId)!;
      const srcIdx = keyIndex(i, chain.catalogId, depth + 1);
      if (!srcIdx) return undefined;
      let t: ZArith = z.Int.val(-1) as unknown as ZArith;
      src.entries.forEach((e, j) => {
        const target = cat.entries.findIndex((ce) => ce.id === String(e.data[chain.field] ?? ""));
        t = z.If(srcIdx.eq(j), z.Int.val(target), t) as ZArith;
      });
      idx = t;
    } else {
      idx = z.Int.const(`${P}.line[${i}].${cat.lineKey}#${catalogId}`) as unknown as ZArith;
      domain.push(z.And(idx.ge(0), idx.lt(cat.entries.length)));
      vars.push({ key: `line[${i}].${cat.lineKey}`, type: "key", term: idx, nice: () => [] });
    }
    keyIdx[i]!.set(catalogId, idx);
    return idx;
  };

  /** value of catalogId.field for line i; an undefined value is a precondition (runtime throws, nothing posts) */
  const catalogNV = (i: number, catalogId: string, field: string): NV | undefined => {
    const cat = catalogs.get(catalogId);
    if (!cat) return undefined;
    if (o.mode === "bound" && (roots.has(catalogId) || bindingOf(cat.lineKey, allBindings))) {
      const e = fixedEntry(i, catalogId);
      const v = e ? catalogValue(e.data[field]) : undefined;
      if (v === undefined) {
        domain.push(z.Bool.val(false));
        return C(Rational.ZERO);
      }
      return C(v);
    }
    const idx = keyIndex(i, catalogId);
    if (!idx) return undefined;
    let t: NV = C(Rational.ZERO);
    const defined: ZBool[] = [];
    cat.entries.forEach((e, j) => {
      const v = catalogValue(e.data[field]);
      if (v === undefined) return;
      defined.push(idx.eq(j));
      t = iteNV(z, idx.eq(j), C(v), t);
    });
    domain.push(defined.length ? z.Or(...defined) : z.Bool.val(false));
    return t;
  };

  // ---------- line inputs ----------
  const lineInputs: Array<Record<string, NV>> = [];
  const lineComputed: Array<Record<string, NV>> = [];
  for (let i = 0; i < K; i++) {
    const inputs: Record<string, NV> = {};
    for (const f of doc.lineFields) {
      if (f.type === "string") continue;
      const b = bindingOf(f.name, bindings);
      if (b) {
        const t = catalogNV(i, b.catalogId, b.field);
        if (t) {
          inputs[f.name] = t;
          continue;
        }
      }
      // free: the type's domain, widened by any catalog values this field could be filled from
      const fb = bindingOf(f.name, allBindings);
      const extra = fb ? (catalogs.get(fb.catalogId)?.entries ?? []).map((e) => catalogValue(e.data[fb.field])).filter((v): v is Rational => v !== undefined) : [];
      inputs[f.name] = mkVar(`line[${i}].${f.name}`, f.type, extra);
    }
    lineInputs.push(inputs);
    lineComputed.push({});
  }

  // ---------- scopes ----------
  const computedDoc: Record<string, NV> = {};
  const docGet = (name: string): NV | undefined => {
    if (name.startsWith("doc.")) {
      const k = name.slice(4);
      return computedDoc[k] ?? docInputs[k];
    }
    if (name.startsWith("policy.")) {
      const p = policies[name.slice(7)];
      return p ? C(p) : undefined;
    }
    return undefined;
  };
  const lineScopes: EncodeScope[] = lineInputs.map((inputs, i) => ({
    z,
    sideConditions: side,
    get(name) {
      if (name.startsWith("line.")) {
        const k = name.slice(5);
        return lineComputed[i]![k] ?? inputs[k];
      }
      return docGet(name);
    },
    lookup(path) {
      const dot = path.indexOf(".");
      if (dot < 0) return undefined;
      return catalogNV(i, path.slice(0, dot), path.slice(dot + 1));
    },
  }));
  const docScope: EncodeScope = { z, sideConditions: side, get: docGet, lookup: () => undefined, lines: () => lineScopes };

  // ---------- derived (declaration order, like computeDocument) ----------
  for (const d of doc.derived) {
    const e = compile(d.expr);
    if (d.scope === "line") lineScopes.forEach((s, i) => (lineComputed[i]![d.name] = encodeNum(e, s)));
    else computedDoc[d.name] = encodeNum(e, docScope);
  }

  // ---------- checks ----------
  const checks: SymbolicDoc["checks"] = [];
  for (const c of doc.checks) {
    if (o.omitChecks?.has(c.id)) continue;
    const e = compile(c.assert);
    if (c.scope === "line") lineScopes.forEach((s, i) => checks.push({ id: c.id, lineIndex: i, term: encodeBool(e, s) }));
    else checks.push({ id: c.id, lineIndex: null, term: encodeBool(e, docScope) });
  }

  // ---------- model -> concrete input ----------
  const val = (m: ZModel, v: NV) => evalNV(z, m as never, v);
  const entryIn = (m: ZModel, i: number, catalogId: string): Entry | undefined => {
    if (o.mode === "bound") {
      const e = fixedEntry(i, catalogId);
      if (e) return e;
    }
    const idx = keyIdx[i]!.get(catalogId);
    if (!idx) return undefined;
    const j = Number(evalNV(z, m as never, intNV(idx)).num);
    return catalogs.get(catalogId)!.entries[j];
  };
  const extract = (m: ZModel): DocumentInput => {
    const fields: Record<string, Scalar> = {};
    for (const f of doc.fields) fields[f.name] = f.type === "string" ? `cx-${f.name}` : exact(val(m, docInputs[f.name]!));
    const outLines = lineInputs.map((inputs, i) => {
      const line: Record<string, Scalar> = {};
      for (const f of doc.lineFields) {
        if (f.type !== "string") {
          line[f.name] = exact(val(m, inputs[f.name]!));
          continue;
        }
        const rootCat = cfg.catalogs.find((c) => c.lineKey === f.name && roots.has(c.id));
        const b = bindingOf(f.name, bindings);
        if (rootCat && entryIn(m, i, rootCat.id)) line[f.name] = entryIn(m, i, rootCat.id)!.id;
        else if (b && entryIn(m, i, b.catalogId)) line[f.name] = String(entryIn(m, i, b.catalogId)!.data[b.field] ?? "");
        else line[f.name] = `cx-${f.name}`;
      }
      return line;
    });
    return { fields, lines: outLines };
  };

  const describe = (m: ZModel): Record<string, string> => {
    const input = extract(m);
    const out: Record<string, string> = {};
    for (const f of doc.fields) {
      if (f.type === "string") continue;
      out[`doc.${f.name}`] = show(f.type, Rational.parse(String(input.fields[f.name])));
    }
    for (const v of vars) if (v.type === "component") out[v.key] = show("rate", evalNV(z, m as never, intNV(v.term, bounds.rateDenominator)));
    input.lines.forEach((line, i) => {
      for (const f of doc.lineFields) {
        const raw = line[f.name];
        if (f.type === "string") {
          if (raw !== undefined && raw !== "" && !String(raw).startsWith("cx-")) out[`line[${i}].${f.name}`] = String(raw);
        } else out[`line[${i}].${f.name}`] = show(f.type, Rational.parse(String(raw)));
      }
    });
    return out;
  };

  return { z, doc, K, mode: o.mode, lineEntries: o.lineEntries, domain, checks, side, docScope, lineScopes, vars, extract, describe };
}

/** All multisets of size K over the per-line choices (lines are order-independent in the DSL). */
export function entryCombos(cfg: Configuration, doc: DocumentType, K: number, bindings?: CatalogBinding[]): Array<Array<Record<string, string>>> {
  const roots = rootCatalogs(cfg, doc, bindings ?? inferCatalogBindings(cfg, doc));
  let perLine: Array<Record<string, string>> = [{}];
  for (const c of roots) perLine = perLine.flatMap((p) => c.entries.map((e) => ({ ...p, [c.id]: e.id })));
  const out: Array<Array<Record<string, string>>> = [];
  const rec = (start: number, acc: Array<Record<string, string>>) => {
    if (acc.length === K) {
      out.push(acc);
      return;
    }
    for (let j = start; j < perLine.length; j++) rec(j, [...acc, perLine[j]!]);
  };
  rec(0, []);
  return out;
}

export function show(t: FieldType, r: Rational): string {
  if (t === "money") {
    const c = r.mul(Rational.of(100));
    if (c.isInteger()) {
      const neg = c.num < 0n;
      const a = neg ? -c.num : c.num;
      return `${neg ? "-" : ""}$${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
    }
  }
  if (t === "rate") {
    const p = r.mul(Rational.of(100));
    const s = exact(p);
    return s.includes("/") ? `${exact(r)} (≈${p.toDecimal(2).replace("…", "")}%)` : `${s}%`;
  }
  return exact(r);
}
