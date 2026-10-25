// Fonts a generated storefront can pick (StorefrontDesign.fonts, plus the older config theme font).
// next/font needs every font declared statically, so this is a registry. Only the default pair (Fraunces +
// Inter) is preloaded; the others download only when a store actually uses them.
import {
  Archivo,
  Bricolage_Grotesque,
  DM_Sans,
  DM_Serif_Display,
  Fraunces,
  Instrument_Serif,
  Inter,
  Lora,
  Manrope,
  Nunito,
  Outfit,
  Playfair_Display,
  Space_Grotesk,
} from "next/font/google";

const fraunces = Fraunces({ subsets: ["latin"], axes: ["SOFT", "WONK", "opsz"], style: ["normal", "italic"], variable: "--font-fraunces", display: "swap" });
const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], variable: "--font-playfair", display: "swap", preload: false });
const instrument = Instrument_Serif({ subsets: ["latin"], weight: "400", style: ["normal", "italic"], variable: "--font-instrument", display: "swap", preload: false });
const dmSerif = DM_Serif_Display({ subsets: ["latin"], weight: "400", variable: "--font-dm-serif", display: "swap", preload: false });
const archivo = Archivo({ subsets: ["latin"], axes: ["wdth"], variable: "--font-archivo", display: "swap", preload: false });
const bricolage = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-bricolage", display: "swap", preload: false });
const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-space-grotesk", display: "swap", preload: false });
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap", preload: false });
const manrope = Manrope({ subsets: ["latin"], variable: "--font-manrope", display: "swap", preload: false });
const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap", preload: false });
const lora = Lora({ subsets: ["latin"], variable: "--font-lora", display: "swap", preload: false });
const nunito = Nunito({ subsets: ["latin"], variable: "--font-nunito", display: "swap", preload: false });

export const fontVariables = [fraunces, inter, playfair, instrument, dmSerif, archivo, bricolage, spaceGrotesk, outfit, manrope, dmSans, lora, nunito]
  .map((f) => f.variable)
  .join(" ");

const FAMILY: Record<string, string> = {
  fraunces: "var(--font-fraunces)",
  inter: "var(--font-inter)",
  "playfair display": "var(--font-playfair)",
  "instrument serif": "var(--font-instrument)",
  "dm serif display": "var(--font-dm-serif)",
  archivo: "var(--font-archivo)",
  "bricolage grotesque": "var(--font-bricolage)",
  "space grotesk": "var(--font-space-grotesk)",
  outfit: "var(--font-outfit)",
  manrope: "var(--font-manrope)",
  "dm sans": "var(--font-dm-sans)",
  lora: "var(--font-lora)",
  nunito: "var(--font-nunito)",
};

const SERIF = new Set(["fraunces", "playfair display", "instrument serif", "dm serif display", "lora"]);

/** CSS font-family stack for a font name. Unknown names fall back to Inter. */
export function fontStack(name: string): string {
  const key = name.trim().toLowerCase();
  const fam = FAMILY[key] ?? FAMILY.inter;
  return SERIF.has(key) ? `${fam}, ui-serif, Georgia, serif` : `${fam}, ui-sans-serif, system-ui, sans-serif`;
}
