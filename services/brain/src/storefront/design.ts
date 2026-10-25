// StorefrontDesign (packages/schema/src/storefront-design.ts): how the customer-facing store LOOKS.
// This file is the deterministic half: the default design (good-looking with no LLM and no images) and the
// field-by-field validation every proposal and every owner edit goes through. Nothing here touches money;
// copy rules forbid prices, numbers and claims the business never stated.

import { BODY_FONTS, DESIGN_STYLES, DISPLAY_FONTS, StorefrontDesign, type Configuration, type DesignPalette } from "@napkin/schema";
import { z } from "zod";
import { contrast, copyProblem } from "../compiler/storefront";
import { DEFAULT_THEME } from "../compiler/templates/item_seller";

export type DesignStyleName = (typeof DESIGN_STYLES)[number];
export const CORNERS = ["round", "soft", "square"] as const;
export const HERO_LAYOUTS = ["fullbleed", "split"] as const;

/** The business facts a design is built from (no prices, costs or stock). */
export interface DesignInput {
  businessId: string;
  businessName: string;
  oneLiner: string;
  community: string;
  /** config.storefront.tagline */
  tagline: string;
  fulfillment: "pickup" | "delivery";
  theme: { primary: string; accent: string; background: string; text: string };
  products: { id: string; name: string; kind: string }[];
}

export function designInputFromConfig(c: Configuration): DesignInput {
  const products = (c.catalogs.find((k) => k.id === "products")?.entries ?? []).map((e) => ({
    id: e.id,
    name: typeof e.data["name"] === "string" && e.data["name"] ? e.data["name"] : e.id,
    kind: typeof e.data["kind"] === "string" ? e.data["kind"] : "",
  }));
  const t = c.storefront.theme;
  return {
    businessId: c.businessId,
    businessName: c.business.name,
    oneLiner: c.business.oneLiner,
    community: c.business.community ?? "",
    tagline: c.storefront.tagline,
    fulfillment: c.policies.fulfillment,
    theme: { primary: t.primary, accent: t.accent, background: t.background, text: t.text },
    products,
  };
}

// ---------- colors (display math, not money) ----------

const HEX = /^#[0-9a-fA-F]{6}$/;
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
/** a + (b - a) * t per channel */
export function mix(a: string, b: string, t: number): string {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
}
/** Moves `fg` toward `toward` in 5% steps until it reaches `min` contrast on `bg`. */
function ensureContrast(fg: string, bg: string, min: number, toward = "#000000"): string {
  for (let i = 0; i <= 20; i++) {
    const c = mix(fg, toward, i / 20);
    if (contrast(c, bg) >= min) return c;
  }
  return toward;
}
const isLight = (hex: string) => contrast(hex, "#000000") > contrast(hex, "#ffffff");

/** Every contrast rule a palette must meet; empty means it is usable. */
export function paletteProblems(p: Partial<Record<keyof DesignPalette, unknown>>): string[] {
  const keys = ["background", "surface", "text", "muted", "primary", "onPrimary", "accent"] as const;
  const bad = keys.filter((k) => typeof p[k] !== "string" || !HEX.test(p[k] as string));
  if (bad.length) return [`palette: ${bad.join(", ")} not #rrggbb`];
  const c = p as DesignPalette;
  const rules: [string, string, string, number][] = [
    ["text", c.text, c.background, 4.5],
    ["text on surface", c.text, c.surface, 4.5],
    ["onPrimary", c.onPrimary, c.primary, 4.5],
    ["primary", c.primary, c.background, 3],
    ["muted", c.muted, c.background, 3],
  ];
  return rules.filter(([, a, b, min]) => contrast(a, b) < min).map(([name, a, b, min]) => `palette: ${name} contrast ${contrast(a, b).toFixed(2)} < ${min}`);
}

/** The palette for a style, derived from the configuration's theme (bad theme colors fall back to the template's). */
export function defaultPalette(style: DesignStyleName, theme: DesignInput["theme"]): DesignPalette {
  const t = Object.fromEntries((["primary", "accent", "background", "text"] as const).map((k) => [k, HEX.test(theme[k]) ? theme[k].toLowerCase() : DEFAULT_THEME[k]])) as DesignInput["theme"];
  if (style === "bold") {
    const background = "#ffffff";
    return { background, surface: "#f2f2f2", text: "#111111", muted: "#5c5c5c", primary: "#111111", onPrimary: "#ffffff", accent: ensureContrast(t.accent, background, 3) };
  }
  // editorial: a warm off-white page, a soft warm-neutral tile surface, the theme's own primary for buttons
  const background = isLight(t.background) ? mix(t.background, "#f8f5f0", 0.5) : "#f8f5f0";
  const surface = mix(background, "#d8cebf", 0.35);
  const text = contrast(t.text, background) >= 7 && contrast(t.text, surface) >= 7 ? t.text : ensureContrast(t.text, surface, 7, "#1a1714");
  let primary = ensureContrast(t.primary, background, 3);
  for (let i = 1; i <= 20 && contrast("#ffffff", primary) < 4.5; i++) primary = mix(primary, "#000000", 0.05 * i);
  const muted = ensureContrast(mix(text, background, 0.45), background, 4.5, text);
  return { background, surface, text, muted, primary, onPrimary: "#ffffff", accent: ensureContrast(t.accent, background, 3) };
}

// ---------- default design ----------

const cut = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, " ");
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  return `${head.slice(0, head.lastIndexOf(" ") > max / 2 ? head.lastIndexOf(" ") : head.length).trim()}…`;
};

/** Deterministic, schema-valid design from the business facts alone. `style` defaults to editorial. */
export function defaultDesign(input: DesignInput, style: DesignStyleName = "editorial", now: () => Date = () => new Date()): StorefrontDesign {
  const pickup = input.fulfillment === "pickup";
  const bold = style === "bold";
  return StorefrontDesign.parse({
    version: 1,
    businessId: input.businessId,
    style,
    corners: bold ? "square" : "round",
    palette: defaultPalette(style, input.theme),
    fonts: bold ? { display: "Archivo", body: "Inter" } : { display: "Fraunces", body: "Inter" },
    announcement: pickup ? "Order ahead online · Pick up when it's ready" : "Order online · Delivered to your door",
    hero: {
      eyebrow: pickup ? "Order ahead · Pick up" : "Order online",
      title: cut(input.businessName, 48) || "Our shop",
      subtitle: cut(input.tagline || input.oneLiner, 120),
      cta: "Shop now",
      layout: "split",
      image: null,
    },
    collection: { title: "Shop the", accent: "menu" },
    banner: { title: pickup ? "Plan your pickup" : "Visit us", image: null },
    productImages: {},
    generator: "default (deterministic)",
    generatedAt: now().toISOString(),
    notes: [],
  });
}

// ---------- copy rules ----------

/**
 * Facts the business never gave us. A proposal may not state them (the LLM inventing "organic",
 * "since 1998" or "limited stock" is a false claim on a real storefront) unless the business's own words say so.
 */
const CLAIMS =
  /\b(organic|vegan|vegetarian|plant[- ]based|gluten[- ]free|dairy[- ]free|nut[- ]free|sugar[- ]free|keto|non[- ]gmo|all[- ]natural|since|established|est\.|family[- ](?:owned|run)|locally[- ](?:sourced|grown|made)|award[- ]winning|best in town|the best|world[- ]famous|famous|number one|#1|handmade|hand[- ]made|limited|selling fast|sold out|last chance|before (?:it's|they're|they are) gone)/gi;

export interface CopyContext {
  /** exact strings the business gave (name, tagline, one-liner): allowed as-is, length still applies */
  given: string[];
  /** lowercased business facts; a claim word that appears here was stated by the business */
  facts: string;
}

export function copyContext(input: DesignInput): CopyContext {
  const given = [input.businessName, input.tagline, input.oneLiner].map((s) => s.trim()).filter(Boolean);
  return { given, facts: [...given, input.community, ...input.products.map((p) => p.name)].join(" \n ").toLowerCase() };
}

/** Why a piece of storefront copy is refused, or undefined when it is fine. */
/** `ownerSaid`: the owner typed it. The owner is the source of facts about their own business, so claim words are theirs to make; money words still are not (prices live in the books). */
export function designCopyProblem(value: string, max: number, ctx: CopyContext, opts: { allowEmpty?: boolean; ownerSaid?: boolean } = {}): string | undefined {
  const t = value.trim();
  if (opts.allowEmpty && t === "") return undefined;
  if (ctx.given.includes(t)) return t.length > max ? `longer than ${max} characters` : undefined;
  const p = copyProblem(t, max);
  if (p) return p;
  if (!opts.ownerSaid) for (const m of t.matchAll(CLAIMS)) if (!ctx.facts.includes(m[0].toLowerCase())) return `states a fact the business did not give ("${m[0]}")`;
  return undefined;
}

/** Copy fields of a design with their limits (from the schema). */
const COPY_FIELDS = [
  { path: "announcement", max: 70, allowEmpty: true },
  { path: "hero.eyebrow", max: 32, allowEmpty: true },
  { path: "hero.title", max: 48, allowEmpty: false },
  { path: "hero.subtitle", max: 120, allowEmpty: true },
  { path: "hero.cta", max: 20, allowEmpty: false },
  { path: "collection.title", max: 24, allowEmpty: false },
  { path: "collection.accent", max: 24, allowEmpty: true },
  { path: "banner.title", max: 40, allowEmpty: false },
] as const;

// ---------- proposals (lenient: a bad field falls back to the default for that field, with a note) ----------

const s = z.string().optional().catch(undefined);
/** What the LLM may propose. Every field is optional and a wrong type just drops that field. */
export const DesignProposal = z.object({
  style: s,
  corners: s,
  palette: z.object({ background: s, surface: s, text: s, muted: s, primary: s, onPrimary: s, accent: s }).optional().catch(undefined),
  fonts: z.object({ display: s, body: s }).optional().catch(undefined),
  announcement: s,
  hero: z.object({ eyebrow: s, title: s, subtitle: s, cta: s, layout: s }).optional().catch(undefined),
  collection: z.object({ title: s, accent: s }).optional().catch(undefined),
  banner: z.object({ title: s }).optional().catch(undefined),
  imageQueries: z
    .object({
      hero: s,
      banner: s,
      products: z.array(z.object({ productId: s, query: s }).catch({})).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});
export type DesignProposal = z.infer<typeof DesignProposal>;

function getPath(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
}
function setPath(o: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop()!;
  const parent = keys.reduce<Record<string, unknown>>((v, k) => v[k] as Record<string, unknown>, o);
  parent[last] = value;
}

/**
 * Applies a proposal onto the default design for its style, field by field. `forceStyle` is the owner's
 * choice (regenerate {style}); it wins over the proposal. Returns a schema-valid design and the notes.
 */
export function acceptDesignProposal(p: DesignProposal | undefined, input: DesignInput, opts: { forceStyle?: DesignStyleName; generator: string; now?: () => Date }): StorefrontDesign {
  const notes: string[] = [];
  let style: DesignStyleName = opts.forceStyle ?? "editorial";
  if (!opts.forceStyle && p?.style !== undefined) {
    if ((DESIGN_STYLES as readonly string[]).includes(p.style)) style = p.style as DesignStyleName;
    else notes.push(`style: "${p.style}" is not editorial or bold`);
  }
  const base = defaultDesign(input, style, opts.now);
  const d = structuredClone(base) as StorefrontDesign & Record<string, unknown>;
  if (!p) return { ...d, generator: opts.generator };

  if (p.corners !== undefined) {
    if ((CORNERS as readonly string[]).includes(p.corners)) d.corners = p.corners as StorefrontDesign["corners"];
    else notes.push(`corners: "${p.corners}" is not round, soft or square`);
  }
  if (p.palette) {
    const cand = Object.fromEntries(Object.entries(p.palette).map(([k, v]) => [k, typeof v === "string" ? v.trim().toLowerCase() : v]));
    const problems = paletteProblems(cand);
    if (problems.length) notes.push(`${problems.join("; ")}; the default palette is used`);
    else d.palette = cand as DesignPalette;
  }
  if (p.fonts?.display !== undefined) {
    if ((DISPLAY_FONTS as readonly string[]).includes(p.fonts.display)) d.fonts.display = p.fonts.display as StorefrontDesign["fonts"]["display"];
    else notes.push(`fonts.display: "${p.fonts.display}" is not in the allowed list`);
  }
  if (p.fonts?.body !== undefined) {
    if ((BODY_FONTS as readonly string[]).includes(p.fonts.body)) d.fonts.body = p.fonts.body as StorefrontDesign["fonts"]["body"];
    else notes.push(`fonts.body: "${p.fonts.body}" is not in the allowed list`);
  }
  if (p.hero?.layout !== undefined) {
    if ((HERO_LAYOUTS as readonly string[]).includes(p.hero.layout)) d.hero.layout = p.hero.layout as StorefrontDesign["hero"]["layout"];
    else notes.push(`hero.layout: "${p.hero.layout}" is not fullbleed or split`);
  }
  const ctx = copyContext(input);
  for (const f of COPY_FIELDS) {
    const v = getPath(p, f.path);
    if (typeof v !== "string") continue;
    const bad = designCopyProblem(v, f.max, ctx, { allowEmpty: f.allowEmpty });
    if (bad) notes.push(`${f.path}: ${bad}; kept "${getPath(base, f.path) as string}"`);
    else setPath(d, f.path, v.trim());
  }
  d.notes = notes.slice(0, 40);
  d.generator = opts.generator;
  const ok = StorefrontDesign.safeParse(d);
  return ok.success ? ok.data : { ...base, generator: opts.generator, notes: [...notes, `proposal did not pass the schema; the default design is used`].slice(0, 40) };
}

// ---------- image queries ----------

/** Queries for places and signage find other businesses' names; queries describe the product or a mood instead. */
const PLACE_QUERY = /\b(storefront|store|shop|shops|window|sign|signs|signage|logo|brand|menu|label|cafe|restaurant|bakery|boutique|people|person|model)\b/i;
/** 2-5 plain words (letters, spaces, hyphens), at most 60 characters, about the product rather than a place. */
export function imageQueryProblem(q: string): string | undefined {
  const t = q.trim();
  if (t.length > 60) return "longer than 60 characters";
  if (!/^[A-Za-z][A-Za-z' -]*$/.test(t)) return "not plain words";
  const words = t.split(/\s+/).length;
  if (words < 2 || words > 5) return "needs 2-5 words";
  if (PLACE_QUERY.test(t)) return "asks for a place, sign or brand (photos of another business's name are not allowed)";
  return undefined;
}
/** A searchable query from a product name ("Box of 6" -> "box of"), for when no query was proposed. */
export function fallbackQuery(name: string): string {
  return name.replace(/[^A-Za-z' -]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ").toLowerCase();
}

export interface ImageSlot {
  /** "hero" | "banner" | "product:<id>" */
  key: string;
  query: string;
  aspect: "wide" | "any";
  /** what the photo should show, for the vision pick */
  topic: string;
  /** plain product-name query, tried last when the proposed query finds nothing usable */
  fallback?: string;
}

/** Words that name a quantity or package rather than the product itself. */
const PACK_WORDS = new Set(["box", "boxes", "pack", "packs", "set", "sets", "bundle", "bundles", "dozen", "half", "pair", "pairs", "bag", "bags", "the", "and", "for", "with", "single", "double", "triple", "small", "medium", "large", "one", "two", "three", "four", "five", "six", "twelve"]);

/** The image searches for a design: the proposal's queries when valid, else queries from product names. */
export function imageSlots(p: DesignProposal | undefined, input: DesignInput, notes: string[]): ImageSlot[] {
  const q = p?.imageQueries;
  const pick = (proposed: string | undefined, fallback: string, label: string) => {
    if (proposed !== undefined) {
      const bad = imageQueryProblem(proposed);
      if (!bad) return proposed.trim().toLowerCase();
      notes.push(`image query for ${label}: ${bad}`);
    }
    return fallback;
  };
  const first = input.products[0]?.name ?? input.businessName;
  const slots: ImageSlot[] = [
    { key: "hero", query: pick(q?.hero, fallbackQuery(first), "hero"), aspect: "wide", topic: `a wide hero photo for ${input.businessName} (${input.oneLiner})`, fallback: fallbackQuery(first) },
    { key: "banner", query: pick(q?.banner, `${fallbackQuery(first)} on table`.trim(), "banner"), aspect: "wide", topic: `a wide banner photo for ${input.businessName}'s ${input.fulfillment === "pickup" ? "pickup" : "visit"} section`, fallback: fallbackQuery(first) },
  ];
  for (const prod of input.products) {
    const proposed = q?.products?.find((x) => x.productId === prod.id)?.query;
    // "Box of 6" names a pack, not a thing: search for the shop's main product instead
    const own = fallbackQuery(prod.name);
    const named = own.split(" ").some((w) => w.length >= 3 && !PACK_WORDS.has(w)) ? own : fallbackQuery(first);
    slots.push({
      key: `product:${prod.id}`,
      query: pick(proposed, named, `product ${prod.id}`),
      aspect: "any",
      topic: `a product photo of "${prod.name}" sold by ${input.businessName} (${input.oneLiner})`,
      fallback: named,
    });
  }
  return slots.filter((x) => x.query.length > 0);
}

// ---------- owner edits (strict: any bad field rejects the whole edit) ----------

const opt = z.string().optional();
export const DesignPatch = z
  .object({
    style: opt,
    corners: opt,
    fonts: z.object({ display: opt, body: opt }).strict().optional(),
    palette: z.object({ background: opt, surface: opt, text: opt, muted: opt, primary: opt, onPrimary: opt, accent: opt }).strict().optional(),
    announcement: opt,
    hero: z.object({ eyebrow: opt, title: opt, subtitle: opt, cta: opt, layout: opt }).strict().optional(),
    collection: z.object({ title: opt, accent: opt }).strict().optional(),
    banner: z.object({ title: opt }).strict().optional(),
  })
  .strict();
export type DesignPatch = z.infer<typeof DesignPatch>;

/** Applies an owner edit to a design. Returns the new design, or the reasons it is refused (nothing is defaulted). */
export function applyDesignPatch(current: StorefrontDesign, patch: DesignPatch, ctx: CopyContext): { design: StorefrontDesign; reasons: [] } | { design?: undefined; reasons: string[] } {
  const reasons: string[] = [];
  const d = structuredClone(current) as StorefrontDesign & Record<string, unknown>;
  const pickEnum = <T extends string>(v: string | undefined, allowed: readonly T[], label: string, set: (x: T) => void) => {
    if (v === undefined) return;
    if ((allowed as readonly string[]).includes(v)) set(v as T);
    else reasons.push(`${label}: "${v}" is not one of ${allowed.join(", ")}`);
  };
  pickEnum(patch.style, DESIGN_STYLES, "style", (x) => (d.style = x));
  pickEnum(patch.corners, CORNERS, "corners", (x) => (d.corners = x));
  pickEnum(patch.fonts?.display, DISPLAY_FONTS, "fonts.display", (x) => (d.fonts.display = x));
  pickEnum(patch.fonts?.body, BODY_FONTS, "fonts.body", (x) => (d.fonts.body = x));
  pickEnum(patch.hero?.layout, HERO_LAYOUTS, "hero.layout", (x) => (d.hero.layout = x));
  if (patch.palette) {
    const merged = { ...d.palette, ...Object.fromEntries(Object.entries(patch.palette).filter(([, v]) => v !== undefined).map(([k, v]) => [k, v!.trim().toLowerCase()])) };
    const problems = paletteProblems(merged);
    if (problems.length) reasons.push(...problems);
    else d.palette = merged as DesignPalette;
  }
  for (const f of COPY_FIELDS) {
    const v = getPath(patch, f.path);
    if (typeof v !== "string") continue;
    const bad = designCopyProblem(v, f.max, ctx, { allowEmpty: f.allowEmpty, ownerSaid: true });
    if (bad) reasons.push(`${f.path}: ${bad}`);
    else setPath(d, f.path, v.trim());
  }
  if (reasons.length) return { reasons };
  const ok = StorefrontDesign.safeParse(d);
  if (!ok.success) return { reasons: ok.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  return { design: ok.data, reasons: [] };
}
