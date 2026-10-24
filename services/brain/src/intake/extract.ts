// What the model returns (a flat, forgiving "extraction") and the deterministic assembly of that into a
// BusinessSpec where EVERY field is a Fact. Provenance is decided HERE, not by the model:
//   photo mode : "paper" only when the model quoted the text it read; everything else is "inferred" (conf capped).
//   voice/chat : "owner_said" only when a quote of the owner's words exists; else "inferred".
// Required fields the source never mentioned become typed placeholders (missingFact) that block money
// and turn into questions. Nothing is invented.

import { parseBusinessSpec, type BusinessSpec, type Fact } from "@napkin/schema";
import { z } from "zod";
import { coerceValue, CoerceError } from "../spec/coerce";
import { missingFact, slugify, type AnyFact } from "../spec/paths";

// ---------- model-facing JSON Schema (tool input) ----------
const factSchema = (what: string) => ({
  type: "object",
  description: what,
  properties: {
    value: { type: "string", description: "The value as plain text. Money: digits only like 3.00. Rates as a fraction like 0.20 for 20%. Yes/no as yes or no." },
    confidence: { type: "number", minimum: 0, maximum: 1, description: "How sure you are the value is right." },
    provenance: { type: "string", enum: ["paper", "inferred"], description: "paper = the value is written in the source; inferred = your guess or deduction." },
    quote: { type: "string", description: "The exact words/characters from the source that support this value." },
    region: {
      type: "object",
      description: "Photo only: where on the image the supporting text is, normalized 0..1 from the top-left (x,y = top-left corner, w,h = size). Approximate.",
      properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
      required: ["x", "y", "w", "h"],
    },
  },
  required: ["value", "confidence", "provenance"],
});
const F = factSchema("A fact. Omit the whole field if the source does not say or show it.");

export const EXTRACTION_SCHEMA = {
  type: "object",
  properties: {
    business: {
      type: "object",
      properties: { name: F, oneLiner: F, community: F, location: F, hours: F, timezone: F },
    },
    offerings: {
      type: "array",
      description: "Things the business sells. Each has at least one variant (a sellable size/format with its own price). Add-ons are optional extras (e.g. '+ sea salt $1').",
      items: {
        type: "object",
        properties: {
          name: F,
          description: F,
          stockTracked: F,
          initialStock: F,
          variants: {
            type: "array",
            items: { type: "object", properties: { name: F, price: F, cost: F, stockUnits: F }, required: ["name"] },
          },
          addOns: { type: "array", items: { type: "object", properties: { name: F, price: F, cost: F }, required: ["name"] } },
        },
        required: ["name", "variants"],
      },
    },
    policies: {
      type: "object",
      properties: { taxRate: F, marginFloorPct: F, refundWindowHours: F, refundMethod: F, maxDiscountPct: F, couponsAllowed: F },
    },
    operations: {
      type: "object",
      properties: {
        fulfillment: F,
        pickupLocation: F,
        suppliers: { type: "array", items: { type: "object", properties: { name: F, items: F }, required: ["name"] } },
      },
    },
    notes: { type: "string", description: "Anything unreadable, ambiguous or worth flagging to the owner." },
  },
  required: ["offerings"],
} as const;

// ---------- validation of what came back ----------
const Region = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
const RawFact = z.object({
  value: z.union([z.string(), z.number(), z.boolean()]).transform(String),
  confidence: z.number().transform((n) => Math.min(1, Math.max(0, n))),
  provenance: z.enum(["paper", "inferred", "owner_said"]).optional(),
  quote: z.string().optional(),
  region: Region.optional(),
});
type RawFact = z.infer<typeof RawFact>;
const RF = RawFact.optional();
export const Extraction = z.object({
  business: z.object({ name: RF, oneLiner: RF, community: RF, location: RF, hours: RF, timezone: RF }).partial().optional(),
  offerings: z.array(
    z.object({
      name: RawFact,
      description: RF,
      stockTracked: RF,
      initialStock: RF,
      variants: z.array(z.object({ name: RawFact, price: RF, cost: RF, stockUnits: RF })).default([]),
      addOns: z.array(z.object({ name: RawFact, price: RF, cost: RF })).default([]),
    }),
  ),
  policies: z.object({ taxRate: RF, marginFloorPct: RF, refundWindowHours: RF, refundMethod: RF, maxDiscountPct: RF, couponsAllowed: RF }).partial().optional(),
  operations: z
    .object({ fulfillment: RF, pickupLocation: RF, suppliers: z.array(z.object({ name: RawFact, items: RF })).default([]) })
    .partial()
    .optional(),
  notes: z.string().optional(),
});
export type Extracted = z.infer<typeof Extraction>;

export type Mode = "photo" | "voice" | "chat";
export interface AssembleCtx {
  mode: Mode;
  /** photo file name, or transcript id */
  ref: string;
}

/** Confidence caps. A guess can never look sure of itself. */
export const INFERRED_MAX_CONFIDENCE = 0.4;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function sanitizeRegion(r: z.infer<typeof Region> | undefined) {
  if (!r) return undefined;
  const x = clamp01(r.x);
  const y = clamp01(r.y);
  const w = Math.min(clamp01(r.w), 1 - x);
  const h = Math.min(clamp01(r.h), 1 - y);
  return w > 0 && h > 0 ? { x, y, w, h } : undefined;
}

export function buildFact(path: string, raw: RawFact, ctx: AssembleCtx, rejected: string[]): AnyFact | undefined {
  let value: unknown;
  try {
    value = coerceValue(path, undefined, raw.value);
  } catch (e) {
    if (e instanceof CoerceError) {
      rejected.push(`${path}: ${e.message} (model said "${raw.value}")`);
      return undefined;
    }
    throw e;
  }
  const quote = raw.quote?.trim() || undefined;
  const claimsSource = ctx.mode === "photo" ? raw.provenance === "paper" : raw.provenance !== "inferred";
  const supported = claimsSource && quote !== undefined; // no quote, no source claim
  const provenance: Fact<unknown>["provenance"] = !supported ? "inferred" : ctx.mode === "photo" ? "paper" : "owner_said";
  const confidence =
    provenance === "inferred" ? Math.min(Math.max(raw.confidence, 0.05), INFERRED_MAX_CONFIDENCE) : Math.min(Math.max(raw.confidence, 0.3), 0.99);
  return {
    value,
    provenance,
    confidence,
    source: {
      kind: ctx.mode === "photo" ? "photo" : ctx.mode === "voice" ? "voice" : "chat",
      ref: ctx.ref,
      ...(ctx.mode === "photo" && sanitizeRegion(raw.region) ? { region: sanitizeRegion(raw.region)! } : {}),
      ...(quote ? { quote } : {}),
    },
    confirmed: false,
  };
}

/** Never throws on content problems: unusable fields are listed in `rejected` and left as missing. */
export function assembleSpec(ex: Extracted, ctx: AssembleCtx): { spec: BusinessSpec; rejected: string[] } {
  const rejected: string[] = [];
  const pick = <T,>(path: string, raw: RawFact | undefined, dflt: T): Fact<T> => (raw ? ((buildFact(path, raw, ctx, rejected) as Fact<T> | undefined) ?? missingFact(dflt)) : missingFact(dflt));

  const b = ex.business ?? {};
  const p = ex.policies ?? {};
  const o = ex.operations ?? {};

  const usedOff = new Set<string>();
  const uniq = (used: Set<string>, name: string) => {
    let id = slugify(name);
    for (let n = 2; used.has(id); n++) id = `${slugify(name)}-${n}`;
    used.add(id);
    return id;
  };

  const offerings = ex.offerings.map((off) => {
    const nameFact = buildFact("offerings.x.name", off.name, ctx, rejected);
    if (!nameFact || typeof nameFact.value !== "string" || nameFact.value.trim() === "") {
      rejected.push(`offering without a readable name dropped`);
      return undefined;
    }
    const id = uniq(usedOff, nameFact.value);
    const base = `offerings.${id}`;
    const usedV = new Set<string>();
    const usedA = new Set<string>();
    const variants = off.variants
      .map((v) => {
        const vn = buildFact(`${base}.variants.x.name`, v.name, ctx, rejected);
        if (!vn || String(vn.value).trim() === "") return undefined;
        const vid = uniq(usedV, String(vn.value));
        const vb = `${base}.variants.${vid}`;
        return {
          id: vid,
          name: vn as Fact<string>,
          price: pick(`${vb}.price`, v.price, "0"),
          cost: pick(`${vb}.cost`, v.cost, "0"),
          ...(v.stockUnits ? { stockUnits: pick(`${vb}.stockUnits`, v.stockUnits, "0") } : {}),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
    if (variants.length === 0) {
      // Never invent a size: a placeholder variant keeps the shape valid and asks the owner.
      variants.push({ id: "default", name: missingFact(""), price: missingFact("0"), cost: missingFact("0") });
    }
    const addOns = off.addOns
      .map((a) => {
        const an = buildFact(`${base}.addOns.x.name`, a.name, ctx, rejected);
        if (!an || String(an.value).trim() === "") return undefined;
        const aid = uniq(usedA, String(an.value));
        const ab = `${base}.addOns.${aid}`;
        return { id: aid, name: an as Fact<string>, price: pick(`${ab}.price`, a.price, "0"), cost: pick(`${ab}.cost`, a.cost, "0") };
      })
      .filter((x): x is NonNullable<typeof x> => x !== undefined);
    return {
      id,
      name: nameFact as Fact<string>,
      ...(off.description ? { description: pick(`${base}.description`, off.description, "") } : {}),
      variants,
      addOns,
      stockTracked: pick(`${base}.stockTracked`, off.stockTracked, false),
      ...(off.initialStock ? { initialStock: pick(`${base}.initialStock`, off.initialStock, 0) } : {}),
    };
  }).filter((x): x is NonNullable<typeof x> => x !== undefined);

  if (offerings.length === 0) {
    offerings.push({
      id: "item",
      name: missingFact(""),
      variants: [{ id: "default", name: missingFact(""), price: missingFact("0"), cost: missingFact("0") }],
      addOns: [],
      stockTracked: missingFact(false),
    });
  }

  const usedS = new Set<string>();
  const suppliers = (o.suppliers ?? [])
    .map((s) => {
      const sn = buildFact("operations.suppliers.x.name", s.name, ctx, rejected);
      if (!sn || String(sn.value).trim() === "") return undefined;
      const sid = uniq(usedS, String(sn.value));
      return { name: sn as Fact<string>, items: pick<string[]>(`operations.suppliers.${sid}.items`, s.items, []) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== undefined);

  const draft = {
    business: {
      name: pick("business.name", b.name, ""),
      oneLiner: pick("business.oneLiner", b.oneLiner, ""),
      community: pick("business.community", b.community, ""),
      location: pick("business.location", b.location, ""),
      hours: pick("business.hours", b.hours, ""),
      timezone: pick("business.timezone", b.timezone, ""),
    },
    pattern: "item_seller" as const,
    offerings,
    policies: {
      currency: missingFact("USD" as const),
      taxRate: pick("policies.taxRate", p.taxRate, "0"),
      marginFloorPct: pick("policies.marginFloorPct", p.marginFloorPct, "0"),
      refundWindowHours: pick("policies.refundWindowHours", p.refundWindowHours, "0"),
      refundMethod: pick("policies.refundMethod", p.refundMethod, ""),
      maxDiscountPct: pick("policies.maxDiscountPct", p.maxDiscountPct, "0"),
      couponsAllowed: pick("policies.couponsAllowed", p.couponsAllowed, false),
      paymentMethods: missingFact(["card" as const]),
    },
    operations: {
      fulfillment: pick<"pickup" | "delivery">("operations.fulfillment", o.fulfillment, "pickup"),
      pickupLocation: pick("operations.pickupLocation", o.pickupLocation, ""),
      suppliers,
    },
    examples: [],
    openQuestions: [],
  };
  return { spec: parseBusinessSpec(draft), rejected };
}
