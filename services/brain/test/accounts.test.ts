import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { AccountStore, businessGate, ensureSeedAccount, GATED_PATHS, hashPassword, registerAccountRoutes, slugify, verifyPassword } from "../src/accounts";
import { RateLimiter } from "../src/auth";

function harness(opts: { live?: string[]; taken?: string[]; perClient?: number } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-accounts-"));
  const store = new AccountStore(dir);
  const live = new Set(opts.live ?? []);
  const grants: { code: string; businessId: string }[] = [];
  const app = new Hono();
  registerAccountRoutes(app, {
    store,
    businessIdTaken: (id) => live.has(id) || (opts.taken ?? []).includes(id),
    businessExists: (id) => live.has(id),
    createOwnerGrant: async (g) => void grants.push(g),
    clientKey: () => "test",
    limits: { perClient: new RateLimiter(opts.perClient ?? 1000, 60_000), global: new RateLimiter(10_000, 60_000) },
  });
  const gate = businessGate(store);
  for (const p of GATED_PATHS) app.use(p, gate);
  // stand-ins for the real setup routes: they echo the businessId they would act on
  app.post("/intake/photo", async (c) => c.json({ ok: true, businessId: (await c.req.parseBody())["businessId"] }));
  app.post("/compile", async (c) => c.json({ ok: true, businessId: ((await c.req.json()) as { businessId: string }).businessId }));
  app.get("/questions/next", (c) => c.json({ ok: true, businessId: c.req.query("businessId") }));
  app.get("/spec/:businessId", (c) => c.json({ ok: true, businessId: c.req.param("businessId") }));
  app.get("/intake/photo/:businessId", (c) => c.json({ ok: true, businessId: c.req.param("businessId") }));

  const call = async (method: string, url: string, body?: unknown, token?: string, form?: FormData) => {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const r = await app.request(url, { method, headers, ...(form ? { body: form } : body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const signup = async (email = "sam@example.com", password = "correct horse") => (await call("POST", "/accounts/signup", { email, password })).body as { token: string; account: { id: string } };
  return { store, live, grants, call, signup, dir };
}

describe("passwords and slugs", () => {
  it("scrypt hashes verify only the right password and never store it", () => {
    const h = hashPassword("s3cret-password");
    expect(h).not.toContain("s3cret");
    expect(verifyPassword("s3cret-password", h)).toBe(true);
    expect(verifyPassword("s3cret-passwordX", h)).toBe(false);
    expect(hashPassword("same")).not.toBe(hashPassword("same")); // salted
  });
  it("slugify makes url-safe business ids", () => {
    expect(slugify("Maya's Cookies!")).toBe("mayas-cookies");
    expect(slugify("  Café Olé  ")).toBe("cafe-ole");
    expect(slugify("!!!")).toBe("shop");
  });
});

describe("account routes", () => {
  it("signup -> me -> name the business; one business per account", async () => {
    const h = harness();
    const { token, account } = await h.signup();
    expect(token.length).toBeGreaterThan(30);
    const me = await h.call("GET", "/accounts/me", undefined, token);
    expect(me.body).toMatchObject({ account: { id: account.id, email: "sam@example.com", businessId: null }, businessLive: false });
    const b = await h.call("POST", "/accounts/business", { name: "Sam's Tacos" }, token);
    expect(b.status).toBe(201);
    expect(b.body.account).toMatchObject({ businessId: "sams-tacos", businessName: "Sam's Tacos" });
    const again = await h.call("POST", "/accounts/business", { name: "Second Shop" }, token);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/one business per account/);
  });
  it("picks a free id when the name is taken by another account or an existing business", async () => {
    const h = harness({ live: ["maya-cookies"] });
    const a = await h.signup("a@example.com");
    const b = await h.signup("b@example.com");
    const c = await h.signup("c@example.com");
    expect((await h.call("POST", "/accounts/business", { name: "Maya Cookies" }, a.token)).body.account.businessId).toBe("maya-cookies-2");
    expect((await h.call("POST", "/accounts/business", { name: "Maya Cookies" }, b.token)).body.account.businessId).toBe("maya-cookies-3");
    expect((await h.call("POST", "/accounts/business", { name: "Tacos" }, c.token)).body.account.businessId).toBe("tacos");
  });
  it("login checks the password; duplicate emails and short passwords are refused", async () => {
    const h = harness();
    await h.signup("Sam@Example.com", "correct horse");
    expect((await h.call("POST", "/accounts/signup", { email: "sam@example.com", password: "another one" })).status).toBe(409);
    expect((await h.call("POST", "/accounts/signup", { email: "new@example.com", password: "short" })).status).toBe(400);
    expect((await h.call("POST", "/accounts/login", { email: "sam@example.com", password: "wrong horse" })).status).toBe(401);
    expect((await h.call("POST", "/accounts/login", { email: "nobody@example.com", password: "whatever1" })).status).toBe(401);
    const ok = await h.call("POST", "/accounts/login", { email: "SAM@example.com", password: "correct horse" });
    expect(ok.status).toBe(200);
    expect((await h.call("GET", "/accounts/me", undefined, ok.body.token)).status).toBe(200);
  });
  it("logout ends the session; unknown tokens are 401", async () => {
    const h = harness();
    const { token } = await h.signup();
    await h.call("POST", "/accounts/logout", undefined, token);
    expect((await h.call("GET", "/accounts/me", undefined, token)).status).toBe(401);
    expect((await h.call("GET", "/accounts/me", undefined, "x".repeat(43))).status).toBe(401);
  });
  it("owner grant only for the account's own business, and only once it is live", async () => {
    const h = harness();
    const { token } = await h.signup();
    expect((await h.call("POST", "/accounts/owner-grant", undefined, token)).status).toBe(409);
    await h.call("POST", "/accounts/business", { name: "Tacos" }, token);
    expect((await h.call("POST", "/accounts/owner-grant", undefined, token)).status).toBe(409); // not live yet
    h.live.add("tacos");
    const g = await h.call("POST", "/accounts/owner-grant", undefined, token);
    expect(g.status).toBe(200);
    expect(h.grants).toEqual([expect.objectContaining({ businessId: "tacos", code: g.body.code })]);
    expect((await h.call("POST", "/accounts/owner-grant")).status).toBe(401);
  });
  it("rate-limits signup/login attempts", async () => {
    const h = harness({ perClient: 3 });
    for (let i = 0; i < 3; i++) await h.call("POST", "/accounts/login", { email: "x@example.com", password: "whatever1" });
    expect((await h.call("POST", "/accounts/login", { email: "x@example.com", password: "whatever1" })).status).toBe(429);
  });
  it("seeds the demo account once, bound to its existing business", () => {
    const h = harness();
    const seed = { email: "maya@example.com", password: "maya-demo-pass", businessId: "maya-cookies", businessName: "Maya's Cookies" };
    ensureSeedAccount(h.store, seed);
    ensureSeedAccount(h.store, seed);
    expect(h.store.byEmail("maya@example.com")).toMatchObject({ businessId: "maya-cookies" });
    expect([...h.store.claimedBusinesses()]).toEqual(["maya-cookies"]);
  });
});

describe("business gate on the setup routes", () => {
  it("needs a session, and only lets an account touch its own business (body, multipart, query and path)", async () => {
    const h = harness();
    const sam = await h.signup("sam@example.com");
    const eve = await h.signup("eve@example.com");
    await h.call("POST", "/accounts/business", { name: "Tacos" }, sam.token);
    await h.call("POST", "/accounts/business", { name: "Evil" }, eve.token);

    expect((await h.call("POST", "/compile", { businessId: "tacos" })).status).toBe(401);
    expect((await h.call("POST", "/compile", { businessId: "tacos" }, undefined, undefined)).status).toBe(401);
    expect(await h.call("POST", "/compile", { businessId: "tacos" }, sam.token)).toMatchObject({ status: 200, body: { businessId: "tacos" } });
    expect((await h.call("POST", "/compile", { businessId: "tacos" }, eve.token)).status).toBe(403);

    const form = () => {
      const f = new FormData();
      f.set("businessId", "tacos");
      f.set("image", new File([new Uint8Array([1, 2, 3])], "n.png", { type: "image/png" }));
      return f;
    };
    expect(await h.call("POST", "/intake/photo", undefined, sam.token, form())).toMatchObject({ status: 200, body: { businessId: "tacos" } });
    expect((await h.call("POST", "/intake/photo", undefined, eve.token, form())).status).toBe(403);

    expect((await h.call("GET", "/questions/next?businessId=tacos", undefined, sam.token)).status).toBe(200);
    expect((await h.call("GET", "/questions/next?businessId=tacos", undefined, eve.token)).status).toBe(403);
    expect((await h.call("GET", "/spec/tacos", undefined, eve.token)).status).toBe(403);
    expect((await h.call("GET", "/intake/photo/tacos", undefined, sam.token)).status).toBe(200);
    expect((await h.call("GET", "/intake/photo/tacos", undefined, eve.token)).status).toBe(403);
    expect((await h.call("POST", "/compile", {}, sam.token)).status).toBe(400);
  });
});
