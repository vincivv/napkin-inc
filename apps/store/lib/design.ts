"use client";
// The store's look comes from a StorefrontDesign that the brain generates and serves
// (GET /storefront/:slug/design). The design never touches money: prices, stock and totals still come
// from the platform. If the brain is unreachable, the store renders a fallback design derived from the
// configuration's theme, so a shop never fails to open because of its look.

import { useEffect, useState, type CSSProperties } from "react";
import { StorefrontDesign, type DesignImage, type DesignPalette } from "@napkin/schema/storefront-design";
import { BRAIN_URL } from "./env";
import { fontStack } from "./fonts";
import type { Product, StoreInfo } from "./model";

export type { StorefrontDesign, DesignImage } from "@napkin/schema/storefront-design";

// ---------- color helpers (display math only) ----------

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
/** a*(1-t) + b*t */
export const mix = (a: string, b: string, t: number) => {
  const [x, y] = [rgb(a), rgb(b)];
  return toHex(x.map((v, i) => v + (y[i]! - v) * t));
};
function luminance(hex: string): number {
  const ch = rgb(hex).map((c) => c / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
const HEX6 = /^#[0-9a-fA-F]{6}$/;
const hex6 = (v: string, fallback: string) => {
  if (HEX6.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  return fallback;
};

// ---------- fallback design (brain unreachable) ----------

export function fallbackDesign(info: StoreInfo): StorefrontDesign {
  const bg = hex6(info.theme.background, "#fbf8f2");
  const text = hex6(info.theme.text, "#1f1e1b");
  const primary = hex6(info.theme.primary, "#3b3a36");
  const palette: DesignPalette = {
    background: bg,
    surface: mix(bg, text, 0.045),
    text,
    muted: mix(text, bg, 0.38),
    primary,
    onPrimary: contrast("#ffffff", primary) >= 4.5 ? "#ffffff" : text,
    accent: hex6(info.theme.accent, primary),
  };
  return {
    version: 1,
    businessId: info.businessId,
    style: "editorial",
    corners: "round",
    palette,
    fonts: { display: "Fraunces", body: "Inter" },
    announcement: info.fulfillment === "pickup" ? "Order ahead online · Pick up when it's ready" : "",
    hero: { eyebrow: "", title: info.headline || info.name, subtitle: info.tagline, cta: "Shop now", layout: "split", image: null },
    collection: { title: "Shop the", accent: "menu" },
    banner: { title: info.fulfillment === "pickup" ? "Plan your pickup" : "Visit us", image: null },
    productImages: {},
    generator: "store fallback",
    generatedAt: new Date(0).toISOString(),
    notes: [],
  };
}

// ---------- loading ----------

const cacheKey = (slug: string) => `napkin.design.${slug}`;

function readCache(slug: string): StorefrontDesign | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(slug));
    if (!raw) return null;
    const parsed = StorefrontDesign.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeCache(slug: string, d: StorefrontDesign) {
  try {
    window.localStorage.setItem(cacheKey(slug), JSON.stringify(d));
  } catch {
    // storage unavailable: the design is simply fetched again next visit
  }
}

export type DesignState = { design: StorefrontDesign | null; settled: boolean };

/**
 * The store's design: the cached copy right away (if any), then the brain's current one. `settled` turns
 * true once the brain answered or 2.5 s passed, so the page can fall back instead of waiting forever.
 */
export function useDesign(slug: string): DesignState {
  const [state, setState] = useState<DesignState>({ design: null, settled: false });
  useEffect(() => {
    let live = true;
    const cached = readCache(slug);
    if (cached) setState({ design: cached, settled: false });
    const timer = window.setTimeout(() => live && setState((s) => ({ ...s, settled: true })), 2500);
    const load = async () => {
      try {
        const res = await fetch(`${BRAIN_URL}/storefront/${encodeURIComponent(slug)}/design`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const parsed = StorefrontDesign.safeParse(await res.json());
        if (!parsed.success) throw new Error("invalid design");
        if (!live) return;
        writeCache(slug, parsed.data);
        setState({ design: parsed.data, settled: true });
      } catch {
        if (live) setState((s) => ({ ...s, settled: true }));
      }
    };
    void load();
    // pick up a regenerated look without a reload
    const poll = window.setInterval(load, 60_000);
    return () => {
      live = false;
      window.clearTimeout(timer);
      window.clearInterval(poll);
    };
  }, [slug]);
  return state;
}

// ---------- rendering helpers ----------

const RADIUS = {
  round: { tile: "1.5rem", card: "1.25rem", btn: "9999px", input: "0.875rem" },
  soft: { tile: "0.75rem", card: "0.625rem", btn: "0.5rem", input: "0.5rem" },
  square: { tile: "0", card: "0", btn: "0", input: "0" },
} as const;

/** CSS custom properties for a design; globals.css maps them to Tailwind colors and component styles. */
export function designStyle(d: StorefrontDesign): CSSProperties {
  const p = d.palette;
  const r = RADIUS[d.corners];
  return {
    "--ds-bg": p.background,
    "--ds-surface": p.surface,
    "--ds-text": p.text,
    "--ds-muted": p.muted,
    "--ds-primary": p.primary,
    "--ds-on-primary": p.onPrimary,
    "--ds-accent": p.accent,
    "--ds-r-tile": r.tile,
    "--ds-r-card": r.card,
    "--ds-r-btn": r.btn,
    "--ds-r-input": r.input,
    "--ds-display": fontStack(d.fonts.display),
    "--ds-body": fontStack(d.fonts.body),
  } as CSSProperties;
}

export function productImage(d: StorefrontDesign, p: Product) {
  return d.productImages[p.id] ?? null;
}

/** Unique photo credits for the footer (CC licenses require attribution). */
export function photoCredits(d: StorefrontDesign) {
  const all = [d.hero.image, d.banner.image, ...Object.values(d.productImages)].filter((x): x is DesignImage => x !== null && x.source === "openverse");
  const seen = new Set<string>();
  return all.filter((i) => (seen.has(i.url) ? false : (seen.add(i.url), true)));
}
