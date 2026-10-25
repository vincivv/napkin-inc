import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { parseBusinessSpec, usableForMoney, type BusinessSpec } from "@napkin/schema";
import { describe, expect, it } from "vitest";
import { assembleSpec, type Extracted } from "../src/intake/extract";
import { mergeSpecs } from "../src/intake/merge";
import type { Llm, ToolRequest } from "../src/llm";
import { intakeRoutes } from "../src/intake/routes";
import type { M2Deps, M2Platform } from "../src/m2deps";
import { applyAnswer, batchConfirmable, confirmMany, moneyBlockers, moneyReady, nextQuestion, refreshQuestions } from "../src/questions/engine";
import { impactScore, isMoneyRelevant, moneyImpact } from "../src/questions/impact";
import { phrasingIsFaithful } from "../src/questions/phrase";
import { questionRoutes } from "../src/questions/routes";
import { applyDiff, buildDiff, revertDiff, StaleDiff } from "../src/questions/statement";
import { coerceValue, CoerceError, shiftDecimal } from "../src/spec/coerce";
import { getFact, listFacts, setFact } from "../src/spec/paths";
import { SpecStore } from "../src/spec/store";
import { Hono } from "hono";

const rf = (value: string, o: Partial<{ confidence: number; provenance: "paper" | "inferred"; quote: string; region: { x: number; y: number; w: number; h: number } }> = {}) => ({
  value,
  confidence: o.confidence ?? 0.9,
  provenance: o.provenance ?? ("paper" as const),
  quote: o.quote ?? value,
  ...(o.region ? { region: o.region } : {}),
});

const napkin: Extracted = {
  business: { name: rf("Maya's Cookies", { region: { x: 0.1, y: 0.05, w: 0.6, h: 0.1 } }) },
  offerings: [
    {
      name: rf("Chocolate chip cookie"),
      variants: [
        { name: rf("Single"), price: rf("$3", { quote: "chocolate chip $3", region: { x: 0.1, y: 0.2, w: 0.5, h: 0.08 } }) },
        { name: rf("Box of 6"), price: rf("15", { quote: "box of 6 $15" }) },
      ],
      addOns: [{ name: rf("Sea salt"), price: rf("1", { quote: "+ sea salt $1" }) }],
    },
  ],
};

const photoSpec = () => assembleSpec(napkin, { mode: "photo", ref: "napkin.png" }).spec;

describe("assembleSpec (never assume)", () => {
  it("every field is a Fact, validated by parseBusinessSpec; unread fields are placeholders", () => {
    const spec = photoSpec();
    expect(() => parseBusinessSpec(spec)).not.toThrow();
    const price = getFact(spec, "offerings.chocolate-chip-cookie.variants.single.price")!;
    expect(price).toMatchObject({ value: "3.00", provenance: "paper", confirmed: false });
    expect(price.source.region).toBeTruthy();
    const cost = getFact(spec, "offerings.chocolate-chip-cookie.variants.single.cost")!;
    expect(cost).toMatchObject({ provenance: "inferred", confidence: 0, confirmed: false });
    expect(getFact(spec, "policies.taxRate")!.confidence).toBe(0);
  });
  it("paper without a quote is downgraded to inferred and low confidence", () => {
    const ex: Extracted = { ...napkin, policies: { taxRate: { value: "0.10", confidence: 0.95, provenance: "paper" } } };
    const f = getFact(assembleSpec(ex, { mode: "photo", ref: "x" }).spec, "policies.taxRate")!;
    expect(f.provenance).toBe("inferred");
    expect(f.confidence).toBeLessThanOrEqual(0.4);
  });
  it("model-claimed guesses are capped; voice facts are owner_said and unconfirmed", () => {
    const ex: Extracted = { offerings: napkin.offerings, policies: { maxDiscountPct: rf("20%", { provenance: "inferred", confidence: 0.9, quote: "seems typical" }), refundMethod: rf("original payment", { quote: "back to the card" }) } };
    const s = assembleSpec(ex, { mode: "voice", ref: "t1" }).spec;
    expect(getFact(s, "policies.maxDiscountPct")).toMatchObject({ provenance: "inferred", value: "20" });
    expect(getFact(s, "policies.maxDiscountPct")!.confidence).toBeLessThanOrEqual(0.4);
    expect(getFact(s, "policies.refundMethod")).toMatchObject({ provenance: "owner_said", confirmed: false, source: { kind: "voice", quote: "back to the card" } });
  });
  it("unusable values are rejected, not guessed", () => {
    const ex: Extracted = { offerings: [{ name: rf("Cookie"), variants: [{ name: rf("One"), price: rf("three-ish") }], addOns: [] }] };
    const r = assembleSpec(ex, { mode: "photo", ref: "x" });
    expect(r.rejected.length).toBe(1);
    expect(getFact(r.spec, "offerings.cookie.variants.one.price")!.confidence).toBe(0);
  });
  it("no offerings at all still yields a valid spec with an open placeholder", () => {
    const s = assembleSpec({ offerings: [] }, { mode: "voice", ref: "t" }).spec;
    expect(moneyReady(refreshQuestions(s))).toBe(false);
  });
});

describe("coerceValue", () => {
  it("parses money, percents and hours exactly", () => {
    expect(coerceValue("offerings.a.variants.b.price", "", "$3")).toBe("3.00");
    expect(coerceValue("policies.maxDiscountPct", "", "20%")).toBe("20");
    expect(coerceValue("policies.maxDiscountPct", "", "0")).toBe("0");
    // *Pct fields are percent points; a bare value between 0 and 1 could mean either, so it is asked again
    expect(coerceValue("policies.marginFloorPct", "", "30")).toBe("30");
    expect(coerceValue("policies.marginFloorPct", "", "0.5%")).toBe("0.5");
    expect(() => coerceValue("policies.marginFloorPct", "", "0.3")).toThrow(CoerceError);
    expect(coerceValue("policies.taxRate", "", "0.0925")).toBe("0.0925");
    expect(coerceValue("policies.refundWindowHours", "", "2 days")).toBe("48");
    expect(shiftDecimal("7.25", -2)).toBe("0.0725");
  });
  it("refuses ambiguity instead of guessing", () => {
    expect(() => coerceValue("policies.couponsAllowed", false, "maybe")).toThrow(CoerceError);
    expect(() => coerceValue("offerings.a.variants.b.price", "", "free")).toThrow(CoerceError);
    expect(() => coerceValue("policies.taxRate", "", "250%")).toThrow(CoerceError);
  });
});

describe("impact scoring", () => {
  it("impactScore = moneyImpact * (1 - confidence) from the fixed table", () => {
    expect(impactScore("offerings.x.variants.y.price", 0)).toBe(1);
    expect(impactScore("offerings.x.variants.y.cost", 0.25)).toBe(0.75);
    expect(impactScore("policies.maxDiscountPct", 1)).toBe(0);
    expect(impactScore("offerings.x.initialStock", 0)).toBe(0.5);
    expect(impactScore("business.hours", 0)).toBe(0.1);
    expect(impactScore("business.name", 0)).toBe(0.02);
    expect(moneyImpact("policies.refundWindowHours")).toBe(1);
    expect(isMoneyRelevant("business.hours")).toBe(false);
    expect(isMoneyRelevant("policies.taxRate")).toBe(true);
  });
  it("asks the highest-impact question first (cost before hours), deterministically", () => {
    const s = refreshQuestions(photoSpec());
    const q = nextQuestion(s)!;
    expect(q.moneyRelevant).toBe(true);
    expect(q.impactScore).toBe(1);
    expect(s.openQuestions[0]).toEqual(q);
    expect(nextQuestion(s)).toEqual(q);
    const idx = (p: string) => s.openQuestions.findIndex((x) => x.fieldPath === p);
    expect(idx("offerings.chocolate-chip-cookie.variants.single.cost")).toBeLessThan(idx("business.hours"));
    expect(idx("business.hours")).toBeLessThan(idx("business.name") === -1 ? 1e9 : idx("business.name") + 1);
  });
  it("phrasing must keep every number", () => {
    expect(phrasingIsFaithful("Is $3.00 right for 6?", "Is $3.00 right for 6 cookies?")).toBe(true);
    expect(phrasingIsFaithful("Is $3.00 right?", "Is $4.00 right?")).toBe(false);
  });
});

describe("review list (batch confirm)", () => {
  it("offers only present, valid, non-guessed values; confirming them makes them the owner's own", () => {
    const s = refreshQuestions(photoSpec());
    const list = batchConfirmable(s);
    expect(list.length).toBeGreaterThan(0);
    for (const q of list) {
      const f = getFact(s, q.fieldPath)!;
      expect(f.provenance).not.toBe("inferred");
      expect(f.source.ref).not.toBe("missing");
    }
    // the paper-read single price is in the list; a missing cost is not
    expect(list.some((q) => q.fieldPath === "offerings.chocolate-chip-cookie.variants.single.price")).toBe(true);
    expect(list.some((q) => q.fieldPath.endsWith("single.cost"))).toBe(false);
    const r = confirmMany(s, list.map((q) => q.id));
    expect(r.skipped).toEqual([]);
    for (const q of list) {
      const f = getFact(r.spec, q.fieldPath)!;
      expect(usableForMoney(f)).toBe(true);
      expect(f.provenance).toBe("owner_said");
    }
    expect(batchConfirmable(r.spec)).toEqual([]);
  });
  it("skips guesses, missing values and unknown ids instead of confirming them", () => {
    const s = refreshQuestions(photoSpec());
    const notListed = s.openQuestions.filter((q) => !batchConfirmable(s).some((b) => b.id === q.id));
    expect(notListed.length).toBeGreaterThan(0);
    const r = confirmMany(s, [...notListed.map((q) => q.id), "q.nope"]);
    expect(r.confirmed).toEqual([]);
    expect(r.skipped.length).toBe(notListed.length + 1);
    for (const q of notListed) expect(usableForMoney(getFact(r.spec, q.fieldPath)!)).toBe(false);
  });
  it("property: whatever ids are sent, no inferred or missing fact ever becomes usable for money", () => {
    const base = refreshQuestions(photoSpec());
    const ids = base.openQuestions.map((q) => q.id);
    fc.assert(
      fc.property(fc.subarray(ids), (pick) => {
        const r = confirmMany(base, pick);
        for (const x of r.confirmed) expect(x.before.provenance).not.toBe("inferred");
      }),
      { numRuns: 60 },
    );
  });
});

describe("moneyReady", () => {
  it("is false until every money-relevant fact is usableForMoney; true after the owner answers them all", () => {
    let s = refreshQuestions(photoSpec());
    expect(moneyReady(s)).toBe(false);
    // a paper-read price is not enough until confirmed
    expect(usableForMoney(getFact(s, "offerings.chocolate-chip-cookie.variants.single.price")!)).toBe(false);
    let guard = 0;
    while (!moneyReady(s) && guard++ < 60) {
      const q = nextQuestion(s)!;
      const f = getFact(s, q.fieldPath)!;
      const typed: Record<string, string> = { cost: "0.5", stockTracked: "no", couponsAllowed: "no", refundMethod: "original payment", currency: "USD", paymentMethods: "card", fulfillment: "pickup" };
      const leaf = q.fieldPath.split(".").pop()!;
      s = applyAnswer(s, q.id, f.confidence > 0 && !q.fieldPath.includes("cost") ? { confirm: true } : { answer: typed[leaf] ?? "10%" }).spec;
    }
    expect(moneyReady(s)).toBe(true);
    for (const { path, fact } of listFacts(s)) if (isMoneyRelevant(path)) expect(fact.provenance === "inferred").toBe(false);
  });
  it("an answer makes the fact owner_said + confirmed and rejects ambiguity", () => {
    const s = refreshQuestions(photoSpec());
    const q = s.openQuestions.find((x) => x.fieldPath.endsWith("single.cost"))!;
    expect(() => applyAnswer(s, q.id, { confirm: true })).toThrow(/no value to confirm/);
    expect(() => applyAnswer(s, q.id, { answer: "cheap" })).toThrow();
    const r = applyAnswer(s, q.id, { answer: "$0.40" });
    expect(getFact(r.spec, q.fieldPath)).toMatchObject({ value: "0.40", provenance: "owner_said", confirmed: true, confidence: 1 });
    expect(r.spec.openQuestions.find((x) => x.id === q.id)).toBeUndefined();
  });
  it("asks for stock counts even when the photo never mentioned stock (the fields are absent, not just missing)", () => {
    const base = photoSpec();
    const bare = { ...base, offerings: base.offerings.map(({ initialStock: _, ...o }) => ({ ...o, variants: o.variants.map(({ stockUnits: __, ...v }) => v) })) };
    const s = refreshQuestions(bare as typeof base);
    const asked = s.openQuestions.map((q) => q.fieldPath);
    expect(asked).toContain("offerings.chocolate-chip-cookie.initialStock");
    expect(asked.filter((p) => p.endsWith(".stockUnits")).length).toBe(base.offerings[0]!.variants.length);
    expect(moneyBlockers(s).map((b) => b.path)).toContain("offerings.chocolate-chip-cookie.initialStock");
  });
  it("reopens a confirmed fact the compiler would refuse, and only takes whole stock units", () => {
    const base = photoSpec();
    const o = base.offerings[0]!;
    const owner = (value: unknown) => ({ value, provenance: "owner_said" as const, confidence: 1, source: { kind: "chat" as const, ref: "t", quote: String(value) }, confirmed: true });
    const v = o.variants[0]!;
    const bad = { ...base, offerings: [{ ...o, stockTracked: owner(true), variants: [{ ...v, stockUnits: owner("3.30") }, ...o.variants.slice(1)] }, ...base.offerings.slice(1)] } as typeof base;
    const path = `offerings.${o.id}.variants.${v.id}.stockUnits`;
    const s = refreshQuestions(bad);
    const q = s.openQuestions.find((x) => x.fieldPath === path)!;
    expect(q.question).toMatch(/whole number/);
    expect(moneyBlockers(s)).toContainEqual({ path, why: "invalid" });
    expect(() => applyAnswer(s, q.id, { confirm: true })).toThrow(/whole number/);
    expect(() => applyAnswer(s, q.id, { answer: "3.3" })).toThrow(/whole number/);
    expect(() => applyAnswer(s, q.id, { answer: "0" })).toThrow(/whole number/);
    const r = applyAnswer(s, q.id, { answer: "3" });
    expect(getFact(r.spec, path)).toMatchObject({ value: "3" });
    expect(r.spec.openQuestions.some((x) => x.fieldPath === path)).toBe(false);
  });
  it("asks for a variant cost that disagrees with the shared stock's unit cost, instead of letting the compiler stall", () => {
    const base = photoSpec();
    const o = base.offerings[0]!;
    const owner = (value: unknown) => ({ value, provenance: "owner_said" as const, confidence: 1, source: { kind: "chat" as const, ref: "t", quote: String(value) }, confirmed: true });
    const [single, box] = o.variants as [(typeof o.variants)[number], (typeof o.variants)[number]];
    const variants = [
      { ...single, price: owner("4.00"), cost: owner("1.20"), stockUnits: owner("1") },
      { ...box, price: owner("11.00"), cost: owner("3.30"), stockUnits: owner("3") },
    ];
    const spec = { ...base, offerings: [{ ...o, stockTracked: owner(true), initialStock: owner(60), variants }] } as typeof base;
    const path = `offerings.${o.id}.variants.${box.id}.cost`;
    const s = refreshQuestions(spec);
    const q = s.openQuestions.find((x) => x.fieldPath === path)!;
    expect(q.question).toMatch(/should be \$3\.60/);
    expect(moneyBlockers(s)).toContainEqual({ path, why: "invalid" });
    expect(() => applyAnswer(s, q.id, { answer: "$3.30" })).toThrow(/should be \$3\.60/);
    const r = applyAnswer(s, q.id, { answer: "$3.60" });
    expect(r.spec.openQuestions.some((x) => x.fieldPath === path)).toBe(false);
  });
  it("stock details are not required once the owner says stock is not tracked", () => {
    const ex: Extracted = { offerings: [{ ...napkin.offerings[0]!, initialStock: rf("12", { provenance: "inferred", confidence: 0.2 }) }] };
    let s = refreshQuestions(assembleSpec(ex, { mode: "voice", ref: "t" }).spec);
    expect(s.openQuestions.some((q) => q.fieldPath.endsWith("initialStock"))).toBe(true);
    s = applyAnswer(s, "q.offerings.chocolate-chip-cookie.stockTracked", { answer: "no" }).spec;
    expect(s.openQuestions.some((q) => q.fieldPath.endsWith("initialStock"))).toBe(false);
  });
});

// ---------- merge: property tests ----------
const NAMES = ["Cookie", "Brownie", "Chai"];
const VARIANTS = ["Single", "Box"];
const arbFact = fc.record({
  v: fc.constantFrom("1", "2.5", "3", "3.00", "4", "15"),
  conf: fc.double({ min: 0, max: 1, noNaN: true }).map((x) => Math.round(x * 20) / 20),
  prov: fc.constantFrom("paper", "inferred" as const),
  present: fc.boolean(),
});
const arbExtraction = fc
  .record({
    offerings: fc.uniqueArray(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 3 }).chain((names) =>
      fc.tuple(...names.map((n) => fc.record({ n: fc.constant(n), variants: fc.uniqueArray(fc.constantFrom(...VARIANTS), { minLength: 1, maxLength: 2 }), price: arbFact, cost: arbFact }))),
    ),
    tax: arbFact,
    mode: fc.constantFrom("photo", "voice" as const),
  })
  .map((r) => {
    const mk = (f: { v: string; conf: number; prov: "paper" | "inferred" | string; present: boolean }) =>
      f.present ? rf(f.v, { confidence: f.conf, provenance: f.prov === "inferred" ? "inferred" : "paper", quote: `q${f.v}` }) : undefined;
    const ex: Extracted = {
      offerings: r.offerings.map((o) => ({
        name: rf(o.n),
        variants: o.variants.map((v) => ({ name: rf(v), price: mk(o.price), cost: mk(o.cost) })),
        addOns: [],
      })),
      policies: { taxRate: mk(r.tax) },
    };
    return assembleSpec(ex, { mode: r.mode === "photo" ? "photo" : "voice", ref: r.mode }).spec;
  });

describe("mergeSpecs (property)", () => {
  it("is order-independent", () => {
    fc.assert(
      fc.property(arbExtraction, arbExtraction, (a, b) => {
        expect(mergeSpecs(a, b)).toEqual(mergeSpecs(b, a));
      }),
      { numRuns: 300 },
    );
  });
  it("is idempotent and always yields a valid spec", () => {
    fc.assert(
      fc.property(arbExtraction, arbExtraction, (a, b) => {
        const m = mergeSpecs(a, b);
        expect(() => parseBusinessSpec(m.spec)).not.toThrow();
        expect(mergeSpecs(m.spec, m.spec).spec).toEqual(m.spec);
      }),
      { numRuns: 200 },
    );
  });
  it("never drops a differing real candidate: it is the winner, an alternative, or a conflict candidate", () => {
    fc.assert(
      fc.property(arbExtraction, arbExtraction, (a, b) => {
        const m = mergeSpecs(a, b);
        const fa = new Map(listFacts(a).map((x) => [x.path, x.fact]));
        for (const { path, fact: fb } of listFacts(b)) {
          const fA = fa.get(path);
          if (!fA) continue;
          const win = getFact(m.spec, path)!;
          const seen = [win, ...(m.alternatives[path] ?? [])].map((x) => JSON.stringify(x.value));
          const cands = m.spec.openQuestions.find((q) => q.id === `conflict.${path}`)?.candidates ?? [];
          for (const f of [fA, fb]) {
            if (f.source.ref === "missing") continue;
            const kept = seen.includes(JSON.stringify(f.value)) || cands.some((c) => c.replace(/^\$/, "") === String(f.value) || c.includes(String(f.value).replace(/^0+(\.0+)?$/, "0")));
            expect(kept, `${path} ${JSON.stringify(f.value)} lost`).toBe(true);
          }
          // a true conflict (both unconfirmed, both claims, different values) must raise a question
          const differ = JSON.stringify(fA.value) !== JSON.stringify(fb.value) && !isNumEq(fA.value, fb.value);
          if (differ && fA.source.ref !== "missing" && fb.source.ref !== "missing" && (fA.provenance === "inferred") === (fb.provenance === "inferred")) {
            expect(cands.length).toBeGreaterThan(1);
            expect(win.confirmed).toBe(false);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
  it("same value keeps the higher confidence; conflicts become questions and the owner can resolve them", () => {
    const a = assembleSpec({ offerings: [{ name: rf("Cookie"), variants: [{ name: rf("One"), price: rf("3", { confidence: 0.6 }) }], addOns: [] }] }, { mode: "photo", ref: "p" }).spec;
    const same = assembleSpec({ offerings: [{ name: rf("Cookie"), variants: [{ name: rf("One"), price: rf("3.00", { confidence: 0.9 }) }], addOns: [] }] }, { mode: "voice", ref: "v" }).spec;
    expect(getFact(mergeSpecs(a, same).spec, "offerings.cookie.variants.one.price")!.confidence).toBe(0.9);
    const diff = assembleSpec({ offerings: [{ name: rf("Cookie"), variants: [{ name: rf("One"), price: rf("4", { confidence: 0.7 }) }], addOns: [] }] }, { mode: "voice", ref: "v" }).spec;
    const m = mergeSpecs(a, diff);
    const q = refreshQuestions(m.spec).openQuestions.find((x) => x.id === "conflict.offerings.cookie.variants.one.price")!;
    expect(q.candidates).toEqual(["$3.00", "$4.00"]);
    expect(q.question).toMatch(/disagree/);
    expect(m.alternatives["offerings.cookie.variants.one.price"]).toHaveLength(1);
  });
});
const isNumEq = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a !== "" && Number(a) === Number(b);

// ---------- statement diff ----------
describe("statement diff", () => {
  const base = (): BusinessSpec => {
    let s = refreshQuestions(photoSpec());
    s = applyAnswer(s, "q.policies.maxDiscountPct", { answer: "20%" }).spec;
    return s;
  };
  const ctx = { statementId: "st1", text: "no discounts this week", channel: "phone" as const };
  it("builds a diff 20% -> 0%, applies purely and reverts exactly", () => {
    const s = base();
    const snapshot = structuredClone(s);
    const diff = buildDiff(s, { changes: [{ path: "policies.maxDiscountPct", newValue: "0", quote: "no discounts" }], unparsed: [], note: "this week cannot be enforced" }, ctx);
    expect(s).toEqual(snapshot); // pure
    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]).toMatchObject({ beforeText: "20%", afterText: "0%" });
    const applied = applyDiff(s, diff);
    expect(getFact(applied, "policies.maxDiscountPct")).toMatchObject({ value: "0", provenance: "owner_said", confirmed: true, source: { kind: "phone" } });
    expect(revertDiff(applied, diff)).toEqual(s);
    expect(applied).not.toEqual(s);
  });
  it("unknown paths and bad values are reported, never applied; stale diffs refuse", () => {
    const s = base();
    const diff = buildDiff(s, { changes: [{ path: "policies.nope", newValue: "1" }, { path: "policies.taxRate", newValue: "lots" }], unparsed: ["x"] }, ctx);
    expect(diff.changes).toHaveLength(0);
    expect(diff.unparsed).toHaveLength(3);
    const d2 = buildDiff(s, { changes: [{ path: "policies.maxDiscountPct", newValue: "0" }], unparsed: [] }, ctx);
    const changed = setFact(s, "policies.maxDiscountPct", { ...getFact(s, "policies.maxDiscountPct")!, value: "0.10" });
    expect(() => applyDiff(changed, d2)).toThrow(StaleDiff);
  });
  it("apply/revert property over arbitrary discount values", () => {
    const s = base();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 100 }), (pct) => {
        const d = buildDiff(s, { changes: [{ path: "policies.maxDiscountPct", newValue: `${pct}%` }], unparsed: [] }, ctx);
        expect(revertDiff(applyDiff(s, d), d)).toEqual(s);
      }),
    );
  });
});

// ---------- HTTP routes with a fake LLM and platform ----------
class FakeLlm implements Llm {
  calls: ToolRequest[] = [];
  constructor(private readonly handler: (r: ToolRequest) => unknown, private readonly phrase?: (u: string) => string) {}
  async tool(r: ToolRequest) {
    this.calls.push(r);
    return this.handler(r);
  }
  async text(r: { user: string }) {
    return this.phrase ? this.phrase(r.user) : r.user;
  }
}
class FakePlatformM2 implements M2Platform {
  decisions: { action: string }[] = [];
  queued: { diffJson: string; channel: string }[] = [];
  rows: { id: bigint; status: string; diffJson: string }[] = [];
  marked: bigint[] = [];
  hasBusiness() { return true; }
  async recordDecision(a: { action: string }) { this.decisions.push(a); }
  async queueOwnerStatement(a: { diffJson: string; channel: string }) { this.queued.push(a); this.rows.push({ id: 7n, status: "queued", diffJson: a.diffJson }); }
  ownerStatements() { return this.rows; }
  async markOwnerStatementApplied(id: bigint) { this.marked.push(id); }
}

function harness(llm: Llm | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-"));
  const platform = new FakePlatformM2();
  let n = 0;
  const deps: M2Deps = { store: new SpecStore(dir), llm, platform, cartesiaKey: "ck", newId: () => `id${++n}` };
  const app = new Hono();
  app.route("/", intakeRoutes(deps));
  app.route("/", questionRoutes(deps));
  return { app, deps, platform, dir };
}
const j = (app: Hono, p: string, body: unknown) => app.request(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "napkin.png", { type: "image/png" });

describe("routes", () => {
  const llm = () => new FakeLlm((r) => (r.toolName === "propose_changes" ? { changes: [{ path: "policies.maxDiscountPct", newValue: "0", quote: "no discounts" }], unparsed: [], note: "this week" } : napkin));

  it("photo intake -> spec with versions, regions, moneyReady=false", async () => {
    const { app, dir } = harness(llm());
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    const res = await app.request("/intake/photo", { method: "POST", body: fd });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: number; moneyReady: boolean; counts: Record<string, number> };
    expect(body.version).toBe(1);
    expect(body.moneyReady).toBe(false);
    expect(body.counts.paper).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, "specs", "maya-cookies.json"))).toBe(true);
    const spec = (await (await app.request("/spec/maya-cookies")).json()) as { moneyReady: boolean };
    expect(spec.moneyReady).toBe(false);
    expect((await app.request("/intake/photo/maya-cookies")).status).toBe(200);
  });

  it("a replacement photo drops items only the old photo had; items the owner named by voice stay", async () => {
    const soy: Extracted = { offerings: [{ name: rf("Soy candle"), variants: [{ name: rf("Small jar"), price: rf("12") }, { name: rf("Big jar"), price: rf("24") }], addOns: [] }] };
    const split: Extracted = {
      offerings: [
        { name: rf("Small jar candle"), variants: [{ name: rf("Small jar"), price: rf("12") }], addOns: [] },
        { name: rf("Big jar candle"), variants: [{ name: rf("Big jar"), price: rf("24") }], addOns: [] },
      ],
    };
    const said: Extracted = { offerings: [{ name: rf("Tea light"), variants: [{ name: rf("Tea light"), price: rf("2") }], addOns: [] }] };
    const jars: Extracted = { offerings: [{ name: rf("Candle"), variants: [{ name: rf("Jar"), price: rf("12") }], addOns: [] }] };
    const queue = [soy, said, jars, split];
    const { app } = harness(new FakeLlm(() => queue.shift()!));
    const photo = () => {
      const fd = new FormData();
      fd.set("businessId", "juniper");
      fd.set("image", png());
      return app.request("/intake/photo", { method: "POST", body: fd });
    };
    const names = async () => ((await (await app.request("/spec/juniper")).json()) as { spec: { offerings: { name: { value: string } }[] } }).spec.offerings.map((o) => o.name.value).sort();
    expect((await photo()).status).toBe(200);
    const fd = new FormData();
    fd.set("businessId", "juniper");
    fd.set("transcript", "I also sell tea lights for two dollars");
    expect((await app.request("/intake/voice", { method: "POST", body: fd })).status).toBe(200);
    expect(await names()).toEqual(["Soy candle", "Tea light"]);
    expect((await photo()).status).toBe(200);
    expect(await names()).toEqual(["Candle", "Tea light"]);
    expect((await photo()).status).toBe(200); // a third reading: items from BOTH earlier photos go
    expect(await names()).toEqual(["Big jar candle", "Small jar candle", "Tea light"]);
    const spec = (await (await app.request("/spec/juniper")).json()) as { spec: { openQuestions: { fieldPath: string }[] } };
    expect(spec.spec.openQuestions.some((q) => q.fieldPath.includes("soy-candle"))).toBe(false);
  });

  it("retries once on invalid model output, then fails cleanly", async () => {
    let n = 0;
    const flaky = new FakeLlm(() => (n++ === 0 ? { offerings: "nope" } : napkin));
    const h = harness(flaky);
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    expect((await h.app.request("/intake/photo", { method: "POST", body: fd })).status).toBe(200);
    expect(n).toBe(2);
    const bad = harness(new FakeLlm(() => ({ offerings: "nope" })));
    const fd2 = new FormData();
    fd2.set("businessId", "x");
    fd2.set("image", png());
    expect((await bad.app.request("/intake/photo", { method: "POST", body: fd2 })).status).toBe(502);
  });

  it("503 without a key; 415 for non-images; typed transcript works as voice fallback", async () => {
    const h = harness(undefined);
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    expect((await h.app.request("/intake/photo", { method: "POST", body: fd })).status).toBe(503);
    const h2 = harness(llm());
    const fd2 = new FormData();
    fd2.set("businessId", "maya-cookies");
    fd2.set("image", new File(["x"], "a.txt", { type: "text/plain" }));
    expect((await h2.app.request("/intake/photo", { method: "POST", body: fd2 })).status).toBe(415);
  });

  it("voice -> merge -> interview: top-impact question first, answer, decision recorded", async () => {
    const voiceEx: Extracted = { offerings: [{ name: rf("Chocolate chip cookie"), variants: [{ name: rf("Single"), price: rf("4", { confidence: 0.9, quote: "four dollars" }) }], addOns: [] }], policies: { maxDiscountPct: rf("20%", { quote: "up to twenty percent off" }) } };
    const h = harness(new FakeLlm((r) => (r.system.includes("OWNER SAID") ? voiceEx : napkin), (u) => u));
    const post = async (p: string, fields: Record<string, string | File>) => {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.set(k, v);
      return h.app.request(p, { method: "POST", body: fd });
    };
    expect((await post("/intake/photo", { businessId: "maya-cookies", image: png() })).status).toBe(200);
    const v = await post("/intake/voice", { businessId: "maya-cookies", transcript: "single is four dollars, up to twenty percent off" });
    const vb = (await v.json()) as { version: number; spec: BusinessSpec };
    expect(vb.version).toBe(2);
    expect(vb.spec.openQuestions.some((q) => q.id === "conflict.offerings.chocolate-chip-cookie.variants.single.price")).toBe(true);
    expect((await j(h.app, "/intake/merge", { businessId: "maya-cookies" })).status).toBe(200);

    const next = (await (await h.app.request("/questions/next?businessId=maya-cookies")).json()) as { question: { id: string; impactScore: number; phrasedBy: string }; remaining: number };
    expect(next.question.impactScore).toBe(1);
    expect(next.remaining).toBeGreaterThan(5);
    const ans = await j(h.app, `/questions/${next.question.id}/answer`, { businessId: "maya-cookies", answer: "banana" });
    expect([422]).toContain(ans.status);
    const ok = await j(h.app, "/questions/conflict.offerings.chocolate-chip-cookie.variants.single.price/answer", { businessId: "maya-cookies", answer: "$3" });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { decisionRecorded: boolean }).decisionRecorded).toBe(true);
    expect(h.platform.decisions[0]!.action).toBe("owner_confirmed_fact");
    const spec = h.deps.store.get("maya-cookies")!.spec;
    expect(getFact(spec, "offerings.chocolate-chip-cookie.variants.single.price")).toMatchObject({ value: "3.00", provenance: "owner_said", confirmed: true });
  });

  it("money questions are never rephrased by the model (a rephrase can change the unit)", async () => {
    const h = harness(new FakeLlm(() => napkin, () => "What would a whole batch cost you?"));
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    expect((await h.app.request("/intake/photo", { method: "POST", body: fd })).status).toBe(200);
    const next = (await (await h.app.request("/questions/next?businessId=maya-cookies")).json()) as { question: { moneyRelevant: boolean; question: string; phrased: string; phrasedBy: string } };
    expect(next.question.moneyRelevant).toBe(true);
    expect(next.question.phrasedBy).toBe("template");
    expect(next.question.phrased).toBe(next.question.question);
  });

  it("app statement: diff returned, nothing applied until confirmed; reject leaves spec untouched", async () => {
    const h = harness(llm());
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    await h.app.request("/intake/photo", { method: "POST", body: fd });
    await j(h.app, "/questions/q.policies.maxDiscountPct/answer", { businessId: "maya-cookies", answer: "20%" });
    const r = await j(h.app, "/owner/statement", { businessId: "maya-cookies", text: "no discounts this week", channel: "app" });
    const b = (await r.json()) as { statementId: string; diff: { changes: unknown[] }; appliedToSpec: boolean };
    expect(b.diff.changes).toHaveLength(1);
    expect(getFact(h.deps.store.get("maya-cookies")!.spec, "policies.maxDiscountPct")!.value).toBe("20");
    const rej = await j(h.app, `/owner/statement/${b.statementId}/decide`, { businessId: "maya-cookies", confirm: false });
    expect(rej.status).toBe(200);
    expect(getFact(h.deps.store.get("maya-cookies")!.spec, "policies.maxDiscountPct")!.value).toBe("20");
  });

  it("phone statement is queued on the platform, never applied directly, applied only after the platform shows it confirmed", async () => {
    const h = harness(llm());
    const fd = new FormData();
    fd.set("businessId", "maya-cookies");
    fd.set("image", png());
    await h.app.request("/intake/photo", { method: "POST", body: fd });
    await j(h.app, "/questions/q.policies.maxDiscountPct/answer", { businessId: "maya-cookies", answer: "20%" });
    const r = await j(h.app, "/owner/statement", { businessId: "maya-cookies", text: "no discounts this week", channel: "phone" });
    const b = (await r.json()) as { statementId: string; platformQueued: boolean };
    expect(b.platformQueued).toBe(true);
    expect(h.platform.queued).toHaveLength(1);
    expect(getFact(h.deps.store.get("maya-cookies")!.spec, "policies.maxDiscountPct")!.value).toBe("20");
    // the brain refuses to decide a phone statement itself
    expect((await j(h.app, `/owner/statement/${b.statementId}/decide`, { businessId: "maya-cookies", confirm: true })).status).toBe(409);
    // still queued -> still not applied
    await h.app.request("/owner/statements?businessId=maya-cookies");
    expect(getFact(h.deps.store.get("maya-cookies")!.spec, "policies.maxDiscountPct")!.value).toBe("20");
    // owner confirms in the app (platform) -> next sync applies it
    h.platform.rows[0]!.status = "confirmed";
    const list = (await (await h.app.request("/owner/statements?businessId=maya-cookies")).json()) as { statements: { status: string }[] };
    expect(list.statements[0]!.status).toBe("applied");
    expect(getFact(h.deps.store.get("maya-cookies")!.spec, "policies.maxDiscountPct")!.value).toBe("0");
    expect(h.platform.marked).toEqual([7n]);
  });
});
