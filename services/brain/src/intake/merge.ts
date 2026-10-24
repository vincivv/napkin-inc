// Deterministic merge of two BusinessSpec drafts (photo + voice, or a new draft into the current spec).
// Code, not LLM. Properties (tested): order-independent (merge(a,b) == merge(b,a)); never drops a differing
// candidate (it ends up in an OpenQuestion's candidates or in `alternatives`).
//
// Per field:
//   only one side has a real value           -> keep it
//   same value (normalized)                  -> keep the better fact, confidence = max, confirmed = either
//   different values:
//     exactly one side confirmed             -> the confirmed one wins; the other goes to alternatives (no re-ask)
//     exactly one side is an inferred guess  -> the non-guess wins; the guess goes to alternatives
//     otherwise                              -> CONFLICT: higher confidence is shown, confirmed=false, both values
//                                               become candidates of an OpenQuestion (id "conflict.<path>")

import type { BusinessSpec, OpenQuestion } from "@napkin/schema";
import { impactScore, isMoneyRelevant, moneyImpact } from "../questions/impact";
import { showValue, valueKey } from "../spec/coerce";
import { isMissing, slugify, type AnyFact } from "../spec/paths";

export type Alternatives = Record<string, AnyFact[]>;
const PROV_RANK = { owner_said: 0, paper: 1, inferred: 2 } as const;
const canon = (f: AnyFact) => JSON.stringify(f);

/** Total order: most trustworthy first; ties broken by canonical JSON so the result never depends on argument order. */
function better(a: AnyFact, b: AnyFact): number {
  return (
    Number(b.confirmed) - Number(a.confirmed) ||
    b.confidence - a.confidence ||
    PROV_RANK[a.provenance] - PROV_RANK[b.provenance] ||
    (canon(a) < canon(b) ? -1 : canon(a) > canon(b) ? 1 : 0)
  );
}

export interface FieldMerge {
  fact: AnyFact;
  alternatives: AnyFact[];
  conflict?: { candidates: string[] };
}

export function mergeFact(path: string, a: AnyFact, b: AnyFact): FieldMerge {
  const [x, y] = [a, b].sort(better) as [AnyFact, AnyFact];
  if (isMissing(a) || isMissing(b)) {
    if (isMissing(a) && isMissing(b)) return { fact: x, alternatives: [] };
    return { fact: isMissing(a) ? b : a, alternatives: [] };
  }
  if (valueKey(path, a.value) === valueKey(path, b.value)) {
    return { fact: { ...x, confidence: Math.max(a.confidence, b.confidence), confirmed: a.confirmed || b.confirmed }, alternatives: [] };
  }
  if (a.confirmed !== b.confirmed) return { fact: a.confirmed ? a : b, alternatives: [a.confirmed ? b : a] };
  if ((a.provenance === "inferred") !== (b.provenance === "inferred")) {
    return { fact: a.provenance === "inferred" ? b : a, alternatives: [a.provenance === "inferred" ? a : b] };
  }
  const candidates = [...new Set([showValue(path, a.value), showValue(path, b.value)])].sort();
  return { fact: { ...x, confirmed: false }, alternatives: [y], conflict: { candidates } };
}

export interface MergeResult {
  spec: BusinessSpec;
  alternatives: Alternatives;
}

type Ent = { id: string; name: AnyFact };
const byId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]));
const sortedIds = (...maps: Map<string, unknown>[]) => [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();

export function mergeSpecs(a: BusinessSpec, b: BusinessSpec): MergeResult {
  const alts: Alternatives = {};
  const conflicts: OpenQuestion[] = [];
  const f = (path: string, x: AnyFact, y: AnyFact): AnyFact => {
    const r = mergeFact(path, x, y);
    if (r.alternatives.length) alts[path] = r.alternatives;
    if (r.conflict) {
      conflicts.push({
        id: `conflict.${path}`,
        fieldPath: path,
        question: `Two sources disagree about ${path}.`,
        impactScore: moneyImpact(path),
        moneyRelevant: isMoneyRelevant(path),
        status: "open",
        candidates: r.conflict.candidates,
      });
    }
    return r.fact;
  };
  /** merge an optional fact */
  const fo = (path: string, x?: AnyFact, y?: AnyFact) => (x && y ? f(path, x, y) : (x ?? y));
  const rec = <T extends Record<string, AnyFact>>(prefix: string, x: T, y: T): T =>
    Object.fromEntries(Object.keys(x).sort().map((k) => [k, f(`${prefix}.${k}`, x[k]!, y[k]!)])) as T;

  const offA = byId(a.offerings);
  const offB = byId(b.offerings);
  const offerings = sortedIds(offA, offB).map((id) => {
    const x = offA.get(id);
    const y = offB.get(id);
    const only = x ?? y!;
    const base = `offerings.${id}`;
    if (!x || !y) return canonOffering(structuredClone(only));
    const merged = (items: "variants" | "addOns") => {
      const mx = byId(x[items] as (Ent & Record<string, unknown>)[]);
      const my = byId(y[items] as (Ent & Record<string, unknown>)[]);
      return sortedIds(mx, my).map((vid) => {
        const p = mx.get(vid);
        const q = my.get(vid);
        if (!p || !q) return structuredClone((p ?? q)!);
        const vb = `${base}.${items}.${vid}`;
        const out: Record<string, unknown> = { id: vid, name: f(`${vb}.name`, p.name as AnyFact, q.name as AnyFact), price: f(`${vb}.price`, p.price as AnyFact, q.price as AnyFact), cost: f(`${vb}.cost`, p.cost as AnyFact, q.cost as AnyFact) };
        const su = fo(`${vb}.stockUnits`, p.stockUnits as AnyFact | undefined, q.stockUnits as AnyFact | undefined);
        if (su) out.stockUnits = su;
        return out;
      });
    };
    const out: Record<string, unknown> = {
      id,
      name: f(`${base}.name`, x.name, y.name),
      variants: merged("variants"),
      addOns: merged("addOns"),
      stockTracked: f(`${base}.stockTracked`, x.stockTracked, y.stockTracked),
    };
    const d = fo(`${base}.description`, x.description, y.description);
    if (d) out.description = d;
    const s = fo(`${base}.initialStock`, x.initialStock, y.initialStock);
    if (s) out.initialStock = s;
    return out;
  });

  const supA = new Map(a.operations.suppliers.map((s) => [slugify(String(s.name.value)), s]));
  const supB = new Map(b.operations.suppliers.map((s) => [slugify(String(s.name.value)), s]));
  const suppliers = sortedIds(supA, supB).map((sid) => {
    const p = supA.get(sid);
    const q = supB.get(sid);
    if (!p || !q) return structuredClone((p ?? q)!);
    return { name: f(`operations.suppliers.${sid}.name`, p.name, q.name), items: f(`operations.suppliers.${sid}.items`, p.items, q.items) };
  });

  const exMap = new Map([...a.examples, ...b.examples].map((e) => [JSON.stringify(e), e]));
  const spec = {
    business: rec("business", a.business, b.business),
    pattern: "item_seller" as const,
    offerings,
    policies: rec("policies", a.policies, b.policies),
    operations: {
      fulfillment: f("operations.fulfillment", a.operations.fulfillment, b.operations.fulfillment),
      pickupLocation: f("operations.pickupLocation", a.operations.pickupLocation, b.operations.pickupLocation),
      suppliers,
    },
    examples: [...exMap.keys()].sort().map((k) => exMap.get(k)!),
    openQuestions: dedupeQuestions([...a.openQuestions, ...b.openQuestions, ...conflicts]),
  } as unknown as BusinessSpec;
  for (const k of Object.keys(alts)) alts[k] = [...new Map(alts[k]!.map((x) => [canon(x), x])).values()].sort((p, q) => (canon(p) < canon(q) ? -1 : 1));
  return { spec, alternatives: alts };
}

function dedupeQuestions(qs: OpenQuestion[]): OpenQuestion[] {
  const m = new Map<string, OpenQuestion>();
  for (const q of qs) {
    const prev = m.get(q.id);
    if (!prev || JSON.stringify(q) < JSON.stringify(prev)) m.set(q.id, q);
  }
  return [...m.values()].sort((p, q) => (p.id < q.id ? -1 : 1));
}

function canonOffering<T extends { variants: { id: string }[]; addOns: { id: string }[] }>(o: T): T {
  const byIdAsc = (p: { id: string }, q: { id: string }) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
  o.variants.sort(byIdAsc);
  o.addOns.sort(byIdAsc);
  return o;
}

export function mergeAlternatives(a: Alternatives, b: Alternatives): Alternatives {
  const out: Alternatives = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const all = [...(a[k] ?? []), ...(b[k] ?? [])];
    out[k] = [...new Map(all.map((x) => [canon(x), x])).values()].sort((p, q) => (canon(p) < canon(q) ? -1 : 1));
  }
  return out;
}
