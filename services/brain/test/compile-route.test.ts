import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import maya from "../../../fixtures/maya/configuration.json";
import type { CompilePlatformPort, ConfigVersionView, SpecSource } from "../src/compiler/platform";
import { StubProver } from "../src/compiler/prover-port";
import { carriedRoleLimits, registerCompileRoutes } from "../src/compiler/routes";
import { parseConfiguration, type BusinessSpec } from "@napkin/schema";
import { guess, mayaTestSpec } from "./fixtures/maya-spec.TEST";

class FakeCompilePlatform implements CompilePlatformPort {
  businesses = new Map<string, { id: string; name: string; activeConfigId: bigint }>();
  versions: (ConfigVersionView & { businessId: string; proof: string })[] = [];
  owners = new Set<string>();
  calls: string[] = [];
  business(id: string) { return this.businesses.get(id); }
  configVersions(b: string) { return this.versions.filter((v) => v.businessId === b); }
  hasOwner(b: string) { return this.owners.has(b); }
  async registerBusiness(id: string, name: string) { this.calls.push(`register:${id}`); this.businesses.set(id, { id, name, activeConfigId: 0n }); }
  async submitConfiguration(businessId: string, json: string, proof: string) {
    this.calls.push(`submit:${businessId}`);
    const version = this.configVersions(businessId).reduce((m, v) => Math.max(m, v.version), 0) + 1;
    this.versions.push({ id: BigInt(this.versions.length + 1), businessId, version, status: "pending", json, proof });
  }
  async activateConfiguration(id: bigint) {
    const v = this.versions.find((x) => x.id === id)!;
    if (this.owners.has(v.businessId)) throw new Error("permission denied: owner only");
    this.calls.push(`activate:${id}`);
    v.status = "active";
    this.businesses.get(v.businessId)!.activeConfigId = id;
  }
  async awaitConfigVersion(b: string, version: number) { return this.configVersions(b).find((v) => v.version === version); }
}

const specs = (m: Record<string, BusinessSpec>): SpecSource => ({ get: async (id) => m[id] });

function parseSse(text: string) {
  return text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((b) => {
      const ev = /^event: (.*)$/m.exec(b)?.[1];
      const data = /^data: (.*)$/m.exec(b)?.[1];
      return { event: ev!, data: JSON.parse(data!) };
    });
}

async function post(app: Hono, businessId: string) {
  const res = await app.request("/compile", { method: "POST", body: JSON.stringify({ businessId }), headers: { "content-type": "application/json" } });
  expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  return parseSse(await res.text());
}

function setup(spec: BusinessSpec = mayaTestSpec()) {
  const platform = new FakeCompilePlatform();
  const app = new Hono();
  registerCompileRoutes(app, { platform, specs: specs({ "maya-cookies": spec, "new-shop": spec }), prover: new StubProver() });
  return { app, platform };
}

describe("POST /compile (SSE)", () => {
  it("existing business with an owner: v(n+1) submitted, left pending for the owner", async () => {
    const { app, platform } = setup();
    platform.businesses.set("maya-cookies", { id: "maya-cookies", name: "Maya's Cookies", activeConfigId: 1n });
    platform.versions.push({ id: 1n, businessId: "maya-cookies", version: 1, status: "active", json: JSON.stringify(maya), proof: "" });
    platform.owners.add("maya-cookies");
    const ev = await post(app, "maya-cookies");
    const steps = ev.filter((e) => e.event === "step" && e.data.status !== "running").map((e) => e.data.step);
    expect(steps).toEqual(["facts", "template", "synthesis", "proofs", "configuration", "storefront", "agents", "submit"]);
    const result = ev.at(-1)!;
    expect(result.event).toBe("result");
    expect(result.data).toMatchObject({ version: 2, status: "pending", activated: false });
    expect(platform.calls).toEqual(["submit:maya-cookies"]);
    const stored = parseConfiguration(JSON.parse(platform.versions[1]!.json));
    expect(stored.version).toBe(2);
    // refund limits the owner approved in v1 carry over
    expect(stored.roles.find((r) => r.id === "support")!.limits).toEqual({ maxRefundCents: 1500 });
    expect(JSON.parse(platform.versions[1]!.proof).balanceProof.status).toBe("skipped");
  });

  it("brand-new business with no owner: registered, submitted and bootstrap-activated", async () => {
    const { app, platform } = setup();
    const ev = await post(app, "new-shop");
    expect(ev.at(-1)!.data).toMatchObject({ version: 1, status: "active", activated: true });
    expect(platform.calls).toEqual(["register:new-shop", "submit:new-shop", "activate:1"]);
    expect(parseConfiguration(JSON.parse(platform.versions[0]!.json)).roles.find((r) => r.id === "support")!.limits).toEqual({ maxRefundCents: 0 });
  });

  it("unconfirmed money facts: error event with questions, nothing submitted", async () => {
    const s = mayaTestSpec();
    s.offerings[0]!.variants[0]!.cost = guess("0.80");
    const { app, platform } = setup(s);
    const ev = await post(app, "maya-cookies");
    const err = ev.at(-1)!;
    expect(err.event).toBe("error");
    expect(err.data.code).toBe("unconfirmed_money_facts");
    expect(err.data.questions[0].fieldPath).toBe("offerings[choc_chip_cookie].variants[cookie_single].cost");
    expect(ev.find((e) => e.data.step === "facts" && e.data.status === "failed")).toBeTruthy();
    expect(platform.calls).toEqual([]);
  });

  it("no spec yet", async () => {
    const { app } = setup();
    const ev = await post(app, "unknown-biz");
    expect(ev).toEqual([{ event: "error", data: expect.objectContaining({ code: "no_spec" }) }]);
  });

  it("latest run is replayable", async () => {
    const { app } = setup();
    await post(app, "new-shop");
    const r = (await (await app.request("/compile/new-shop/latest")).json()) as { events: unknown[] };
    expect(r.events.length).toBeGreaterThan(8);
  });

  it("carries over only well-formed owner-approved limits", () => {
    expect(carriedRoleLimits(parseConfiguration(maya))).toEqual({ maxRefundCents: { support: 1500, bookkeeper: 1500 } });
    expect(carriedRoleLimits(undefined)).toBeUndefined();
  });
});
