// A document type instantiated symbolically: every numeric input is a Z3 constant constrained to
// its valid domain, derived fields are encoded in declaration order (exactly like
// ledger-core computeDocument), and checks become Z3 booleans. A model of the resulting formula
// can be turned back into a concrete DocumentInput and replayed through ledger-core post().

import { compile, Rational, type DocumentDef, type DocumentInput, type PostingContext, type Scalar } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { encodeBool, encodeNum, rationalOf, realVal, type EncodeScope } from "./encode";
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
}
export const DEFAULT_BOUNDS: Bounds = { kMax: 3, qtyMax: 10_000, moneyMaxCents: 100_000_000n };

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

function catalogValue(v: unknown): Rational | undefined {
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
  term: ZArith;
  /** extra constraints that make a counterexample human-friendly, by tier (0 = nicest) */
  nice(tier: number): ZBool[];
}

export interface SymbolicDoc {
  z: Z3;
  doc: DocumentType;
  K: number;
  mode: "free" | "bound";
  /** input domains, catalog-definedness, binding constraints */
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
  /** replace a doc field by a term (used to model stacked discount components) */
  docOverrides?: Record<string, { term: ZArith; vars: InputVar[]; domain: ZBool[] }>;
  /** fix line i's key for a catalog to one entry */
  fixKeys?: Array<{ line: number; catalogId: string; entryId: string }>;
  /** skip encoding these checks (by id) */
  omitChecks?: Set<string>;
  prefix?: string;
}

let uid = 0;

export function buildSymbolicDoc(z: Z3, cfg: Configuration, doc: DocumentType, o: BuildOptions): SymbolicDoc {
  const bounds = o.bounds ?? DEFAULT_BOUNDS;
  const P = o.prefix ?? `q${++uid}`;
  const bindings = o.mode === "bound" ? (o.bindings ?? inferCatalogBindings(cfg, doc)) : [];
  const allBindings = o.bindings ?? inferCatalogBindings(cfg, doc);
  const policies = numericPolicies(cfg);
  const catalogs = new Map(cfg.catalogs.map((c) => [c.id, c]));
  const domain: ZBool[] = [];
  const side: ZBool[] = [];
  const vars: InputVar[] = [];
  const K = doc.lineFields.length === 0 ? 0 : o.K;

  const R = (r: Rational) => realVal(z, r);
  const isIntR = (x: ZArith) => z.IsInt(x);

  const typeDomain = (x: ZArith, t: FieldType): ZBool => {
    switch (t) {
      case "money":
        return z.And(isIntR(x.mul(100)), x.ge(0), x.le(R(Rational.of(bounds.moneyMaxCents, 100n))));
      case "qty":
        return z.And(isIntR(x), x.ge(1), x.le(bounds.qtyMax));
      case "rate":
        return z.And(x.ge(0), x.le(1));
      default:
        return z.Bool.val(true);
    }
  };
  const niceFor = (x: ZArith, t: FieldType) => (tier: number): ZBool[] => {
    if (tier >= 2) return [];
    const small = tier === 0;
    switch (t) {
      case "money":
        return [isIntR(x.mul(small ? 4 : 100)), x.le(small ? 100 : 1000)];
      case "qty":
        return [x.le(small ? 6 : 24)];
      case "rate":
        return [isIntR(x.mul(small ? 20 : 100))];
      case "number":
        return [isIntR(x), x.ge(0), x.le(small ? 48 : 1000)];
      default:
        return [];
    }
  };

  const mkVar = (key: string, t: FieldType, extraValues: Rational[] = []): ZArith => {
    const x = z.Real.const(`${P}.${key}`);
    const extras = extraValues.map((v) => x.eq(R(v)));
    domain.push(extras.length ? z.Or(typeDomain(x, t), ...extras) : typeDomain(x, t));
    vars.push({ key, type: t, term: x, nice: niceFor(x, t) });
    return x;
  };

  // ---------- doc inputs ----------
  const docInputs: Record<string, ZArith> = {};
  for (const f of doc.fields) {
    if (f.type === "string") continue;
    const ov = o.docOverrides?.[f.name];
    if (ov) {
      docInputs[f.name] = ov.term;
      domain.push(...ov.domain);
      vars.push(...ov.vars);
      continue;
    }
    docInputs[f.name] = mkVar(`doc.${f.name}`, f.type);
  }

  // ---------- line inputs ----------
  type LineState = {
    inputs: Record<string, ZArith>;
    keyIdx: Map<string, ZArith>; // catalogId -> entry index term
    computed: Record<string, ZArith>;
  };
  const lines: LineState[] = [];
  const lineFieldNames = new Set(doc.lineFields.map((f) => f.name));
  const bindingOf = (lf: string, list: CatalogBinding[]) => list.find((b) => b.lineField === lf);

  const keyIndex = (i: number, catalogId: string, depth = 0): ZArith | undefined => {
    const L = lines[i]!;
    const have = L.keyIdx.get(catalogId);
    if (have) return have;
    const cat = catalogs.get(catalogId);
    if (!cat || !lineFieldNames.has(cat.lineKey) || depth > 4) return undefined;
    const fixed = o.fixKeys?.find((f) => f.line === i && f.catalogId === catalogId);
    const chain = bindingOf(cat.lineKey, bindings);
    let idx: ZArith;
    if (chain && !fixed) {
      // the key itself is filled from another catalog entry (e.g. line.stockItem <- products.stockItem)
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
      if (fixed) {
        const j = cat.entries.findIndex((e) => e.id === fixed.entryId);
        domain.push(idx.eq(j));
      } else domain.push(z.And(idx.ge(0), idx.lt(cat.entries.length)));
      vars.push({ key: `line[${i}].${cat.lineKey}`, type: "key", term: idx, nice: () => [] });
    }
    L.keyIdx.set(catalogId, idx);
    return idx;
  };

  /** value of catalogId.field for line i: If-chain over entries; records definedness as a precondition */
  const catalogTerm = (i: number, catalogId: string, field: string): ZArith | undefined => {
    const cat = catalogs.get(catalogId);
    const idx = keyIndex(i, catalogId);
    if (!cat || !idx) return undefined;
    let t: ZArith = z.Real.val(0);
    const defined: ZBool[] = [];
    cat.entries.forEach((e, j) => {
      const v = catalogValue(e.data[field]);
      if (v === undefined) return;
      defined.push(idx.eq(j));
      t = z.If(idx.eq(j), R(v), t) as ZArith;
    });
    // at runtime an undefined lookup throws, so no posting happens: that is a precondition, not a failure
    domain.push(defined.length ? z.Or(...defined) : z.Bool.val(false));
    return t;
  };

  for (let i = 0; i < K; i++) {
    const L: LineState = { inputs: {}, keyIdx: new Map(), computed: {} };
    lines.push(L);
  }
  for (let i = 0; i < K; i++) {
    const L = lines[i]!;
    for (const f of doc.lineFields) {
      if (f.type === "string") continue;
      const b = bindingOf(f.name, bindings);
      if (b) {
        const t = catalogTerm(i, b.catalogId, b.field);
        if (t) {
          L.inputs[f.name] = t;
          continue;
        }
      }
      // free: the type's domain, widened by any catalog values this field could be filled from
      const fb = bindingOf(f.name, allBindings);
      const extra = fb ? (catalogs.get(fb.catalogId)?.entries ?? []).map((e) => catalogValue(e.data[fb.field])).filter((v): v is Rational => v !== undefined) : [];
      L.inputs[f.name] = mkVar(`line[${i}].${f.name}`, f.type, extra);
    }
    // bound mode: catalogs referenced only through string bindings still need their index
    if (o.mode === "bound") for (const b of bindings) if (lineFieldNames.has(b.lineField)) keyIndex(i, b.catalogId);
    for (const fk of o.fixKeys ?? []) if (fk.line === i) keyIndex(i, fk.catalogId);
  }

  // ---------- scopes ----------
  const computedDoc: Record<string, ZArith> = {};
  const policy = (name: string) => (policies[name] ? R(policies[name]!) : undefined);
  const docGet = (name: string): ZArith | undefined => {
    if (name.startsWith("doc.")) {
      const k = name.slice(4);
      return computedDoc[k] ?? docInputs[k];
    }
    if (name.startsWith("policy.")) return policy(name.slice(7));
    return undefined;
  };
  const lineScopes: EncodeScope[] = lines.map((L, i) => ({
    z,
    sideConditions: side,
    get(name) {
      if (name.startsWith("line.")) {
        const k = name.slice(5);
        return L.computed[k] ?? L.inputs[k];
      }
      return docGet(name);
    },
    lookup(path) {
      const dot = path.indexOf(".");
      if (dot < 0) return undefined;
      return catalogTerm(i, path.slice(0, dot), path.slice(dot + 1));
    },
  }));
  const docScope: EncodeScope = { z, sideConditions: side, get: docGet, lookup: () => undefined, lines: () => lineScopes };

  // ---------- derived (declaration order, like computeDocument) ----------
  for (const d of doc.derived) {
    const e = compile(d.expr);
    if (d.scope === "line") lines.forEach((L, i) => (L.computed[d.name] = encodeNum(e, lineScopes[i]!)));
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
  const val = (m: ZModel, t: ZArith) => rationalOf(z, m.eval(t, true));
  const extract = (m: ZModel): DocumentInput => {
    const fields: Record<string, Scalar> = {};
    for (const f of doc.fields) fields[f.name] = f.type === "string" ? `cx-${f.name}` : exact(val(m, docInputs[f.name]!));
    const outLines = lines.map((L, i) => {
      const line: Record<string, Scalar> = {};
      for (const f of doc.lineFields) {
        if (f.type !== "string") {
          line[f.name] = exact(val(m, L.inputs[f.name]!));
          continue;
        }
        const b = bindingOf(f.name, bindings);
        const keyCat = cfg.catalogs.find((c) => c.lineKey === f.name && L.keyIdx.has(c.id));
        if (b && L.keyIdx.has(b.catalogId)) {
          const j = Number(val(m, L.keyIdx.get(b.catalogId)!).num);
          const e = catalogs.get(b.catalogId)!.entries[j];
          line[f.name] = e ? String(e.data[b.field] ?? "") : "";
        } else if (keyCat) {
          const j = Number(val(m, L.keyIdx.get(keyCat.id)!).num);
          line[f.name] = keyCat.entries[j]?.id ?? `cx-unknown`;
        } else line[f.name] = `cx-${f.name}`;
      }
      // a string field that is a catalog key, filled by chain, must agree with the chain
      for (const c of cfg.catalogs) {
        const idx = L.keyIdx.get(c.id);
        if (idx && lineFieldNames.has(c.lineKey) && !bindingOf(c.lineKey, bindings)) {
          const j = Number(val(m, idx).num);
          if (c.entries[j]) line[c.lineKey] = c.entries[j]!.id;
        }
      }
      void i;
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
    for (const v of vars) if (v.type === "component") out[v.key] = show("rate", val(m, v.term));
    input.lines.forEach((line, i) => {
      for (const f of doc.lineFields) {
        const raw = line[f.name];
        if (f.type === "string") {
          if (raw !== undefined && !String(raw).startsWith("cx-")) out[`line[${i}].${f.name}`] = String(raw);
        } else out[`line[${i}].${f.name}`] = show(f.type, Rational.parse(String(raw)));
      }
    });
    return out;
  };

  return { z, doc, K, mode: o.mode, domain, checks, side, docScope, lineScopes, vars, extract, describe };
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
