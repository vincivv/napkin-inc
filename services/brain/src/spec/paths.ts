// Path-addressed access to the Facts inside a BusinessSpec. Paths use the entities' own ids, not array
// indexes, so they stay stable when offerings are re-ordered by a merge:
//   business.name | offerings.<id>.variants.<id>.price | policies.maxDiscountPct | operations.suppliers.<slug>.items

import type { BusinessSpec, Fact } from "@napkin/schema";

export type AnyFact = Fact<unknown>;

export function slugify(s: string): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 60) || "item";
}

export function isFact(x: unknown): x is AnyFact {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  return "value" in o && "provenance" in o && "confidence" in o && "source" in o && "confirmed" in o;
}

/** A required field the sources never mentioned: a typed placeholder, NOT a claim. Always blocks money. */
export const MISSING_REF = "missing";
export function missingFact<T>(value: T): Fact<T> {
  return { value, provenance: "inferred", confidence: 0, source: { kind: "chat", ref: MISSING_REF, quote: "(not provided)" }, confirmed: false };
}
export function isMissing(f: AnyFact): boolean {
  return f.provenance === "inferred" && f.confidence === 0 && f.source.ref === MISSING_REF;
}

type Json = Record<string, unknown>;

/** Resolve one path segment inside an array of entities (by id, else by slug of name). */
function elementKey(el: unknown): string | undefined {
  if (typeof el !== "object" || el === null) return undefined;
  const o = el as Json;
  if (typeof o.id === "string") return o.id;
  const name = o.name;
  if (isFact(name) && typeof name.value === "string") return slugify(name.value);
  return undefined;
}

export function listFacts(spec: BusinessSpec): { path: string; fact: AnyFact }[] {
  const out: { path: string; fact: AnyFact }[] = [];
  const walk = (node: unknown, path: string) => {
    if (isFact(node)) {
      out.push({ path, fact: node });
      return;
    }
    if (Array.isArray(node)) {
      for (const el of node) {
        const key = elementKey(el);
        if (key !== undefined) walk(el, `${path}.${key}`);
      }
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [k, v] of Object.entries(node as Json)) {
        if (k === "openQuestions" || k === "examples" || k === "pattern" || k === "id") continue;
        walk(v, path ? `${path}.${k}` : k);
      }
    }
  };
  walk(spec, "");
  return out;
}

function resolve(spec: unknown, path: string): { parent: Json; key: string } | undefined {
  const segs = path.split(".");
  let node: unknown = spec;
  for (let i = 0; i < segs.length - 1; i++) {
    if (Array.isArray(node)) {
      node = node.find((el) => elementKey(el) === segs[i]);
    } else if (typeof node === "object" && node !== null) {
      node = (node as Json)[segs[i]!];
    } else return undefined;
  }
  const last = segs[segs.length - 1]!;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  return { parent: node as Json, key: last };
}

export function getFact(spec: BusinessSpec, path: string): AnyFact | undefined {
  const r = resolve(spec, path);
  const f = r?.parent[r.key];
  return isFact(f) ? f : undefined;
}

/** Immutable: returns a new spec with the fact at `path` replaced. Throws if the path is not an existing fact. */
export function setFact(spec: BusinessSpec, path: string, fact: AnyFact): BusinessSpec {
  const next = structuredClone(spec);
  const r = resolve(next, path);
  if (!r || !isFact(r.parent[r.key])) throw new Error(`no fact at path ${path}`);
  r.parent[r.key] = fact;
  return next;
}

/** offerings.<id>.variants.<id>.price -> offerings.*.variants.*.price */
export function normalizePath(path: string): string {
  return path
    .replace(/^offerings\.[^.]+/, "offerings.*")
    .replace(/\.variants\.[^.]+/, ".variants.*")
    .replace(/\.addOns\.[^.]+/, ".addOns.*")
    .replace(/^operations\.suppliers\.[^.]+/, "operations.suppliers.*");
}
