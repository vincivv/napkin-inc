// StorefrontDesign: how a business's customer-facing store LOOKS. It is not part of the Configuration
// (no money, no policy), so it lives beside it: the brain generates and stores it, the store app renders
// it. Changing the look never needs a new configuration version, and a recompile keeps the approved look.
//
// The LLM may PROPOSE everything here except images' licensing data, which comes from the image source.
// The brain validates every field deterministically (hex colors, contrast, font allow-lists, copy rules)
// before saving; the store re-validates with this schema on read and falls back to a default design.

import { z } from "zod";

export const DESIGN_STYLES = ["editorial", "bold"] as const;
/** editorial: soft neutrals, pill buttons, warm display type (Warby Parker-like).
 *  bold: high-contrast black/white, square buttons, uppercase heavy type (ASOS-like). */
export const DesignStyle = z.enum(DESIGN_STYLES);

export const DISPLAY_FONTS = [
  "Fraunces",
  "Playfair Display",
  "Instrument Serif",
  "DM Serif Display",
  "Archivo",
  "Bricolage Grotesque",
  "Space Grotesk",
  "Outfit",
  "Inter",
] as const;
export const BODY_FONTS = ["Inter", "DM Sans", "Manrope", "Outfit"] as const;

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "#rrggbb");

export const DesignPalette = z.object({
  /** page background */
  background: Hex,
  /** product-image tiles, cards, inputs */
  surface: Hex,
  /** body text; contrast >= 4.5 on background and surface */
  text: Hex,
  /** secondary text; contrast >= 3 on background */
  muted: Hex,
  /** buttons, links, announcement bar; contrast >= 3 on background */
  primary: Hex,
  /** text on primary; contrast >= 4.5 on primary */
  onPrimary: Hex,
  /** highlight word, badges */
  accent: Hex,
});
export type DesignPalette = z.infer<typeof DesignPalette>;

export const DesignImage = z.object({
  url: z.string().url(),
  alt: z.string().max(200),
  /** "Photo: <title> by <creator>" or "Uploaded by the owner" */
  credit: z.string().max(200),
  creditUrl: z.string().url().nullable(),
  /** e.g. "CC BY 2.0"; "" for an owner upload */
  license: z.string().max(40),
  licenseUrl: z.string().url().nullable(),
  source: z.enum(["openverse", "upload"]),
});
export type DesignImage = z.infer<typeof DesignImage>;

export const StorefrontDesign = z.object({
  version: z.literal(1),
  businessId: z.string(),
  style: DesignStyle,
  corners: z.enum(["round", "soft", "square"]),
  palette: DesignPalette,
  fonts: z.object({ display: z.enum(DISPLAY_FONTS), body: z.enum(BODY_FONTS) }),
  /** one line in the bar above the header; "" hides the bar */
  announcement: z.string().max(70),
  hero: z.object({
    eyebrow: z.string().max(32),
    title: z.string().min(1).max(48),
    subtitle: z.string().max(120),
    cta: z.string().min(1).max(20),
    layout: z.enum(["fullbleed", "split"]),
    image: DesignImage.nullable(),
  }),
  /** product grid heading: "<title> <accent>", accent rendered in the accent color */
  collection: z.object({ title: z.string().min(1).max(24), accent: z.string().max(24) }),
  /** the visit/pickup banner; its body is built from the business's confirmed facts, never generated */
  banner: z.object({ title: z.string().min(1).max(40), image: DesignImage.nullable() }),
  /** productId -> photo */
  productImages: z.record(z.string(), DesignImage),
  generator: z.string().max(80),
  generatedAt: z.string(),
  /** proposals that failed validation and were replaced by defaults (shown to the owner) */
  notes: z.array(z.string()).max(40),
});
export type StorefrontDesign = z.infer<typeof StorefrontDesign>;
