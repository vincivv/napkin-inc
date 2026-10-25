// Storefront photos from Openverse (openly licensed images, anonymous API, no key). Deterministic code
// searches, filters and builds the license/credit data from the API's own fields; an optional Claude
// Sonnet vision call only picks WHICH of the filtered candidates looks best. Any failure (network,
// rate limit, timeout, vision error) leaves that slot without a photo: images never fail a design.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DesignImage } from "@napkin/schema";
import { log } from "../log";
import { MODELS, type Llm, type UserContent } from "../llm";
import type { ImageSlot } from "./design";

export const OPENVERSE_API = "https://api.openverse.org/v1/images/";
export const VISION_MODEL = MODELS.sonnet;

export interface OpenverseResult {
  id: string;
  title?: string | null;
  url?: string | null;
  thumbnail?: string | null;
  width?: number | null;
  height?: number | null;
  creator?: string | null;
  license?: string | null;
  license_version?: string | null;
  license_url?: string | null;
  foreign_landing_url?: string | null;
  tags?: { name: string }[] | null;
  mature?: boolean | null;
  unstable__sensitivity?: unknown[] | null;
}

export interface ImageResolver {
  /** slot key -> photo; slots with no usable photo are absent */
  resolve(slots: ImageSlot[]): Promise<Record<string, DesignImage>>;
}

export function openverseUrl(query: string, aspect: ImageSlot["aspect"]): string {
  const q = new URLSearchParams({ q: query, license: "cc0,pdm,by,by-sa", mature: "false", page_size: "12" });
  if (aspect === "wide") q.set("aspect_ratio", "wide");
  return `${OPENVERSE_API}?${q.toString().replace(/%2C/g, ",")}`;
}

/** Photos that probably show text, logos, people or drawings rather than the product. */
const SKIP =
  /\b(text|logo|logos|sign|signs|signage|poster|flyer|menu|label|typography|lettering|quote|screenshot|meme|watermark|advert|advertisement|portrait|selfie|headshot|face|faces|people|person|woman|women|man|men|girl|boy|child|kids?|model|illustration|drawing|cartoon|clipart|icon|vector|diagram|map|chart)\b/i;
/** Stricter filter for when no vision pick is available: places and signage often show another business's name. */
const PLACE_OR_SIGN = /\b(bakery|bakeries|shop|shops|store|stores|storefront|cafe|café|coffeehouse|restaurant|bistro|diner|bar|pub|boutique|market|mall|window|sign|signs|signage|logo|logos|menu|brand|label|packaging|neon)\b/i;
const words = (r: OpenverseResult) => [r.title ?? "", ...(r.tags ?? []).map((t) => t.name)].join(" ");
/** Candidates without place/signage words (used when the vision pick is unavailable). */
export function withoutPlaces(cands: OpenverseResult[]): OpenverseResult[] {
  return cands.filter((r) => !PLACE_OR_SIGN.test(words(r)));
}
/** Openverse's mature flag misses some results; anything that reads as adult content is dropped outright. */
const ADULT = /\b(sexy|sex|nude|nudity|naked|topless|nsfw|erotic|erotica|lingerie|bikini|thong|nipples?|boudoir|babe|ass|busty|fetish|porn)\b/i;
const PREFERRED_HOSTS = ["live.staticflickr.com", "upload.wikimedia.org"];

const host = (u: string) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

/** Usable candidates in preference order: wide enough, https, safe, not text/people; Flickr/Wikimedia first. */
export function filterCandidates(results: OpenverseResult[]): OpenverseResult[] {
  const ok = results.filter((r) => {
    if (!r.url || !r.url.startsWith("https://") || !r.license) return false;
    if (typeof r.width !== "number" || r.width < 640) return false;
    if (r.mature || (r.unstable__sensitivity && r.unstable__sensitivity.length > 0)) return false;
    return !SKIP.test(words(r)) && !ADULT.test(words(r));
  });
  const rank = (r: OpenverseResult) => (PREFERRED_HOSTS.includes(host(r.url!)) ? 0 : 1);
  return ok.map((r, i) => ({ r, i })).sort((a, b) => rank(a.r) - rank(b.r) || a.i - b.i).map((x) => x.r);
}

/** The query, then without photo-style phrases ("close up", "flat lay", "on wooden table"), then its first two words. */
export function relaxedQueries(query: string): string[] {
  const q = query.trim().replace(/\s+/g, " ");
  const plain = q
    .replace(/\b(close up|closeup|flat lay|top view|overhead|on (?:a )?(?:wooden |marble |white |dark )?(?:table|shelf|counter|board|plate|tray))\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = (plain || q).split(" ");
  return [...new Set([q, plain, words.length > 2 ? words.slice(0, 2).join(" ") : ""].filter(Boolean))].slice(0, 3);
}

export function licenseLabel(license: string, version: string | null | undefined): string {
  const l = license.toLowerCase();
  if (l === "cc0") return "CC0 1.0";
  if (l === "pdm") return "Public Domain Mark 1.0";
  return `CC ${l.toUpperCase()}${version ? ` ${version}` : ""}`.slice(0, 40);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const httpsOrNull = (u: string | null | undefined) => (u && u.startsWith("https://") ? u : null);

/** DesignImage from an Openverse result (all licensing data comes from the API), or undefined if it does not validate. */
export function toDesignImage(r: OpenverseResult, altFallback: string): DesignImage | undefined {
  const title = (r.title ?? "").replace(/\s+/g, " ").trim();
  const creator = (r.creator ?? "").replace(/\s+/g, " ").trim();
  const filename = !/[a-z]{3}/i.test(title) || /^(img|dsc|dscn|p|pict|photo)[_ -]?\d+/i.test(title);
  const credit = title && creator ? `Photo: ${title} by ${creator}` : title ? `Photo: ${title}` : creator ? `Photo by ${creator}` : "Photo from Openverse";
  const img = DesignImage.safeParse({
    url: r.url,
    alt: clip(filename || !title ? altFallback : title, 200),
    credit: clip(credit, 200),
    creditUrl: httpsOrNull(r.foreign_landing_url),
    license: licenseLabel(r.license ?? "", r.license_version),
    licenseUrl: httpsOrNull(r.license_url),
    source: "openverse",
  });
  return img.success && img.data.url.startsWith("https://") ? img.data : undefined;
}

export interface OpenverseOptions {
  /** where search responses are cached (Openverse's anonymous rate limits are tight); none = no cache */
  cacheDir?: string;
  cacheTtlMs?: number;
  fetch?: typeof fetch;
  /** optional vision pick (Claude Sonnet); without it the first filtered candidate is used */
  vision?: Llm;
  /** whole resolve() budget */
  timeoutMs?: number;
  concurrency?: number;
  searchTimeoutMs?: number;
  visionTimeoutMs?: number;
  /** per-photo liveness check (HEAD) */
  liveTimeoutMs?: number;
}

const VISION_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type VisionType = (typeof VISION_TYPES)[number];

const PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { index: { type: "integer", minimum: -1, description: "0-based index of the best photo, or -1 if none is suitable" } },
  required: ["index"],
} as const;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  return Promise.race([p, new Promise<T>((_, rej) => (t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)))]).finally(() => clearTimeout(t));
}

export class OpenverseImages implements ImageResolver {
  private readonly fetch: typeof fetch;
  constructor(private readonly o: OpenverseOptions = {}) {
    this.fetch = o.fetch ?? globalThis.fetch;
  }

  private cacheFile(url: string) {
    return this.o.cacheDir ? path.join(this.o.cacheDir, `${crypto.createHash("sha256").update(url).digest("hex").slice(0, 32)}.json`) : undefined;
  }

  /** Raw results for a query, from the disk cache when fresh. Throws on network/HTTP errors. */
  async search(query: string, aspect: ImageSlot["aspect"]): Promise<OpenverseResult[]> {
    const url = openverseUrl(query, aspect);
    const file = this.cacheFile(url);
    if (file) {
      try {
        const hit = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt: number; results: OpenverseResult[] };
        if (Date.now() - hit.fetchedAt < (this.o.cacheTtlMs ?? 7 * 24 * 3600_000)) return hit.results;
      } catch {
        /* no cache entry */
      }
    }
    const res = await this.fetch(url, { headers: { accept: "application/json", "user-agent": "napkin-inc-brain/0.1 (storefront design)" }, signal: AbortSignal.timeout(this.o.searchTimeoutMs ?? 15_000) });
    if (!res.ok) throw new Error(`openverse ${res.status} for "${query}"`);
    const body = (await res.json()) as { results?: OpenverseResult[] };
    const results = Array.isArray(body.results) ? body.results : [];
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), query, aspect, results }), { mode: 0o600 });
    }
    return results;
  }

  /** Index of the best of up to 6 candidates by vision, -1 for none; "unavailable" when vision is off or fails. */
  async pick(slot: ImageSlot, cands: OpenverseResult[]): Promise<number | "unavailable"> {
    if (!this.o.vision || cands.length === 0) return "unavailable";
    // The thumbnails are downloaded here and sent inline: Anthropic's URL fetcher is refused by Openverse's robots.txt.
    const thumbs = await Promise.all(cands.slice(0, 6).map((c) => this.download(c.thumbnail && c.thumbnail.startsWith("https://") ? c.thumbnail : c.url!)));
    const shown = thumbs.flatMap((t, i) => (t ? [{ i, t }] : []));
    if (shown.length === 0) return "unavailable";
    const content: UserContent[] = [
      {
        type: "text",
        text:
          `Pick the photo for ${slot.topic}. Search query: "${slot.query}". Choose the most appetizing, professional-looking, on-topic photo. ` +
          "REJECT any photo with visible text of any kind: signage, shop or business names, brand logos, packaging labels, menus, watermarks or captions (a photo showing another business's name would look like impersonation), and any photo with a recognizable face. " +
          "For a product, the photo must clearly show exactly that product as named: a different variety, flavor or item (blondies or snickerdoodles for chocolate chip cookies, a jacket for a hoodie) is wrong. " +
          "If no photo passes, answer -1.",
      },
    ];
    shown.forEach((s, n) => content.push({ type: "text", text: `Photo ${n}:` }, { type: "image", mediaType: s.t.mediaType, base64: s.t.base64 }));
    try {
      const raw = (await withTimeout(
        this.o.vision.tool({ model: VISION_MODEL, system: "You choose storefront photos for a small business.", content, toolName: "pick_photo", toolDescription: "Record the index of the best photo, or -1.", schema: PICK_SCHEMA as unknown as Record<string, unknown>, maxTokens: 2_000 }),
        this.o.visionTimeoutMs ?? 15_000,
        "vision pick",
      )) as { index?: unknown };
      const n = raw?.index;
      if (n === -1) return -1;
      if (typeof n === "number" && Number.isInteger(n) && n >= 0 && n < shown.length) return shown[n]!.i;
      return "unavailable";
    } catch (e) {
      log.warn("design", `vision pick for ${slot.key} failed, using the first candidate without place/sign words: ${(e as Error).message}`);
      return "unavailable";
    }
  }

  /** A small image for the vision pick (jpeg/png/gif/webp, at most 2 MB), or undefined. */
  private async download(url: string): Promise<{ mediaType: VisionType; base64: string } | undefined> {
    try {
      const res = await this.fetch(url, { headers: { "user-agent": "napkin-inc-brain/0.1 (storefront design)" }, signal: AbortSignal.timeout(5_000) });
      const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim() as VisionType;
      if (!res.ok || !VISION_TYPES.includes(type)) {
        void res.body?.cancel().catch(() => undefined);
        return undefined;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > 0 && buf.length <= 2 * 1024 * 1024 ? { mediaType: type, base64: buf.toString("base64") } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Ordered usable photos for one slot (best first); [] when nothing fits. */
  private async slotCandidates(slot: ImageSlot): Promise<DesignImage[]> {
    // Openverse matches every word, so a precise query often finds nothing: relax it until there is a choice
    const cands: OpenverseResult[] = [];
    for (const q of relaxedQueries(slot.query)) {
      for (const r of filterCandidates(await this.search(q, slot.aspect))) if (!cands.some((c) => c.id === r.id)) cands.push(r);
      if (cands.length >= 4) break;
    }
    if (cands.length === 0) return [];
    const best = await this.pick(slot, cands);
    if (best === -1) return [];
    // without a vision verdict only text-free-looking candidates are eligible; with one, the pick goes first
    const ordered = best === "unavailable" ? withoutPlaces(cands) : [cands[best]!, ...withoutPlaces(cands.filter((_, i) => i !== best))];
    const imgs = ordered.map((r) => toDesignImage(r, slot.query)).filter((x): x is DesignImage => Boolean(x)).slice(0, 3);
    const live = await Promise.all(imgs.map((x) => this.isLive(x.url)));
    return imgs.filter((_, i) => live[i]);
  }

  /** The photo URL answers 200 with an image/* type (no redirect: Flickr redirects dead photos to a placeholder). */
  async isLive(url: string): Promise<boolean> {
    const attempt = async (method: "HEAD" | "GET") => {
      const res = await this.fetch(url, { method, redirect: "manual", headers: { "user-agent": "napkin-inc-brain/0.1 (storefront design)", ...(method === "GET" ? { range: "bytes=0-0" } : {}) }, signal: AbortSignal.timeout(this.o.liveTimeoutMs ?? 3_000) });
      void res.body?.cancel().catch(() => undefined);
      return { status: res.status, type: res.headers.get("content-type") ?? "" };
    };
    try {
      let r = await attempt("HEAD");
      if (r.status === 405 || r.status === 403 || r.status === 501) r = await attempt("GET");
      const ok = (r.status === 200 || r.status === 206) && r.type.startsWith("image/");
      if (!ok) log.warn("design", `skipping photo ${url}: ${r.status} ${r.type || "no content-type"}`);
      return ok;
    } catch (e) {
      log.warn("design", `skipping photo ${url}: ${(e as Error).message}`);
      return false;
    }
  }

  async resolve(slots: ImageSlot[]): Promise<Record<string, DesignImage>> {
    const found = new Map<string, DesignImage[]>();
    const queue = [...slots];
    const worker = async () => {
      for (let s = queue.shift(); s; s = queue.shift()) {
        try {
          found.set(s.key, await this.slotCandidates(s));
        } catch (e) {
          log.warn("design", `image search for ${s.key} ("${s.query}") failed: ${(e as Error).message}`);
        }
      }
    };
    const all = Promise.all(Array.from({ length: Math.min(this.o.concurrency ?? 4, slots.length) }, worker));
    try {
      await withTimeout(all, this.o.timeoutMs ?? 40_000, "image search");
    } catch (e) {
      log.warn("design", `${(e as Error).message}; using the photos found so far`);
      queue.length = 0;
    }
    // one photo per slot, in slot order, never the same photo twice
    const used = new Set<string>();
    const out: Record<string, DesignImage> = {};
    for (const s of slots) {
      const img = found.get(s.key)?.find((x) => !used.has(x.url));
      if (img) {
        used.add(img.url);
        out[s.key] = img;
      }
    }
    return out;
  }
}
