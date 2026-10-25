// Storefront designs: generate (Claude proposal + Openverse photos, validated here), store and serve the
// StorefrontDesign the store app renders. Routes:
//   GET    /storefront/:slug/design                 public; the saved design, else the default from the active config
//   POST   /storefront/:businessId/design/regenerate {style?}   account-gated; full LLM + photo generation, saved
//   PATCH  /storefront/:businessId/design           account-gated; owner edits, validated (400 + reasons)
//   POST   /storefront/:businessId/images/:slot     account-gated; multipart `file` (jpeg/png/webp, <= 6 MB)
//   DELETE /storefront/:businessId/images/:slot     account-gated; removes that photo
//   GET    /media/:file                             public; owner uploads
// slot = hero | banner | product:<productId>. A design is look only: no money, no policy, no config version.

import type { Context, Hono, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { Configuration, DesignStyle, StorefrontDesign, type DesignImage } from "@napkin/schema";
import { log } from "../log";
import type { Llm } from "../llm";
import type { CompilePlatformPort } from "../compiler/platform";
import { acceptDesignProposal, applyDesignPatch, copyContext, defaultDesign, DesignPatch, designInputFromConfig, imageSlots, type DesignInput, type DesignProposal, type DesignStyleName } from "./design";
import { OpenverseImages, type ImageResolver } from "./images";
import { LlmDesignProposer, type DesignProposer } from "./proposer";
import { DesignStore, MAX_UPLOAD_BYTES, MediaStore, sniffImage } from "./store";

export { defaultDesign, designInputFromConfig } from "./design";
export { DesignStore, MediaStore } from "./store";

// ---------- generation ----------

export interface GenerateDeps {
  proposer?: DesignProposer;
  images?: ImageResolver;
  now?: () => Date;
}

/** Proposal (optional) -> validated design -> photos (optional). Never throws for LLM or image failures. */
export async function generateDesign(input: DesignInput, deps: GenerateDeps, opts: { style?: DesignStyleName } = {}): Promise<StorefrontDesign> {
  const pre: string[] = [];
  let proposal: DesignProposal | undefined;
  if (deps.proposer) {
    try {
      proposal = await deps.proposer.propose(input, opts.style ? { style: opts.style } : {});
      if (!proposal) pre.push("the design model returned no usable proposal; the default design is used");
    } catch (e) {
      log.warn("design", `proposal for ${input.businessId} failed: ${(e as Error).message}`);
      pre.push("the design model was unavailable; the default design is used");
    }
  }
  const generator = `${proposal ? deps.proposer!.name : "default"}${deps.images ? " + openverse" : ""}`.slice(0, 80);
  const d = acceptDesignProposal(proposal, input, { ...(opts.style ? { forceStyle: opts.style } : {}), generator, ...(deps.now ? { now: deps.now } : {}) });
  const notes = [...pre, ...d.notes];
  if (deps.images) {
    try {
      const imgs = await deps.images.resolve(imageSlots(proposal, input, notes));
      d.hero.image = imgs["hero"] ?? null;
      d.banner.image = imgs["banner"] ?? null;
      for (const p of input.products) if (imgs[`product:${p.id}`]) d.productImages[p.id] = imgs[`product:${p.id}`]!;
    } catch (e) {
      log.warn("design", `photos for ${input.businessId} failed: ${(e as Error).message}`);
    }
  }
  if (!d.hero.image && d.hero.layout === "fullbleed") d.hero.layout = "split"; // a full-bleed hero needs a photo
  return StorefrontDesign.parse({ ...d, notes: notes.slice(0, 40) });
}

export class DesignBusy extends Error {
  override name = "DesignBusy";
}

/** Generation with one run per business at a time; owner uploads survive a regenerate. */
export class DesignService {
  private readonly running = new Set<string>();
  constructor(
    readonly designs: DesignStore,
    private readonly deps: GenerateDeps,
  ) {}

  isRunning(businessId: string): boolean {
    return this.running.has(businessId);
  }

  async regenerate(input: DesignInput, style?: DesignStyleName): Promise<StorefrontDesign> {
    if (this.running.has(input.businessId)) throw new DesignBusy(`a design for ${input.businessId} is already being generated`);
    this.running.add(input.businessId);
    try {
      const t0 = Date.now();
      const fresh = await generateDesign(input, this.deps, style ? { style } : {});
      const prev = this.designs.get(input.businessId);
      if (prev?.hero.image?.source === "upload") fresh.hero.image = prev.hero.image;
      if (prev?.banner.image?.source === "upload") fresh.banner.image = prev.banner.image;
      for (const p of input.products) {
        const up = prev?.productImages[p.id];
        if (up?.source === "upload") fresh.productImages[p.id] = up;
      }
      this.designs.put(fresh);
      log.info("design", `${input.businessId}: ${fresh.style} design saved in ${Date.now() - t0} ms (${fresh.generator}; ${fresh.notes.length} notes)`);
      return fresh;
    } finally {
      this.running.delete(input.businessId);
    }
  }

  /** Compile hook: generates and saves a design once, only while the business has none. */
  async ensure(input: DesignInput): Promise<void> {
    if (this.designs.get(input.businessId) || this.running.has(input.businessId)) return;
    this.running.add(input.businessId);
    try {
      const fresh = await generateDesign(input, this.deps);
      if (!this.designs.get(input.businessId)) this.designs.put(fresh); // the owner may have edited meanwhile
      log.info("design", `${input.businessId}: first design generated (${fresh.style}, ${fresh.generator})`);
    } finally {
      this.running.delete(input.businessId);
    }
  }

  /** Fire-and-forget form of ensure() for after a compile: never throws, only logs. */
  ensureInBackground(input: DesignInput): void {
    void this.ensure(input).catch((e) => log.error("design", `first design for ${input.businessId} failed: ${(e as Error).message}`));
  }
}

// ---------- the active configuration (read from the system connection's cache) ----------

/** businessId -> its active, schema-valid Configuration (parsed once per config row). */
export function activeConfigReader(platform: Pick<CompilePlatformPort, "business" | "configVersions">): (businessId: string) => Configuration | undefined {
  const cache = new Map<bigint, { json: string; cfg: Configuration | undefined }>();
  return (businessId) => {
    const b = platform.business(businessId);
    if (!b || b.activeConfigId === 0n) return undefined;
    const row = platform.configVersions(businessId).find((v) => v.id === b.activeConfigId);
    if (!row) return undefined;
    const hit = cache.get(row.id);
    if (hit && hit.json === row.json) return hit.cfg;
    let cfg: Configuration | undefined;
    try {
      const ok = Configuration.safeParse(JSON.parse(row.json));
      cfg = ok.success ? ok.data : undefined;
    } catch {
      cfg = undefined;
    }
    cache.set(row.id, { json: row.json, cfg });
    return cfg;
  };
}

// ---------- HTTP ----------

export interface StorefrontRouteDeps {
  service: DesignService;
  media: MediaStore;
  activeConfig(businessId: string): Configuration | undefined;
  /** businessGate (accounts): only the business's own account passes */
  gate: MiddlewareHandler;
  /** public base URL of this brain (BRAIN_URL), for upload URLs */
  mediaBaseUrl: string;
}

const BUSINESS_ID = /^[a-z0-9-]{1,64}$/;
const RegenerateBody = z.object({ style: DesignStyle.optional() }).strict();
type Slot = { kind: "hero" } | { kind: "banner" } | { kind: "product"; productId: string };

function parseSlot(s: string): Slot | undefined {
  if (s === "hero" || s === "banner") return { kind: s };
  const m = /^product:([A-Za-z0-9_.:@-]{1,128})$/.exec(s);
  return m ? { kind: "product", productId: m[1]! } : undefined;
}

export function registerStorefrontRoutes(app: Hono, d: StorefrontRouteDeps): void {
  const designs = d.service.designs;
  const mediaPrefix = `${d.mediaBaseUrl.replace(/\/+$/, "")}/media/`;
  const uploadedFile = (img: DesignImage | null | undefined) => (img?.source === "upload" && img.url.startsWith(mediaPrefix) ? img.url.slice(mediaPrefix.length) : undefined);

  /** The business's live config, or a 409 response. */
  const liveConfig = (c: Context) => {
    const cfg = d.activeConfig(c.req.param("businessId")!);
    return cfg ?? c.json({ error: "this business is not live yet: finish setup first" }, 409);
  };
  const current = (cfg: Configuration) => designs.get(cfg.businessId) ?? defaultDesign(designInputFromConfig(cfg));

  app.get("/storefront/:slug/design", (c) => {
    const slug = c.req.param("slug");
    if (!BUSINESS_ID.test(slug)) return c.json({ error: "unknown business" }, 404);
    const headers = { "Cache-Control": "public, max-age=15" };
    const saved = designs.get(slug);
    if (saved) return c.json(saved, 200, headers);
    const cfg = d.activeConfig(slug);
    if (!cfg) return c.json({ error: "unknown business" }, 404);
    // a live business with no saved design (live before designs existed, or never compiled here): generate
    // one in the background, once; until it lands the store gets the deterministic default
    const input = designInputFromConfig(cfg);
    d.service.ensureInBackground(input);
    return c.json(defaultDesign(input), 200, { "Cache-Control": "no-store" });
  });

  app.post("/storefront/:businessId/design/regenerate", d.gate, async (c) => {
    const text = await c.req.text();
    let body: unknown = {};
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = RegenerateBody.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid request", reasons: parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, 400);
    const cfg = liveConfig(c);
    if (cfg instanceof Response) return cfg;
    try {
      return c.json(await d.service.regenerate(designInputFromConfig(cfg), parsed.data.style));
    } catch (e) {
      if (e instanceof DesignBusy) return c.json({ error: e.message }, 409);
      throw e;
    }
  });

  app.patch("/storefront/:businessId/design", d.gate, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const patch = DesignPatch.safeParse(body);
    if (!patch.success) return c.json({ error: "invalid design edit", reasons: patch.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`) }, 400);
    const cfg = liveConfig(c);
    if (cfg instanceof Response) return cfg;
    const r = applyDesignPatch(current(cfg), patch.data, copyContext(designInputFromConfig(cfg)));
    if (!r.design) return c.json({ error: "invalid design edit", reasons: r.reasons }, 400);
    designs.put(r.design);
    return c.json(r.design);
  });

  const upload = bodyLimit({ maxSize: MAX_UPLOAD_BYTES + 64 * 1024, onError: (c) => c.json({ error: "the photo is larger than 6 MB" }, 413) });

  app.post("/storefront/:businessId/images/:slot", d.gate, upload, async (c) => {
    const slot = parseSlot(c.req.param("slot"));
    if (!slot) return c.json({ error: "slot must be hero, banner or product:<productId>" }, 400);
    const cfg = liveConfig(c);
    if (cfg instanceof Response) return cfg;
    const input = designInputFromConfig(cfg);
    const product = slot.kind === "product" ? input.products.find((p) => p.id === slot.productId) : undefined;
    if (slot.kind === "product" && !product) return c.json({ error: `unknown product ${slot.productId}` }, 404);
    let file: unknown;
    try {
      file = (await c.req.parseBody())["file"];
    } catch {
      return c.json({ error: "send the photo as multipart/form-data field `file`" }, 400);
    }
    if (!(file instanceof File)) return c.json({ error: "send the photo as multipart/form-data field `file`" }, 400);
    if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: "the photo is larger than 6 MB" }, 413);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = sniffImage(bytes);
    if (!ext) return c.json({ error: "the photo must be a JPEG, PNG or WebP image" }, 415);
    const name = d.media.save(bytes, ext);
    const img: DesignImage = {
      url: `${mediaPrefix}${name}`,
      alt: (product ? product.name : input.businessName).slice(0, 200),
      credit: "Photo from the owner",
      creditUrl: null,
      license: "",
      licenseUrl: null,
      source: "upload",
    };
    const design = structuredClone(current(cfg));
    const old = slot.kind === "hero" ? design.hero.image : slot.kind === "banner" ? design.banner.image : design.productImages[slot.productId];
    if (slot.kind === "hero") design.hero.image = img;
    else if (slot.kind === "banner") design.banner.image = img;
    else design.productImages[slot.productId] = img;
    designs.put(design);
    const oldFile = uploadedFile(old);
    if (oldFile) d.media.remove(oldFile);
    log.info("design", `${cfg.businessId}: owner photo for ${c.req.param("slot")} (${bytes.length} bytes)`);
    return c.json(design);
  });

  app.delete("/storefront/:businessId/images/:slot", d.gate, (c) => {
    const slot = parseSlot(c.req.param("slot"));
    if (!slot) return c.json({ error: "slot must be hero, banner or product:<productId>" }, 400);
    const cfg = liveConfig(c);
    if (cfg instanceof Response) return cfg;
    const design = structuredClone(current(cfg));
    let old: DesignImage | null | undefined;
    if (slot.kind === "hero") [old, design.hero.image] = [design.hero.image, null];
    else if (slot.kind === "banner") [old, design.banner.image] = [design.banner.image, null];
    else {
      old = design.productImages[slot.productId];
      delete design.productImages[slot.productId];
    }
    if (!old) return c.json(design);
    designs.put(design);
    const oldFile = uploadedFile(old);
    if (oldFile) d.media.remove(oldFile);
    return c.json(design);
  });

  app.get("/media/:file", (c) => {
    const f = d.media.read(c.req.param("file"));
    if (!f) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(f.bytes), 200, { "Content-Type": f.type, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
  });
}

/** Production wiring for server.ts: Claude proposals and Sonnet photo picks only when ANTHROPIC_API_KEY is set. */
export function mountStorefront(
  app: Hono,
  o: { dataDir: string; mediaBaseUrl: string; gate: MiddlewareHandler; activeConfig: (businessId: string) => Configuration | undefined; llm: Llm | undefined },
): DesignService {
  const images = new OpenverseImages({ cacheDir: `${o.dataDir}/openverse-cache`, ...(o.llm ? { vision: o.llm } : {}) });
  const service = new DesignService(new DesignStore(o.dataDir), { ...(o.llm ? { proposer: new LlmDesignProposer(o.llm) } : {}), images });
  registerStorefrontRoutes(app, { service, media: new MediaStore(o.dataDir), activeConfig: o.activeConfig, gate: o.gate, mediaBaseUrl: o.mediaBaseUrl });
  return service;
}
