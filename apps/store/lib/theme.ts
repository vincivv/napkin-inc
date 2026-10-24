import type { CSSProperties } from "react";
import type { Theme } from "./model";

const DISPLAY_FONTS: Record<string, string> = {
  fraunces: "var(--font-fraunces)",
  "playfair display": "var(--font-playfair)",
  lora: "var(--font-lora)",
  nunito: "var(--font-nunito)",
  "space grotesk": "var(--font-space-grotesk)",
};

/** CSS font-family for a theme font name (see lib/fonts.ts). Unknown names fall back to the body font. */
export function displayFontFor(name: string): string {
  return DISPLAY_FONTS[name.trim().toLowerCase()] ?? "var(--font-body)";
}

/** CSS custom properties for a store's theme; globals.css derives the rest of the palette from these. */
export function themeStyle(theme: Theme): CSSProperties {
  return {
    "--brand-primary": theme.primary,
    "--brand-accent": theme.accent,
    "--brand-bg": theme.background,
    "--brand-text": theme.text,
    "--brand-font-display": `${displayFontFor(theme.font)}, ui-serif, Georgia, serif`,
  } as CSSProperties;
}
