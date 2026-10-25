import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AccountStore, businessGate, GATED_PATHS } from "../src/accounts";
import { BASE_IDS, BASE_LINKS, isOfficialHost, LegalStore, linkWorks, mountLegal, normalizeState, officialUrl, profileFromConfig, profileFromSpec, type FetchLike, type LegalProfile } from "../src/legal";
import type { Llm, ToolRequest } from "../src/llm";
import { guess, mayaTestSpec } from "./fixtures/maya-spec.TEST";
import { parseConfiguration } from "@napkin/schema";

class FakeLlm implements Llm {
  calls: ToolRequest[] = [];
  constructor(private readonly handler: (r: ToolRequest, n: number) => unknown) {}
  async tool(r: ToolRequest) {
    this.calls.push(r);
    return this.handler(r, this.calls.length);
  }
  async text() {
    return "";
  }
}

const FOOD = {
  items: [
    { key: "Food Handler Card", title: "Get a food handler card", why: "Most places require people who handle food for sale to take a short food safety course.", who: "Texas Department of State Health Services", appliesBecause: "you bake cookies to sell", howToFind: 'Search "Texas food handler card"', link: "https://www.dshs.texas.gov/food-handlers" },
    { key: "cottage-food", title: "Check the cottage food rules", why: "Home bakers can usually sell some foods without a commercial kitchen if they follow labeling rules.", who: "your state health department", appliesBecause: "you bake at home", howToFind: 'Search "Texas cottage food law"', link: "http://www.dshs.texas.gov/cottage" },
    { key: "health-permit", title: "Ask about a health permit", why: "Selling food to the public often needs a permit from the local health department.", who: "your county health department", appliesBecause: "you sell food", howToFind: 'Search "Austin food permit"', link: "https://foodpermits.example.com/austin" },
    { key: "fire-inspection", title: "Schedule a fire inspection", why: "Some cities inspect food businesses for fire safety before opening.", who: "your city fire marshal", appliesBecause: "you sell food", howToFind: 'Search "Austin fire inspection"', link: "https://www.austintexas.gov/dead-page" },
    // duplicates of base items are dropped
    { key: "ein", title: "Get an EIN", why: "You need a federal tax id for your business.", who: "IRS", appliesBecause: "every business", howToFind: "Search EIN" },
    { key: "business-license-2", title: "Get your state and local business licenses and permits", why: "Duplicate of the base item with another key.", who: "city", appliesBecause: "every business", howToFind: "Search license" },
  ],
};

/** dshs.texas.gov answers; the austintexas.gov page is dead; anything else would be a test bug. */
function fakeFetch(log: string[] = []): FetchLike {
  return async (url, init) => {
    log.push(`${init.method} ${url}`);
    if (url.startsWith("https://www.dshs.texas.gov/")) return { status: init.method === "HEAD" ? 405 : 200, url };
    if (url.startsWith("https://www.austintexas.gov/")) return { status: 404, url };
    throw new Error(`unexpected fetch ${url}`);
  };
}

const COOKIES: LegalProfile = { name: "Sam's Cookies", oneLiner: "Home-baked cookies", offerings: ["Chocolate chip cookie"], fulfillment: "pickup" };

function harness(o: { llm?: Llm | null; profiles?: Record<string, LegalProfile>; fetchLog?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-legal-"));
  const accounts = new AccountStore(dir);
  const store = new LegalStore(dir);
  const llm = o.llm === null ? undefined : (o.llm ?? new FakeLlm(() => FOOD));
  const app = new Hono();
  const gate = businessGate(accounts);
  for (const p of GATED_PATHS) app.use(p, gate);
  const profiles = o.profiles ?? { "sams-cookies": COOKIES };
  mountLegal(app, { store, llm, profile: (id) => profiles[id], fetchImpl: fakeFetch(o.fetchLog), linkTimeoutMs: 100 });
  const sam = accounts.create("sam@example.com", "correct horse", { id: "sams-cookies", name: "Sam's Cookies" });
  const other = accounts.create("eve@example.com", "correct horse", { id: "eves-tacos", name: "Eve's Tacos" });
  const tokens = { sam: accounts.newSession(sam.id), eve: accounts.newSession(other.id) };
  const call = async (method: string, url: string, body?: unknown, token: string | null = tokens.sam) => {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await app.request(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  return { dir, store, llm, call, tokens };
}

const ids = (b: Record<string, any>) => (b.items as { id: string }[]).map((i) => i.id);

describe("legal checklist: base items", () => {
  it("GET returns the base items before anything is generated, with the disclaimer and progress", async () => {
    const h = harness();
    const r = await h.call("GET", "/legal/sams-cookies");
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([...BASE_IDS]);
    expect(r.body.items.every((i: { base: boolean; status: string }) => i.base && i.status === "todo")).toBe(true);
    expect(r.body.items.find((i: { id: string }) => i.id === "ein").link).toBe(BASE_LINKS.ein);
    expect(r.body.counts).toEqual({ total: 6, done: 0, notNeeded: 0, todo: 6 });
    expect(r.body.disclaimer).toMatch(/not legal advice/);
    expect(r.body).toMatchObject({ generated: false, needsLocation: true, knowsBusiness: true, aiAvailable: true });
  });

  it("every base link is an https government page", () => {
    for (const u of Object.values(BASE_LINKS)) expect(officialUrl(u)?.toString().split("#")[0]).toBe(u.split("#")[0]);
  });
});

describe("legal checklist: generate", () => {
  it("asks for the location first when it is unknown, and never calls the model", async () => {
    const h = harness();
    const r = await h.call("POST", "/legal/sams-cookies/generate", {});
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/city and state/);
    expect((h.llm as FakeLlm).calls).toHaveLength(0);
  });

  it("POST location remembers city/state (not in the spec) without calling the model", async () => {
    const h = harness();
    await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "done" });
    const r = await h.call("POST", "/legal/sams-cookies/location", { city: "  Austin ", state: "tx" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ location: { city: "Austin", state: "TX" }, needsLocation: false, generated: false, locationText: "Austin, Texas" });
    expect(r.body.items.find((i: { id: string }) => i.id === "ein").status).toBe("done");
    expect((h.llm as FakeLlm).calls).toHaveLength(0);
    expect((await h.call("POST", "/legal/sams-cookies/location", { city: "Austin" })).status).toBe(400);
  });

  it("validates city/state", async () => {
    const h = harness();
    expect((await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin" })).status).toBe(400);
    expect((await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "Narnia" })).status).toBe(400);
    expect((await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX", extra: 1 })).status).toBe(400);
  });

  it("merges tailored items after the base items; drops duplicate, non-https, non-.gov and dead links", async () => {
    const fetchLog: string[] = [];
    const h = harness({ fetchLog });
    const r = await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "texas" });
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([...BASE_IDS, "food-handler-card", "cottage-food", "health-permit", "fire-inspection"]);
    const by = Object.fromEntries((r.body.items as any[]).map((i) => [i.id, i]));
    expect(by["food-handler-card"]).toMatchObject({ base: false, status: "todo", link: "https://www.dshs.texas.gov/food-handlers", appliesBecause: "you bake cookies to sell" });
    expect(by["cottage-food"].link).toBeUndefined(); // http
    expect(by["health-permit"].link).toBeUndefined(); // not a government host
    expect(by["fire-inspection"].link).toBeUndefined(); // 404
    for (const id of ["cottage-food", "health-permit", "fire-inspection"]) expect(by[id].howToFind).toBeTruthy();
    // only official https links were fetched; HEAD refused (405) falls back to GET
    expect(fetchLog).toEqual(expect.arrayContaining(["HEAD https://www.dshs.texas.gov/food-handlers", "GET https://www.dshs.texas.gov/food-handlers", "HEAD https://www.austintexas.gov/dead-page"]));
    expect(fetchLog.some((l) => l.includes("example.com") || l.startsWith("HEAD http://"))).toBe(false);
    expect(r.body).toMatchObject({ generated: true, generatedFor: "Austin, Texas", location: { city: "Austin", state: "TX" }, locationSource: "owner", needsLocation: false });
    // the model saw only the profile facts and the location
    const prompt = ((h.llm as FakeLlm).calls[0]!.content[0] as { text: string }).text;
    expect(prompt).toContain("Location: Austin, Texas");
    expect(prompt).toContain("Sells: Chocolate chip cookie");
    // persisted at <dataDir>/legal/<businessId>.json
    const saved = JSON.parse(fs.readFileSync(path.join(h.dir, "legal", "sams-cookies.json"), "utf8"));
    expect(saved.items).toHaveLength(10);
    expect(saved.location).toEqual({ city: "Austin", state: "TX" });
  });

  it("uses a confirmed spec location without asking, and refuses when Napkin doesn't know the business", async () => {
    const h = harness({ profiles: { "sams-cookies": { ...COOKIES, location: "Portland, OR" }, "eves-tacos": { offerings: [] } } });
    const g = await h.call("GET", "/legal/sams-cookies");
    expect(g.body).toMatchObject({ needsLocation: false, locationText: "Portland, OR", locationSource: "business" });
    const r = await h.call("POST", "/legal/sams-cookies/generate", {});
    expect(r.status).toBe(200);
    expect(r.body.generatedFor).toBe("Portland, OR");
    const e = await h.call("POST", "/legal/eves-tacos/generate", { city: "Austin", state: "TX" }, h.tokens.eve);
    expect(e.status).toBe(409);
    expect(e.body.error).toMatch(/sells/);
  });

  it("without an API key the base items still work and generate says so", async () => {
    const h = harness({ llm: null });
    const r = await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX" });
    expect(r.status).toBe(503);
    const g = await h.call("GET", "/legal/sams-cookies");
    expect(g.body).toMatchObject({ aiAvailable: false, generated: false, location: { city: "Austin", state: "TX" } });
    expect(ids(g.body)).toEqual([...BASE_IDS]);
    expect(g.body.items.find((i: { id: string }) => i.id === "licenses-permits").howToFind).toContain("Austin, TX");
  });

  it("retries once on invalid model output, then reports a 502", async () => {
    const once = harness({ llm: new FakeLlm((_r, n) => (n === 1 ? { items: [{ title: "x" }] } : FOOD)) });
    expect((await once.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX" })).status).toBe(200);
    const never = harness({ llm: new FakeLlm(() => ({ nope: true })) });
    const r = await never.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX" });
    expect(r.status).toBe(502);
  });

  it("regenerate keeps statuses and notes of items whose id survives", async () => {
    let round = 1;
    const h = harness({ llm: new FakeLlm(() => (round === 1 ? FOOD : { items: [FOOD.items[0], { key: "mobile-vendor-permit", title: "Get a mobile vendor permit", why: "Selling from a cart or truck usually needs its own permit.", who: "your city", appliesBecause: "if you sell from a cart", howToFind: 'Search "Austin mobile vendor permit"' }] })) });
    await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX" });
    await h.call("PATCH", "/legal/sams-cookies/items/food-handler-card", { status: "done", note: "card #123 in the drawer" });
    await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "not_needed" });
    await h.call("PATCH", "/legal/sams-cookies/items/cottage-food", { status: "done" });
    round = 2;
    const r = await h.call("POST", "/legal/sams-cookies/generate", {});
    expect(r.status).toBe(200);
    expect(ids(r.body)).toEqual([...BASE_IDS, "food-handler-card", "mobile-vendor-permit"]);
    const by = Object.fromEntries((r.body.items as any[]).map((i) => [i.id, i]));
    expect(by["food-handler-card"]).toMatchObject({ status: "done", note: "card #123 in the drawer" });
    expect(by["ein"].status).toBe("not_needed");
    expect(by["mobile-vendor-permit"].status).toBe("todo");
    expect(r.body.counts).toEqual({ total: 8, done: 1, notNeeded: 1, todo: 6 });
    expect(r.body.generatedFor).toBe("Austin, Texas"); // the stored location was reused
  });
});

describe("legal checklist: PATCH", () => {
  it("updates status and note, clears a note, and validates", async () => {
    const h = harness();
    const a = await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "done", note: "  got it in May " });
    expect(a.status).toBe(200);
    expect(a.body.items.find((i: { id: string }) => i.id === "ein")).toMatchObject({ status: "done", note: "got it in May" });
    expect(a.body.counts.done).toBe(1);
    const b = await h.call("PATCH", "/legal/sams-cookies/items/ein", { note: "" });
    expect(b.body.items.find((i: { id: string }) => i.id === "ein").note).toBeUndefined();
    expect(b.body.items.find((i: { id: string }) => i.id === "ein").status).toBe("done");
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "maybe" })).status).toBe(400);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", {})).status).toBe(400);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "done", extra: true })).status).toBe(400);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", { note: "x".repeat(501) })).status).toBe(400);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/no-such-item", { status: "done" })).status).toBe(404);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/BAD_ID", { status: "done" })).status).toBe(400);
  });
});

describe("legal checklist: account gate", () => {
  it("refuses signed-out callers and other accounts on every route", async () => {
    const h = harness();
    expect((await h.call("GET", "/legal/sams-cookies", undefined, null)).status).toBe(401);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "done" }, null)).status).toBe(401);
    expect((await h.call("GET", "/legal/sams-cookies", undefined, h.tokens.eve)).status).toBe(403);
    expect((await h.call("POST", "/legal/sams-cookies/generate", { city: "Austin", state: "TX" }, h.tokens.eve)).status).toBe(403);
    expect((await h.call("PATCH", "/legal/sams-cookies/items/ein", { status: "done" }, h.tokens.eve)).status).toBe(403);
    // the owner's own id elsewhere in the request does not unlock another business
    expect((await h.call("GET", "/legal/sams-cookies?businessId=eves-tacos", undefined, h.tokens.eve)).status).toBe(400);
    expect((await h.call("POST", "/legal/sams-cookies/generate?businessId=eves-tacos", { city: "Austin", state: "TX" }, h.tokens.eve)).status).toBe(400);
    expect((await h.call("GET", "/legal/sams-cookies")).body.counts.done).toBe(0);
    expect((h.llm as FakeLlm).calls).toHaveLength(0);
    expect(fs.existsSync(path.join(h.dir, "legal", "sams-cookies.json"))).toBe(false);
  });
});

describe("legal checklist: helpers", () => {
  it("official hosts", () => {
    for (const h of ["www.irs.gov", "sba.gov", "www.dshs.texas.gov", "co.travis.tx.us", "www.ci.austin.tx.us", "dshs.state.tx.us"]) expect(isOfficialHost(h)).toBe(true);
    for (const h of ["irs.gov.evil.com", "govtrack.us", "example.com", "texas.gov.example.org", "foo.tx.us"]) expect(isOfficialHost(h)).toBe(false);
    expect(officialUrl("http://www.irs.gov/")).toBeUndefined();
    expect(officialUrl("https://user@www.irs.gov/")).toBeUndefined();
    expect(officialUrl("not a url")).toBeUndefined();
  });

  it("linkWorks: 2xx/3xx pass, errors/timeouts and redirects off government hosts fail", async () => {
    const ok: FetchLike = async (url) => ({ status: 301, url });
    const off: FetchLike = async () => ({ status: 200, url: "https://parked.example.com/" });
    const boom: FetchLike = async () => {
      throw new Error("timeout");
    };
    expect(await linkWorks("https://www.irs.gov/x", ok)).toBe(true);
    expect(await linkWorks("https://www.irs.gov/x", off)).toBe(false);
    expect(await linkWorks("https://www.irs.gov/x", boom)).toBe(false);
  });

  it("normalizeState", () => {
    expect(normalizeState("tx")).toBe("TX");
    expect(normalizeState(" New York ")).toBe("NY");
    expect(normalizeState("D.C.")).toBe("DC");
    expect(normalizeState("Ontario")).toBeUndefined();
  });

  it("profiles carry only real facts: guessed locations and placeholder config fields are dropped", () => {
    const spec = mayaTestSpec();
    spec.business.location = guess("Los Angeles, CA");
    const p = profileFromSpec(spec);
    expect(p.location).toBeUndefined();
    expect(p.oneLiner).toBe("Fresh chocolate chip cookies, pickup only.");
    expect(p.offerings.length).toBeGreaterThan(0);
    const cfg = parseConfiguration(JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../fixtures/maya/configuration.json"), "utf8")));
    const c = profileFromConfig(cfg);
    expect(c.hours).toBeUndefined(); // "TBD (placeholder)" is listed as unconfirmed
    expect(c.pickupLocation).toBeUndefined();
    expect(c.oneLiner).toBe("Fresh chocolate chip cookies, pickup only.");
    expect(c.offerings.length).toBeGreaterThan(0);
  });
});
