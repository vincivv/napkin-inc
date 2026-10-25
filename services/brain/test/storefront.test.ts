import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import maya from "../../../fixtures/maya/configuration.json";
import { DesignImage, parseConfiguration, StorefrontDesign, type Configuration } from "@napkin/schema";
import { AccountStore, businessGate, registerAccountRoutes } from "../src/accounts";
import { RateLimiter } from "../src/auth";
import type { Llm, ToolRequest } from "../src/llm";
import { activeConfigReader, DesignService, generateDesign, registerStorefrontRoutes } from "../src/storefront";
import { acceptDesignProposal, applyDesignPatch, copyContext, defaultDesign, designInputFromConfig, imageQueryProblem, imageSlots, paletteProblems, type DesignInput } from "../src/storefront/design";
import { filterCandidates, licenseLabel, OpenverseImages, relaxedQueries, toDesignImage, type ImageResolver, type OpenverseResult } from "../src/storefront/images";
import { DesignStore, MediaStore, sniffImage } from "../src/storefront/store";

const mayaConfig = (): Configuration => parseConfiguration(structuredClone(maya));
const mayaInput = (): DesignInput => designInputFromConfig(mayaConfig());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "napkin-design-"));

describe("default design", () => {
  it("passes the schema and every palette rule for a pickup business", () => {
    const d = defaultDesign(mayaInput());
    expect(StorefrontDesign.safeParse(d).success).toBe(true);
    expect(paletteProblems(d.palette)).toEqual([]);
    expect(d).toMatchObject({
      style: "editorial",
      corners: "round",
      fonts: { display: "Fraunces", body: "Inter" },
      announcement: "Order ahead online · Pick up when it's ready",
      hero: { title: "Maya's Cookies", subtitle: "Fresh chocolate chip cookies. Order ahead, pick up.", cta: "Shop now", image: null },
      collection: { title: "Shop the", accent: "menu" },
      banner: { title: "Plan your pickup", image: null },
      productImages: {},
    });
  });
  it("passes for a delivery business, a bold style, and a broken or dark theme", () => {
    const cfg = mayaConfig();
    cfg.policies.fulfillment = "delivery";
    cfg.storefront.theme = { primary: "#ffff00", accent: "not-a-color", background: "#101010", text: "#fafafa" };
    const input = designInputFromConfig(cfg);
    for (const style of ["editorial", "bold"] as const) {
      const d = defaultDesign(input, style);
      expect(StorefrontDesign.safeParse(d).success).toBe(true);
      expect(paletteProblems(d.palette)).toEqual([]);
      expect(d.banner.title).toBe("Visit us");
    }
    expect(defaultDesign(input, "bold")).toMatchObject({ corners: "square", fonts: { display: "Archivo" }, palette: { background: "#ffffff", primary: "#111111" } });
  });
});

describe("proposal validation (bad fields fall back to the default, with a note)", () => {
  const good = {
    style: "editorial",
    corners: "soft",
    palette: { background: "#fbf6ee", surface: "#f3ebdd", text: "#2b1d14", muted: "#7a6656", primary: "#6b3e26", onPrimary: "#ffffff", accent: "#b5652b" },
    fonts: { display: "Instrument Serif", body: "DM Sans" },
    announcement: "Order ahead online, then pick up",
    hero: { eyebrow: "Pickup only", title: "Maya's Cookies", subtitle: "Chocolate chip cookies, ready when you are.", cta: "Order cookies", layout: "split" },
    collection: { title: "Shop the", accent: "cookies" },
    banner: { title: "Plan your pickup" },
  };
  const accept = (p: unknown, input = mayaInput()) => acceptDesignProposal(p as never, input, { generator: "test" });

  it("accepts a good proposal as-is", () => {
    const d = accept(good);
    expect(d.notes).toEqual([]);
    expect(d).toMatchObject({ corners: "soft", fonts: { display: "Instrument Serif", body: "DM Sans" }, palette: good.palette, collection: { accent: "cookies" } });
    expect(StorefrontDesign.safeParse(d).success).toBe(true);
  });
  it("bad hex or low contrast -> the whole default palette", () => {
    const base = defaultDesign(mayaInput()).palette;
    const hex = accept({ ...good, palette: { ...good.palette, primary: "brown" } });
    expect(hex.palette).toEqual(base);
    expect(hex.notes.join()).toMatch(/primary not #rrggbb/);
    const low = accept({ ...good, palette: { ...good.palette, text: "#cccccc" } });
    expect(low.palette).toEqual(base);
    expect(low.notes.join()).toMatch(/text contrast .* < 4.5/);
    const onPrimary = accept({ ...good, palette: { ...good.palette, onPrimary: "#7a4e36" } });
    expect(onPrimary.notes.join()).toMatch(/onPrimary contrast/);
  });
  it("invented facts, money words, digits and over-length copy keep the default for that field", () => {
    const d = accept({
      ...good,
      announcement: "Free pickup on every order",
      hero: { ...good.hero, eyebrow: "Open 7 days", subtitle: "Organic, family-owned cookies since forever", title: "x".repeat(49) },
      collection: { title: "Award-winning", accent: "cookies" },
      banner: { title: "Best in town pickup" },
    });
    const base = defaultDesign(mayaInput());
    expect(d.announcement).toBe(base.announcement);
    expect(d.hero.eyebrow).toBe(base.hero.eyebrow);
    expect(d.hero.subtitle).toBe(base.hero.subtitle);
    expect(d.hero.title).toBe("Maya's Cookies");
    expect(d.collection.title).toBe("Shop the");
    expect(d.collection.accent).toBe("cookies");
    expect(d.banner.title).toBe(base.banner.title);
    const notes = d.notes.join("\n");
    expect(notes).toMatch(/announcement: makes a price/);
    expect(notes).toMatch(/hero.eyebrow: contains digits/);
    expect(notes).toMatch(/hero.subtitle: states a fact the business did not give \("Organic"\)/);
    expect(notes).toMatch(/hero.title: longer than 48/);
    expect(notes).toMatch(/collection.title: states a fact/);
    expect(notes).toMatch(/banner.title: states a fact/);
  });
  it("a claim the business itself made is allowed", () => {
    const input = { ...mayaInput(), oneLiner: "Vegan chocolate chip cookies." };
    expect(accept({ ...good, hero: { ...good.hero, subtitle: "Vegan cookies, ready for pickup" } }, input).hero.subtitle).toBe("Vegan cookies, ready for pickup");
  });
  it("fonts, style, corners and layout outside the enums are refused", () => {
    const d = accept({ ...good, style: "grunge", corners: "blobby", fonts: { display: "Comic Sans", body: "Papyrus" }, hero: { ...good.hero, layout: "diagonal" } });
    expect(d).toMatchObject({ style: "editorial", corners: "round", fonts: { display: "Fraunces", body: "Inter" }, hero: { layout: "split" } });
    expect(d.notes.join()).toMatch(/fonts.display: "Comic Sans" is not in the allowed list/);
    expect(d.notes.join()).toMatch(/fonts.body/);
    expect(d.notes.join()).toMatch(/style: "grunge"/);
  });
  it("the owner's style choice wins over the proposal", () => {
    const d = acceptDesignProposal({ ...good } as never, mayaInput(), { forceStyle: "bold", generator: "t" });
    expect(d.style).toBe("bold");
  });
  it("image queries: 2-5 plain words about the product, never places or signs", () => {
    expect(imageQueryProblem("chocolate chip cookies close up")).toBeUndefined();
    expect(imageQueryProblem("cookies")).toMatch(/2-5 words/);
    expect(imageQueryProblem("bakery storefront window")).toMatch(/place, sign or brand/);
    expect(imageQueryProblem("cookies $3")).toMatch(/plain words/);
    const notes: string[] = [];
    const slots = imageSlots({ imageQueries: { hero: "shop window display", banner: "cookie dough on table", products: [{ productId: "cookie_single", query: "chocolate chip cookie" }] } } as never, mayaInput(), notes);
    expect(slots.map((s) => [s.key, s.query])).toEqual([
      ["hero", "chocolate chip cookie"],
      ["banner", "cookie dough on table"],
      ["product:cookie_single", "chocolate chip cookie"],
      ["product:cookie_box6", "box of"],
      ["product:sea_salt", "sea-salt topping"],
    ]);
    expect(notes.join()).toMatch(/hero: asks for a place/);
  });
});

describe("owner edits (PATCH validation rejects instead of defaulting)", () => {
  const ctx = copyContext(mayaInput());
  it("lets the owner state facts about their own business, but never prices or deals", () => {
    const cur = defaultDesign(mayaInput());
    expect(applyDesignPatch(cur, { hero: { subtitle: "Organic, family-owned cookies" } }, ctx).design?.hero.subtitle).toBe("Organic, family-owned cookies");
    expect(applyDesignPatch(cur, { announcement: "Free cookies today" }, ctx).reasons.join()).toMatch(/announcement/);
  });
  it("applies valid edits and rejects bad ones with reasons", () => {
    const cur = defaultDesign(mayaInput());
    const ok = applyDesignPatch(cur, { hero: { title: "Maya's", cta: "Order now" }, fonts: { display: "Outfit" }, announcement: "" }, ctx);
    expect(ok.design).toMatchObject({ hero: { title: "Maya's", cta: "Order now" }, fonts: { display: "Outfit" }, announcement: "" });
    const bad = applyDesignPatch(cur, { palette: { text: "#eeeeee" }, fonts: { body: "Papyrus" }, hero: { subtitle: "Cookies from $2, half price" }, banner: { title: "" } }, ctx);
    expect(bad.design).toBeUndefined();
    expect(bad.reasons.join("\n")).toMatch(/text contrast/);
    expect(bad.reasons.join("\n")).toMatch(/fonts.body/);
    expect(bad.reasons.join("\n")).toMatch(/hero.subtitle: contains digits/);
    expect(bad.reasons.join("\n")).toMatch(/banner.title: empty/);
  });
});

// ---------- Openverse ----------

const result = (id: string, over: Partial<OpenverseResult> = {}): OpenverseResult => ({
  id,
  title: `Chocolate chip cookies ${id}`,
  url: `https://live.staticflickr.com/1/${id}_b.jpg`,
  thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`,
  width: 1024,
  height: 683,
  creator: "slgckgc",
  license: "by",
  license_version: "2.0",
  license_url: "https://creativecommons.org/licenses/by/2.0/",
  foreign_landing_url: `https://www.flickr.com/photos/x/${id}`,
  tags: [{ name: "cookies" }],
  mature: false,
  unstable__sensitivity: [],
  ...over,
});

/** Fake network: Openverse searches by query, HEAD/thumbnail requests by URL; `dead` URLs redirect like Flickr's. */
function fakeFetch(byQuery: Record<string, OpenverseResult[]>, opts: { dead?: string[]; failQueries?: string[] } = {}) {
  const calls: string[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (url.startsWith("https://api.openverse.org/v1/images/?")) {
      const sp = new URL(url).searchParams;
      const q = sp.get("q")!;
      if (opts.failQueries?.includes(q)) return new Response("slow down", { status: 429 });
      // a source-filtered search answers from "<query>@<sources>"
      return Response.json({ results: byQuery[sp.get("source") ? `${q}@${sp.get("source")}` : q] ?? [] });
    }
    if (opts.dead?.includes(url)) return new Response(null, { status: 302, headers: { location: "https://s.yimg.com/photo_unavailable.png" } });
    return new Response(method === "HEAD" ? null : new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), { status: 200, headers: { "content-type": "image/jpeg" } });
  }) as typeof fetch;
  return { fn, calls };
}

/** Vision fake: answers with a fixed index (or throws). */
function fakeVision(answer: number | "throw"): Llm & { calls: ToolRequest[] } {
  const calls: ToolRequest[] = [];
  return {
    calls,
    async tool(req) {
      calls.push(req);
      if (answer === "throw") throw new Error("vision down");
      return { index: answer };
    },
    async text() {
      return "";
    },
  };
}

describe("Openverse photos", () => {
  it("maps a result to a valid DesignImage with the API's own license data", () => {
    const img = toDesignImage(result("a1"), "cookies")!;
    expect(img).toEqual({
      url: "https://live.staticflickr.com/1/a1_b.jpg",
      alt: "Chocolate chip cookies a1",
      credit: "Photo: Chocolate chip cookies a1 by slgckgc",
      creditUrl: "https://www.flickr.com/photos/x/a1",
      license: "CC BY 2.0",
      licenseUrl: "https://creativecommons.org/licenses/by/2.0/",
      source: "openverse",
    });
    expect(toDesignImage(result("a2", { title: "IMG_2041" }), "cookies on table")!.alt).toBe("cookies on table");
    expect(toDesignImage(result("a3", { url: "http://insecure.example/x.jpg" }), "x")).toBeUndefined();
    expect([licenseLabel("cc0", "1.0"), licenseLabel("pdm", null), licenseLabel("by-sa", "4.0")]).toEqual(["CC0 1.0", "Public Domain Mark 1.0", "CC BY-SA 4.0"]);
  });
  it("skips small, insecure, mature, text/logo/people and adult candidates; prefers Flickr/Wikimedia hosts", () => {
    const cands = filterCandidates([
      result("small", { width: 300 }),
      result("http", { url: "http://live.staticflickr.com/x.jpg" }),
      result("mature", { mature: true }),
      result("sens", { unstable__sensitivity: ["sensitive_text"] }),
      result("logo", { tags: [{ name: "logo" }] }),
      result("sign", { title: "Shop sign at night" }),
      result("portrait", { title: "Portrait of a baker" }),
      result("adult", { title: "Sexy cookie" }),
      result("other", { url: "https://example.org/cookie.jpg" }),
      result("ok"),
    ]);
    expect(cands.map((c) => c.id)).toEqual(["ok", "other"]);
  });
  it("relaxes over-precise queries", () => {
    expect(relaxedQueries("black hoodie flat lay")).toEqual(["black hoodie flat lay", "black hoodie"]);
    expect(relaxedQueries("cookie dough on wooden table")).toEqual(["cookie dough on wooden table", "cookie dough"]);
    expect(relaxedQueries("chocolate chip cookies")).toEqual(["chocolate chip cookies", "chocolate chip"]);
  });
  it("resolves slots with the vision pick, never repeats a photo, skips dead links, caches searches", async () => {
    const dir = tmp();
    const net = fakeFetch(
      { "cookies hero": [result("h1"), result("h2")], "cookie close": [result("h2"), result("dead"), result("p2")] },
      { dead: ["https://live.staticflickr.com/1/dead_b.jpg"] },
    );
    const vision = fakeVision(1);
    const ov = new OpenverseImages({ cacheDir: dir, fetch: net.fn, vision });
    const slots = [
      { key: "hero", query: "cookies hero", aspect: "wide" as const, topic: "hero" },
      { key: "product:a", query: "cookie close", aspect: "any" as const, topic: "a" },
    ];
    const out = await ov.resolve(slots);
    expect(out["hero"]!.url).toBe("https://live.staticflickr.com/1/h2_b.jpg"); // vision picked index 1
    expect(out["product:a"]!.url).toBe("https://live.staticflickr.com/1/p2_b.jpg"); // h2 taken, "dead" redirects
    expect(Object.values(out).every((i) => DesignImage.safeParse(i).success)).toBe(true);
    expect(vision.calls[0]!.content.filter((c) => c.type === "image")).toHaveLength(2); // thumbnails sent inline
    expect(net.calls.some((c) => c.startsWith("GET https://api.openverse.org/v1/images/?") && c.includes("aspect_ratio=wide"))).toBe(true);
    const searches = () => net.calls.filter((c) => c.includes("/v1/images/?")).length;
    const before = searches();
    await ov.resolve(slots);
    expect(searches()).toBe(before); // served from the disk cache
  });
  it("searches stock-photo providers first and falls back to the plain product name", async () => {
    const stock = result("stock1", { url: "https://images.rawpixel.com/editor_1024/stock1.jpg", source: "rawpixel", license: "cc0", license_version: "1.0" });
    const net = fakeFetch({ "chocolate chip cookies@rawpixel,stocksnap": [stock], "chocolate chip cookies": [result("flickr1")] });
    const vision = fakeVision(0);
    const out = await new OpenverseImages({ fetch: net.fn, vision }).resolve([{ key: "product:a", query: "gooey cookie hero shot", aspect: "any", topic: "a", fallback: "chocolate chip cookies" }]);
    expect(out["product:a"]!.url).toBe("https://images.rawpixel.com/editor_1024/stock1.jpg");
    expect(out["product:a"]!.license).toBe("CC0 1.0");
    expect(vision.calls[0]!.content.filter((c) => c.type === "image")).toHaveLength(2); // stock first, then the general result
    const searched = net.calls.filter((c) => c.includes("/v1/images/?")).map((c) => new URL(c.slice(4)).searchParams);
    expect(searched[0]!.get("source")).toBe("rawpixel,stocksnap");
    expect(searched.some((p) => p.get("q") === "chocolate chip cookies" && !p.get("source"))).toBe(true);
  });
  it("vision says none -> no photo; vision down -> first candidate without place/sign words", async () => {
    const byQuery = { "cookies plate": [result("bakery1", { title: "Cookies at the corner bakery" }), result("plain")] };
    const none = await new OpenverseImages({ fetch: fakeFetch(byQuery).fn, vision: fakeVision(-1) }).resolve([{ key: "hero", query: "cookies plate", aspect: "wide", topic: "t" }]);
    expect(none).toEqual({});
    const down = await new OpenverseImages({ fetch: fakeFetch(byQuery).fn, vision: fakeVision("throw") }).resolve([{ key: "hero", query: "cookies plate", aspect: "wide", topic: "t" }]);
    expect(down["hero"]!.url).toBe("https://live.staticflickr.com/1/plain_b.jpg");
  });
  it("network failures and timeouts leave slots empty instead of throwing", async () => {
    const failing = (async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    expect(await new OpenverseImages({ fetch: failing }).resolve([{ key: "hero", query: "a b", aspect: "wide", topic: "t" }])).toEqual({});
    expect(await new OpenverseImages({ fetch: fakeFetch({}, { failQueries: ["a b"] }).fn }).resolve([{ key: "hero", query: "a b", aspect: "wide", topic: "t" }])).toEqual({});
    const hang = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const t0 = Date.now();
    expect(await new OpenverseImages({ fetch: hang, timeoutMs: 50 }).resolve([{ key: "hero", query: "a b", aspect: "wide", topic: "t" }])).toEqual({});
    expect(Date.now() - t0).toBeLessThan(2_000);
  });
});

describe("generateDesign", () => {
  it("never throws for a failing proposer or image resolver, and still passes the schema", async () => {
    const d = await generateDesign(mayaInput(), {
      proposer: { name: "broken", propose: async () => Promise.reject(new Error("boom")) },
      images: { resolve: async () => Promise.reject(new Error("down")) },
    });
    expect(StorefrontDesign.safeParse(d).success).toBe(true);
    expect(d.notes[0]).toMatch(/unavailable/);
  });
  it("puts resolved photos into the hero, banner and product slots", async () => {
    const photo = toDesignImage(result("x"), "x")!;
    const images: ImageResolver = { resolve: async (slots) => Object.fromEntries(slots.map((s) => [s.key, { ...photo, url: `https://live.staticflickr.com/${s.key.replace(":", "_")}.jpg` }])) };
    const d = await generateDesign(mayaInput(), { proposer: { name: "p", propose: async () => ({ style: "bold", hero: { layout: "fullbleed" } }) }, images });
    expect(d.style).toBe("bold");
    expect(d.hero.layout).toBe("fullbleed");
    expect(d.hero.image?.url).toMatch(/hero/);
    expect(Object.keys(d.productImages).sort()).toEqual(["cookie_box6", "cookie_single", "sea_salt"]);
  });
});

// ---------- routes ----------

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

function routes(o: { images?: ImageResolver; waitMs?: number } = {}) {
  const dir = tmp();
  const accounts = new AccountStore(dir);
  const app = new Hono();
  registerAccountRoutes(app, {
    store: accounts,
    businessIdTaken: () => false,
    businessExists: () => true,
    createOwnerGrant: async () => undefined,
    clientKey: () => "t",
    limits: { perClient: new RateLimiter(1000, 60_000), global: new RateLimiter(10_000, 60_000) },
  });
  const cfg = mayaConfig();
  const live: Record<string, Configuration> = { "maya-cookies": cfg };
  const photo = toDesignImage(result("gen"), "x")!;
  const designs = new DesignStore(dir);
  const service = new DesignService(designs, { images: o.images ?? { resolve: async (slots) => Object.fromEntries(slots.map((s) => [s.key, { ...photo, url: `https://live.staticflickr.com/${s.key.replace(":", "_")}.jpg` }])) } });
  const media = new MediaStore(dir);
  registerStorefrontRoutes(app, { service, media, activeConfig: (id) => live[id], gate: businessGate(accounts), mediaBaseUrl: "http://brain.test", ...(o.waitMs !== undefined ? { waitMs: o.waitMs } : {}) });
  const owner = accounts.newSession(accounts.create("maya@example.com", "correct horse", { id: "maya-cookies", name: "Maya's Cookies" }).id);
  const eve = accounts.newSession(accounts.create("eve@example.com", "correct horse", { id: "evil", name: "Evil" }).id);
  const call = async (method: string, url: string, o: { token?: string; json?: unknown; form?: FormData } = {}) => {
    const headers: Record<string, string> = {};
    if (o.token) headers["authorization"] = `Bearer ${o.token}`;
    if (o.json !== undefined) headers["content-type"] = "application/json";
    const r = await app.request(url, { method, headers, ...(o.form ? { body: o.form } : o.json !== undefined ? { body: JSON.stringify(o.json) } : {}) });
    const type = r.headers.get("content-type") ?? "";
    return { status: r.status, headers: r.headers, body: (type.includes("json") ? await r.json() : await r.arrayBuffer()) as any };
  };
  const form = (bytes: Uint8Array, name = "p.png", type = "image/png") => {
    const f = new FormData();
    f.set("file", new File([bytes as Uint8Array<ArrayBuffer>], name, { type }));
    return f;
  };
  return { app, call, owner, eve, designs, media, dir, form };
}

describe("storefront routes", () => {
  it("public GET of a live business with no design serves the default and generates one in the background; 404 for unknown businesses", async () => {
    const h = routes();
    const r = await h.call("GET", "/storefront/maya-cookies/design");
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(StorefrontDesign.safeParse(r.body).success).toBe(true);
    expect(r.body).toMatchObject({ businessId: "maya-cookies", generator: "default (deterministic)", hero: { image: null } });
    await vi.waitFor(() => expect(h.designs.get("maya-cookies")).toBeDefined());
    const again = await h.call("GET", "/storefront/maya-cookies/design");
    expect(again.headers.get("cache-control")).toBe("public, max-age=15");
    expect(again.body.hero.image?.url).toMatch(/hero/);
    expect((await h.call("GET", "/storefront/nobody/design")).status).toBe(404);
    expect((await h.call("GET", "/storefront/Bad%20Slug/design")).status).toBe(404);
  });

  it("gated routes: 401 without a session, 403 for another account's business", async () => {
    const h = routes();
    const attempts: [string, string, { json?: unknown; form?: FormData }][] = [
      ["POST", "/storefront/maya-cookies/design/regenerate", { json: {} }],
      ["PATCH", "/storefront/maya-cookies/design", { json: { hero: { title: "Hacked" } } }],
      ["POST", "/storefront/maya-cookies/images/hero", { form: h.form(PNG) }],
      ["DELETE", "/storefront/maya-cookies/images/hero", {}],
    ];
    for (const [m, u, o] of attempts) {
      expect((await h.call(m, u, o)).status).toBe(401);
      expect((await h.call(m, `${u}?businessId=evil`, { ...o, token: h.eve })).status).toBe(403);
    }
    expect(h.designs.get("maya-cookies")).toBeUndefined();
  });

  it("regenerate saves a full design; the public GET then serves it", async () => {
    const h = routes();
    const r = await h.call("POST", "/storefront/maya-cookies/design/regenerate", { token: h.owner, json: { style: "bold" } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ style: "bold", hero: { image: { source: "openverse" } } });
    expect((await h.call("GET", "/storefront/maya-cookies/design")).body.style).toBe("bold");
    expect((await h.call("POST", "/storefront/maya-cookies/design/regenerate", { token: h.owner, json: { style: "neon" } })).status).toBe(400);
    expect((await h.call("POST", "/storefront/evil/design/regenerate", { token: h.eve, json: {} })).status).toBe(409); // not live
  });

  it("PATCH applies valid edits and rejects bad input with reasons", async () => {
    const h = routes();
    const ok = await h.call("PATCH", "/storefront/maya-cookies/design", { token: h.owner, json: { hero: { cta: "Order now" }, corners: "soft" } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ hero: { cta: "Order now" }, corners: "soft" });
    expect(h.designs.get("maya-cookies")?.hero.cta).toBe("Order now");
    for (const json of [
      { palette: { primary: "red" } },
      { fonts: { display: "Comic Sans" } },
      { announcement: "Free cookies today" },
      { productImages: {} },
      { hero: { title: 42 } },
    ]) {
      const r = await h.call("PATCH", "/storefront/maya-cookies/design", { token: h.owner, json });
      expect(r.status, JSON.stringify(json)).toBe(400);
      expect(r.body.reasons.length).toBeGreaterThan(0);
    }
    expect(h.designs.get("maya-cookies")?.hero.cta).toBe("Order now"); // nothing changed by the refusals
  });

  it("a slow regenerate answers 202 and the owner polls /design/status (gated) until it lands", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = routes({ images: { resolve: async () => (await gate, {}) }, waitMs: 20 });
    const r = await h.call("POST", "/storefront/maya-cookies/design/regenerate", { token: h.owner, json: {} });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ status: "running" });
    expect((await h.call("POST", "/storefront/maya-cookies/design/regenerate", { token: h.owner, json: {} })).status).toBe(409);
    expect((await h.call("GET", "/storefront/maya-cookies/design/status")).status).toBe(401);
    expect((await h.call("GET", "/storefront/maya-cookies/design/status", { token: h.eve })).status).toBe(403);
    expect((await h.call("GET", "/storefront/maya-cookies/design/status", { token: h.owner })).body).toMatchObject({ running: true, error: null, generatedAt: null });
    release();
    await vi.waitFor(async () => expect((await h.call("GET", "/storefront/maya-cookies/design/status", { token: h.owner })).body.running).toBe(false));
    expect((await h.call("GET", "/storefront/maya-cookies/design/status", { token: h.owner })).body.generatedAt).toEqual(expect.any(String));
  });

  it("uploads: sniffed images only, at most 6 MB; served from /media; DELETE removes them; regenerate keeps them", async () => {
    const h = routes();
    expect((await h.call("POST", "/storefront/maya-cookies/images/hero", { token: h.owner, form: h.form(new TextEncoder().encode("<svg onload=alert(1)>"), "x.png") })).status).toBe(415);
    const big = new Uint8Array(6 * 1024 * 1024 + 100 * 1024);
    big.set(PNG);
    expect((await h.call("POST", "/storefront/maya-cookies/images/hero", { token: h.owner, form: h.form(big) })).status).toBe(413);
    expect((await h.call("POST", "/storefront/maya-cookies/images/product:nope", { token: h.owner, form: h.form(PNG) })).status).toBe(404);
    expect((await h.call("POST", "/storefront/maya-cookies/images/sidebar", { token: h.owner, form: h.form(PNG) })).status).toBe(400);

    const up = await h.call("POST", "/storefront/maya-cookies/images/product:cookie_single", { token: h.owner, form: h.form(PNG) });
    expect(up.status).toBe(200);
    const img = up.body.productImages.cookie_single as DesignImage;
    expect(img).toMatchObject({ source: "upload", credit: "Photo from the owner", license: "", creditUrl: null, alt: "Chocolate chip cookie" });
    expect(img.url).toMatch(/^http:\/\/brain\.test\/media\/[A-Za-z0-9_-]{22}\.png$/);
    const file = img.url.split("/media/")[1]!;
    const served = await h.call("GET", `/media/${file}`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("cache-control")).toMatch(/immutable/);
    expect(new Uint8Array(served.body)).toEqual(PNG);
    expect((await h.call("GET", "/media/..%2Faccounts.json")).status).toBe(404);

    const regen = await h.call("POST", "/storefront/maya-cookies/design/regenerate", { token: h.owner, json: {} });
    expect(regen.body.productImages.cookie_single).toEqual(img); // the owner's photo beats a generated one
    expect(regen.body.productImages.cookie_box6.source).toBe("openverse");

    const del = await h.call("DELETE", "/storefront/maya-cookies/images/product:cookie_single", { token: h.owner });
    expect(del.status).toBe(200);
    expect(del.body.productImages.cookie_single).toBeUndefined();
    expect((await h.call("GET", `/media/${file}`)).status).toBe(404);
  });
});

describe("stores", () => {
  it("sniffs jpeg, png and webp by magic bytes only", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xdb]))).toBe("jpg");
    expect(sniffImage(PNG)).toBe("png");
    expect(sniffImage(new TextEncoder().encode("RIFF\0\0\0\0WEBPVP8 "))).toBe("webp");
    expect(sniffImage(new TextEncoder().encode("GIF89a"))).toBeUndefined();
    expect(sniffImage(new TextEncoder().encode("<html>"))).toBeUndefined();
  });
  it("activeConfigReader returns the parsed active configuration only", () => {
    const json = JSON.stringify(maya);
    const read = activeConfigReader({
      business: (id) => (id === "maya-cookies" ? { id, name: "Maya", activeConfigId: 7n } : id === "new" ? { id, name: "New", activeConfigId: 0n } : undefined),
      configVersions: () => [{ id: 7n, version: 1, status: "active", json }],
    });
    expect(read("maya-cookies")?.business.name).toBe("Maya's Cookies");
    expect(read("new")).toBeUndefined();
    expect(read("missing")).toBeUndefined();
  });
});
