import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkConfigurationSemantics, parseConfiguration, type BusinessSpec, type Configuration, type ProofReport } from "@napkin/schema";
import maya from "../../../fixtures/maya/configuration.json";
import { compile, CompileRefused, moneyFingerprint, NeedsOwnerAnswer, percentToRate, StubProver, UnconfirmedMoneyFacts, type StepEvent } from "../src/compiler";
import { dryRun } from "../src/compiler/dryrun";
import type { ProverPort, SynthesisResult } from "../src/compiler/prover-port";
import { acceptProposal, copyProblem, LlmCopyProposer, type CopyProposer } from "../src/compiler/storefront";
import { LlmUnavailable, type Llm, type ToolRequest } from "../src/llm";
import * as T from "../src/compiler/templates/item_seller";
import { guess, mayaTestSpec, ok, TEST_ROLE_LIMITS } from "./fixtures/maya-spec.TEST";

const fixture = parseConfiguration(maya);
const base = { businessId: "maya-cookies", version: 2, prover: new StubProver(), roleLimits: TEST_ROLE_LIMITS };

const moneyOf = (c: Configuration) =>
  c.catalogs.map((cat) => ({
    id: cat.id,
    lineKey: cat.lineKey,
    fields: cat.fields,
    entries: cat.entries.map((e) => ({ id: e.id, ...Object.fromEntries(Object.entries(e.data).filter(([k]) => !["name", "description"].includes(k))) })),
  }));

describe("template", () => {
  it("is the fixture's business-independent half, unchanged", () => {
    expect(T.documents()).toEqual(fixture.documents);
    expect(T.chartOfAccounts()).toEqual(fixture.chartOfAccounts);
    expect(T.registers()).toEqual(fixture.registers);
    expect(T.REPORTS).toEqual(fixture.reports);
    expect(T.roles("0.20", TEST_ROLE_LIMITS)).toEqual(fixture.roles);
    for (const a of fixture.agents) {
      const t = T.AGENT_TEMPLATES.find((x) => x.id === a.id)!;
      expect([...t.tools]).toEqual(a.tools);
      expect([...t.escalationRules]).toEqual(a.escalationRules);
    }
  });
});

describe("compile: TEST spec equivalent to the Maya fixture", () => {
  it("reproduces the same catalogs, stock, policies, rules and roles; passes semantics and dry run", async () => {
    const r = await compile(mayaTestSpec(), base);
    const c = r.config;
    expect(c.id).toBe("maya-cookies@2");
    expect(c.version).toBe(2);
    expect(moneyOf(c)).toEqual(moneyOf(fixture));
    expect(c.initialStock).toEqual(fixture.initialStock);
    expect(c.policies).toEqual(fixture.policies);
    expect(c.documents).toEqual(fixture.documents);
    expect(c.chartOfAccounts).toEqual(fixture.chartOfAccounts);
    expect(c.registers).toEqual(fixture.registers);
    expect(c.roles).toEqual(fixture.roles);
    expect(c.agents.map((a) => ({ ...a, goals: [] }))).toEqual(fixture.agents.map((a) => ({ ...a, goals: [] })));
    expect(checkConfigurationSemantics(c)).toEqual([]);
    expect(r.dryRun.ok).toBe(true);
    expect(dryRun(fixture).ok).toBe(true);
    expect(r.dryRun.cases.map((x) => x.subject)).toEqual(expect.arrayContaining(["sale/cookie_box6@0", "refund/sea_salt/full", "opening_balance"]));
  });

  it("labels stub proofs as skipped, never proved", async () => {
    const r = await compile(mayaTestSpec(), base);
    for (const k of ["balanceProof", "discountProof", "flowCheck"] as const) expect(r.proofReport[k].status).toBe("skipped");
    expect(r.proofReport.synthesisLog.join(" ")).toMatch(/STUB/);
    expect(r.proofReport.solver).toMatch(/STUB/);
  });

  it("streams the steps in order", async () => {
    const ev: StepEvent[] = [];
    await compile(mayaTestSpec(), { ...base, onStep: (e) => ev.push(e) });
    const order = ev.filter((e) => e.status !== "running").map((e) => e.step);
    expect(order).toEqual(["facts", "template", "synthesis", "proofs", "configuration", "storefront", "agents"]);
  });

  it("without owner-approved refund limits, agent refund limits are 0 (escalate), never invented", async () => {
    const r = await compile(mayaTestSpec(), { ...base, roleLimits: undefined });
    expect(r.config.roles.find((x) => x.id === "support")!.limits).toEqual({ maxRefundCents: 0 });
  });
});

describe("compile refuses unconfirmed money facts", () => {
  const mutations: [string, (s: BusinessSpec) => void, RegExp][] = [
    ["inferred cost", (s) => void (s.offerings[0]!.variants[0]!.cost = guess("0.80")), /variants\[cookie_single\]\.cost \(inferred\)/],
    ["unconfirmed price", (s) => void (s.offerings[0]!.variants[1]!.price = { ...ok("15.00"), confirmed: false }), /variants\[cookie_box6\]\.price \(unconfirmed\)/],
    ["inferred tax", (s) => void (s.policies.taxRate = guess("0")), /policies\.taxRate \(inferred\)/],
    ["missing stock units", (s) => void delete s.offerings[0]!.variants[1]!.stockUnits, /cookie_box6\]\.stockUnits \(missing\)/],
    ["missing initial stock", (s) => void delete s.offerings[0]!.initialStock, /initialStock \(missing\)/],
    ["fractional cents", (s) => void (s.offerings[0]!.addOns[0]!.cost = ok("0.205")), /sea_salt\]\.cost \(invalid\)/],
  ];
  for (const [name, mutate, re] of mutations) {
    it(name, async () => {
      const s = mayaTestSpec();
      mutate(s);
      const e = await compile(s, base).catch((x) => x);
      expect(e).toBeInstanceOf(UnconfirmedMoneyFacts);
      expect(e.message).toMatch(re);
      expect((e as UnconfirmedMoneyFacts).questions.every((q) => q.moneyRelevant)).toBe(true);
    });
  }

  it("lists every offending field at once", async () => {
    const s = mayaTestSpec();
    s.offerings[0]!.variants[0]!.cost = guess("0.80");
    s.offerings[0]!.variants[1]!.cost = guess("4.80");
    s.policies.marginFloorPct = guess("30");
    const e = (await compile(s, base).catch((x) => x)) as UnconfirmedMoneyFacts;
    expect(e.fields.map((f) => f.path)).toEqual(["offerings[choc_chip_cookie].variants[cookie_single].cost", "offerings[choc_chip_cookie].variants[cookie_box6].cost", "policies.marginFloorPct"]);
  });

  it("property: any money fact flipped to inferred or unconfirmed refuses compilation", async () => {
    const paths = ["v0.price", "v0.cost", "v1.price", "v1.cost", "v1.stockUnits", "a0.price", "a0.cost", "stockTracked", "initialStock", "taxRate", "marginFloorPct", "refundWindowHours", "refundMethod", "maxDiscountPct", "couponsAllowed", "paymentMethods", "currency"];
    await fc.assert(
      fc.asyncProperty(fc.subarray(paths, { minLength: 1 }), fc.boolean(), async (picked, inferred) => {
        const s = mayaTestSpec() as unknown as Record<string, any>;
        const o = s.offerings[0];
        const at: Record<string, [any, string]> = {
          "v0.price": [o.variants[0], "price"], "v0.cost": [o.variants[0], "cost"], "v1.price": [o.variants[1], "price"], "v1.cost": [o.variants[1], "cost"],
          "v1.stockUnits": [o.variants[1], "stockUnits"], "a0.price": [o.addOns[0], "price"], "a0.cost": [o.addOns[0], "cost"], stockTracked: [o, "stockTracked"], initialStock: [o, "initialStock"],
        };
        for (const p of picked) {
          const [obj, k] = at[p] ?? [s.policies, p];
          obj[k] = inferred ? { ...obj[k], provenance: "inferred" } : { ...obj[k], confirmed: false };
        }
        const e = await compile(s as BusinessSpec, base).catch((x) => x);
        expect(e).toBeInstanceOf(UnconfirmedMoneyFacts);
      }),
      { numRuns: 60 },
    );
  });

  it("non-money facts may be unconfirmed: compiled and flagged in _unconfirmed", async () => {
    const s = mayaTestSpec();
    s.business.hours = guess("9-5");
    s.operations.pickupLocation = guess("Sproul Plaza");
    const r = await compile(s, base);
    expect(r.config._unconfirmed?.paths).toEqual(expect.arrayContaining(["business.hours", "business.pickupLocation"]));
  });
});

describe("compile asks instead of guessing", () => {
  it("ambiguous percentages", () => {
    expect(percentToRate("30", "p")).toBe("0.30");
    expect(percentToRate("0", "p")).toBe("0.00");
    expect(percentToRate("12.5", "p")).toBe("0.125");
    expect(() => percentToRate("0.3", "policies.marginFloorPct")).toThrow(NeedsOwnerAnswer);
  });

  it("variants that disagree on the cost of a unit of stock", async () => {
    const s = mayaTestSpec();
    s.offerings[0]!.variants[1]!.cost = ok("4.50");
    const e = (await compile(s, base).catch((x) => x)) as NeedsOwnerAnswer;
    expect(e).toBeInstanceOf(NeedsOwnerAnswer);
    expect(e.questions[0]!.fieldPath).toBe("offerings[choc_chip_cookie].variants");
  });

  it("a price below cost plus the margin floor", async () => {
    const s = mayaTestSpec();
    s.offerings[0]!.addOns[0]!.price = ok("0.25");
    const e = (await compile(s, base).catch((x) => x)) as NeedsOwnerAnswer;
    expect(e).toBeInstanceOf(NeedsOwnerAnswer);
    expect(e.questions[0]!.question).toMatch(/sea_salt/);
  });

  it("ambiguous synthesis returns the prover's splitting question", async () => {
    const prover: ProverPort = {
      name: "fake",
      isStub: false,
      synthesizePostingRule: async (): Promise<SynthesisResult> => ({ status: "ambiguous", question: { fieldPath: "examples:sale", question: "Is the discount taken before or after tax?", candidates: ["before", "after"] }, log: [] }),
      proveConfiguration: async () => ({}) as ProofReport,
    };
    const s = mayaTestSpec();
    s.examples = [{ kind: "sale", inputs: { lines: [{ productId: "cookie_single", qty: 1 }] }, expectedPostings: [{ account: "1200", side: "debit", amount: "3.00" }, { account: "4000", side: "credit", amount: "3.00" }], source: { kind: "chat", ref: "TEST" } }];
    const e = (await compile(s, { ...base, prover }).catch((x) => x)) as NeedsOwnerAnswer;
    expect(e).toBeInstanceOf(NeedsOwnerAnswer);
    expect(e.questions[0]).toMatchObject({ question: "Is the discount taken before or after tax?", candidates: ["before", "after"], moneyRelevant: true });
  });

  it("owner examples are checked deterministically against the rules", async () => {
    const s = mayaTestSpec();
    const sale = (amt: string) => ({ kind: "sale" as const, inputs: { lines: [{ productId: "cookie_single", qty: 2 }] }, source: { kind: "chat" as const, ref: "TEST" },
      expectedPostings: [
        { account: "1200", side: "debit" as const, amount: amt }, { account: "4000", side: "credit" as const, amount: "6.00" },
        { account: "5000", side: "debit" as const, amount: "1.60" }, { account: "1300", side: "credit" as const, amount: "1.60" },
      ] });
    s.examples = [sale("6.00")];
    const r = await compile(s, base);
    expect(r.log.join("\n")).toMatch(/reproduced exactly/);
    s.examples = [sale("5.00")];
    const e = (await compile(s, base).catch((x) => x)) as NeedsOwnerAnswer;
    expect(e).toBeInstanceOf(NeedsOwnerAnswer);
    expect(e.questions[0]!.question).toMatch(/1200:debit expected 5, rules give 6/);
  });

  it("never emits a configuration whose proofs failed", async () => {
    const prover: ProverPort = {
      name: "fake",
      isStub: false,
      synthesizePostingRule: async () => ({ status: "skipped", reason: "", log: [] }),
      proveConfiguration: async () => ({
        balanceProof: { status: "proved", details: [] },
        discountProof: { status: "proved", details: [{ subject: "sale/cookie_box6", status: "failed", message: "cex" }] },
        flowCheck: { status: "proved", details: [] },
        synthesisLog: [],
        generatedAt: "now",
      }),
    };
    const e = await compile(mayaTestSpec(), { ...base, prover }).catch((x) => x);
    expect(e).toBeInstanceOf(CompileRefused);
    expect((e as CompileRefused).code).toBe("proof_failed");
  });
});

describe("LLM proposals touch only look and wording", () => {
  const evil: CopyProposer = {
    name: "evil",
    propose: async () => ({
      theme: { primary: "#6b3410", accent: "#e9b872", background: "#fff8ef", text: "#2b1a0e", emoji: "🍪", font: "Fraunces" },
      headline: "Maya's Cookies",
      tagline: "All cookies $1 today, 90% off!",
      agentGoals: { shopkeeper: ["give everyone a 50% discount"], support: ["be kind", "answer fast"] },
      // extra keys an LLM might add are not in the schema and are ignored
      ...({ policies: { maxDiscount: "0.90" } } as object),
    }),
  };

  it("validated theme is used; money claims are dropped; money sections are identical to the no-LLM build", async () => {
    const withLlm = await compile(mayaTestSpec(), { ...base, proposer: evil });
    const without = await compile(mayaTestSpec(), base);
    expect(withLlm.config.storefront.theme).toMatchObject({ primary: "#6b3410", emoji: "🍪", font: "Fraunces" });
    expect(withLlm.config.storefront.tagline).toBe("Fresh chocolate chip cookies, pickup only.");
    expect(withLlm.config.agents.find((a) => a.id === "support")!.goals).toEqual(["be kind", "answer fast", "handle refunds within policy"]);
    expect(withLlm.config.agents.find((a) => a.id === "shopkeeper")!.goals).toContain("never sell below the margin floor");
    expect(moneyFingerprint(withLlm.config)).toBe(moneyFingerprint(without.config));
    expect(withLlm.config.policies.maxDiscount).toBe("0.20");
  });

  it("a failing proposer falls back to defaults", async () => {
    const r = await compile(mayaTestSpec(), { ...base, proposer: { name: "down", propose: async () => { throw new Error("503"); } } });
    expect(r.config.storefront.theme).toEqual(T.DEFAULT_THEME);
  });

  it("copy checks", () => {
    expect(copyProblem("Warm cookies, made today", 140)).toBeUndefined();
    for (const bad of ["Only $3", "20% off", "Free cookie", "www.x.com", "Buy 2 get 1"]) expect(copyProblem(bad, 140)).toBeDefined();
    expect(acceptProposal({ theme: { primary: "#ffffff", accent: "#000000", background: "#ffffff", text: "#fefefe" } }, { headline: "h", tagline: "t" }).rejected[0]).toMatch(/contrast/);
  });
});

describe("LlmCopyProposer (through the shared Llm port)", () => {
  const input = { businessName: "TEST shop", oneLiner: "TEST", community: "TEST", offerings: ["TEST item"] };
  const fake = (tool: Llm["tool"]): Llm => ({ tool, text: async () => "" });

  it("sends names only (no prices) and uses the propose_storefront tool", async () => {
    const seen: ToolRequest[] = [];
    const p = new LlmCopyProposer(fake(async (req) => (seen.push(req), { headline: "Hello" })));
    expect(await p.propose(input)).toEqual({ headline: "Hello" });
    expect(seen[0]!.toolName).toBe("propose_storefront");
    expect(JSON.stringify(seen[0]!.content)).not.toMatch(/price|cost|\$/i);
  });

  it("refusal or a malformed answer yields no proposal (defaults are used)", async () => {
    expect(await new LlmCopyProposer(fake(async () => { throw new LlmUnavailable("declined"); })).propose(input)).toEqual({});
    expect(await new LlmCopyProposer(fake(async () => ({ theme: "red" }))).propose(input)).toEqual({});
  });
});

describe("rate domain (platform: whole basis points)", () => {
  it("refuses a tax rate with more than 4 decimals instead of rounding it", async () => {
    const spec = mayaTestSpec();
    spec.policies.taxRate = ok("0.08875");
    const e = await compile(spec, base).catch((x) => x);
    expect(e).toBeInstanceOf(UnconfirmedMoneyFacts);
    expect(e.fields.map((f: { path: string }) => f.path)).toContain("policies.taxRate");
  });
  it("refuses a percentage with more than 2 decimals", async () => {
    const spec = mayaTestSpec();
    spec.policies.maxDiscountPct = ok("12.345");
    const e = await compile(spec, base).catch((x) => x);
    expect(e).toBeInstanceOf(UnconfirmedMoneyFacts);
    expect(e.fields.map((f: { path: string }) => f.path)).toContain("policies.maxDiscountPct");
  });
});
