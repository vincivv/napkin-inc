import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import {
  computeDocument,
  evaluate,
  FractionalCentsError,
  PolicyCheckError,
  post,
  Rational,
  UnbalancedPostingError,
  type DocumentDef,
  type Env,
  type Expr,
} from "@napkin/ledger-core";
import { parseConfiguration, parseProofReport, type Configuration } from "@napkin/schema";
import mayaJson from "../../../fixtures/maya/configuration.json";
import {
  buildSymbolicDoc,
  encodeValue,
  flowCheck,
  getZ3,
  intNV,
  proveBalance,
  proveConfiguration,
  proveDiscountStacking,
  rationalOf,
  realNV,
  shutdown,
  synthesizePostingRule,
  type EncodeScope,
  type ProverDetail,
} from "../src";
import { postingContext } from "../src/symbolic";

const maya = parseConfiguration(mayaJson);
const clone = (): Configuration => structuredClone(maya);
const saleOf = (c: Configuration) => c.documents.find((d) => d.id === "sale")!;
const asDef = (d: unknown) => d as DocumentDef;

afterAll(shutdown);

describe("Maya's configuration", () => {
  it("proves: every document balances, discount stacking holds, flow check is clean", async () => {
    const t0 = performance.now();
    const report = parseProofReport(await proveConfiguration(maya));
    const ms = performance.now() - t0;
    expect(report.balanceProof.status).toBe("proved");
    expect(report.balanceProof.details).toHaveLength(maya.documents.length);
    expect(report.balanceProof.details.every((d) => d.status === "proved")).toBe(true);
    expect(report.discountProof.status).toBe("proved");
    expect(report.discountProof.details.map((d) => d.subject)).toEqual(["sale/cookie_single", "sale/cookie_box6", "sale/sea_salt", "refund/margin_floor"]);
    expect(report.flowCheck.status).toBe("proved");
    expect(report.solver).toMatch(/z3-solver 5\.3\.1/);
    expect(report.synthesisLog.some((l) => l.startsWith("proofs:"))).toBe(true);
    expect(ms).toBeLessThan(15_000);
  }, 30_000);
});

describe("balance proof failures", () => {
  it("removing sale.discount fails with imbalance == the discount and suggests Discounts given (4100)", async () => {
    const cfg = clone();
    saleOf(cfg).postingRules = saleOf(cfg).postingRules.filter((r) => r.id !== "sale.discount");
    const r = await proveBalance(cfg, "sale");
    expect(r.status).toBe("failed");
    const d = r.details.find((x) => x.subject === "sale") as ProverDetail;
    expect(d.counterexample?.imbalance).toBeDefined();
    // the imbalance equals the total line.discount of the counterexample, computed by ledger-core
    const computed = computeDocument(asDef(saleOf(maya)), d.input!, postingContext(maya)).computed;
    const discount = computed.lines.reduce((a, l) => a.add(l.discount!), Rational.ZERO);
    expect(discount.isZero()).toBe(false);
    expect(Rational.parse(d.imbalance!).eq(discount.neg())).toBe(true);
    // and the runtime agrees it is unbalanced
    expect(() => post(asDef(saleOf(cfg)), d.input!, postingContext(cfg))).toThrow(UnbalancedPostingError);
    expect(d.suggestedFix).toMatch(/Discounts given/);
    expect(d.suggestedFix).toMatch(/4100/);
    expect(d.suggestedFix).toMatch(/Verified/);
    expect(d.suggestedRule?.amountExpr).toBe("line.discount");
  }, 30_000);

  it("a rule that can produce fractional cents (no round2) fails with a replayable counterexample", async () => {
    const cfg = clone();
    saleOf(cfg).derived.find((d) => d.name === "discount")!.expr = "line.gross * doc.discountRate";
    const r = await proveBalance(cfg, "sale");
    expect(r.status).toBe("failed");
    const d = r.details.find((x) => x.subject === "sale/cents:sale.discount") as ProverDetail;
    expect(d).toBeDefined();
    expect(() => post(asDef(saleOf(cfg)), d.input!, postingContext(cfg))).toThrow(FractionalCentsError);
    expect(d.suggestedFix).toMatch(/round2\(line\.gross \* doc\.discountRate\)/);
    expect(d.suggestedFix).toMatch(/Verified/);
  }, 30_000);

  it("a posting rule amount without round2 fails too", async () => {
    const cfg = clone();
    const sale = saleOf(cfg);
    sale.postingRules.push(
      { id: "sale.tip", scope: "line", target: { kind: "account", code: "4000" }, side: "credit", amountExpr: "line.gross * 0.015" },
      { id: "sale.tip_rcv", scope: "line", target: { kind: "account", code: "1200" }, side: "debit", amountExpr: "line.gross * 0.015" },
    );
    const r = await proveBalance(cfg, "sale");
    expect(r.status).toBe("failed");
    const d = r.details.find((x) => x.subject === "sale/cents:sale.tip") as ProverDetail;
    expect(() => post(asDef(sale), d.input!, postingContext(cfg))).toThrow(FractionalCentsError);
  }, 30_000);
});

describe("discount stacking", () => {
  it("maxDiscount 0.75 fails with a counterexample below the floor and a verified safe cap", async () => {
    const cfg = clone();
    cfg.policies.maxDiscount = "0.75";
    const r = await proveDiscountStacking(cfg);
    expect(r.status).toBe("failed");
    const failed = r.details.filter((d) => d.status === "failed") as ProverDetail[];
    expect(failed.map((d) => d.subject).sort()).toEqual(["sale/cookie_box6", "sale/cookie_single", "sale/sea_salt"]);
    for (const d of failed) {
      expect(d.counterexample?.["doc.discountRate"]).toBeDefined();
      // the runtime margin check would refuse exactly this sale
      expect(() => post(asDef(saleOf(cfg)), d.input!, postingContext(cfg))).toThrow(PolicyCheckError);
    }
    expect(failed[0]!.suggestedFix).toMatch(/at most 73\/125 \(58\.4%\)/);
    const box = failed.find((d) => d.subject === "sale/cookie_box6")!;
    expect(box.suggestedFix).toMatch(/at least \$24\.96/);
    // refunds are unaffected
    expect(r.details.find((d) => d.subject === "refund/margin_floor")?.status).toBe("proved");
  }, 30_000);

  it("the suggested cap 73/125 proves", async () => {
    const cfg = clone();
    cfg.policies.maxDiscount = "0.584";
    expect((await proveDiscountStacking(cfg)).status).toBe("proved");
    cfg.policies.maxDiscount = "0.5841";
    expect((await proveDiscountStacking(cfg)).status).toBe("failed");
  }, 30_000);

  it("a refund document without the full-or-floor check fails", async () => {
    const cfg = clone();
    const refund = cfg.documents.find((d) => d.id === "refund")!;
    refund.checks = refund.checks.filter((c) => c.id !== "refund_full_or_floor");
    const r = await proveDiscountStacking(cfg);
    const d = r.details.find((x) => x.subject === "refund/margin_floor")!;
    expect(d.status).toBe("failed");
    expect(d.suggestedFix).toMatch(/refundedAfter == doc.saleTotal/);
  }, 30_000);
});

describe("flow check", () => {
  it("flags receivables that are never collected", () => {
    const cfg = clone();
    cfg.documents = cfg.documents.filter((d) => d.id !== "payment_received");
    const r = flowCheck(cfg);
    expect(r.status).toBe("failed");
    expect(r.details.find((d) => d.subject === "flow/pass_through")?.message).toMatch(/1200 Receivables is debited/);
  });
  it("flags unknown accounts and one-sided documents", () => {
    const cfg = clone();
    const pay = cfg.documents.find((d) => d.id === "payout")!;
    pay.postingRules = pay.postingRules.filter((r) => r.side === "debit");
    pay.postingRules[0]!.target = { kind: "account", code: "9999" };
    const r = flowCheck(cfg);
    expect(r.status).toBe("failed");
    expect(r.details.find((d) => d.subject === "flow/payout")?.status).toBe("failed");
    expect(r.details.find((d) => d.subject === "flow/references")?.message).toMatch(/9999/);
  });
});

// ---------- the Z3 encoding agrees with the ledger-core evaluator ----------
const VARS = ["line.qty", "line.unitPrice", "doc.discountRate"] as const;
const LITS = ["0", "1", "2", "0.5", "3.00", "0.30", "1.3", "0.005", "0.125", "15"];

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ num: Expr; bool: Expr }>((tie) => ({
  num: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc.constantFrom(...LITS).map((value): Expr => ({ op: "num", value })),
    fc.constantFrom(...VARS).map((name): Expr => ({ op: "var", name })),
    fc.tuple(fc.constantFrom("add", "sub", "mul", "min", "max"), tie("num"), tie("num")).map(([op, a, b]) => ({ op, args: [a, b] }) as Expr),
    fc.tuple(tie("num"), fc.constantFrom("2", "3", "0.5", "7")).map(([a, d]): Expr => ({ op: "div", args: [a, { op: "num", value: d }] })),
    tie("num").map((arg): Expr => ({ op: "round2", arg })),
  ),
  bool: fc.oneof(
    fc.tuple(fc.constantFrom("ge", "gt", "le", "lt", "eq", "ne"), tie("num"), tie("num")).map(([op, a, b]) => ({ op, args: [a, b] }) as Expr),
    fc.tuple(fc.constantFrom("and", "or"), tie("bool"), tie("bool")).map(([op, a, b]) => ({ op, args: [a, b] }) as Expr),
    tie("bool").map((arg): Expr => ({ op: "not", arg })),
  ),
})).num.chain((n) => fc.oneof(fc.constant(n), fc.tuple(fc.constantFrom("ge", "lt", "eq"), fc.constant(n), fc.constantFrom(...LITS)).map(([op, a, v]) => ({ op, args: [a, { op: "num", value: v }] }) as Expr)));

describe("encoder", () => {
  it("agrees with the ledger-core evaluator on random concrete inputs (fast-check)", async () => {
    const z = await getZ3();
    await fc.assert(
      fc.asyncProperty(
        exprArb,
        fc.integer({ min: 1, max: 10_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000 }),
        fc.boolean(),
        async (e, qty, cents, bp, realRate) => {
          const vals: Record<string, Rational> = { "line.qty": Rational.of(qty), "line.unitPrice": Rational.of(cents, 100), "doc.discountRate": Rational.of(bp, 10_000) };
          const env: Env = { get: (n) => vals[n], lookup: () => undefined };
          const scope: EncodeScope = {
            z,
            get: (n) =>
              n === "line.qty"
                ? intNV(z.Int.val(qty))
                : n === "line.unitPrice"
                  ? intNV(z.Int.val(cents), 100n)
                  : n === "doc.discountRate"
                    ? realRate
                      ? realNV(z.Real.val({ numerator: BigInt(bp), denominator: 10_000n }))
                      : intNV(z.Int.val(bp), 10_000n)
                    : undefined,
            lookup: () => undefined,
          };
          const expected = evaluate(e, env);
          const v = encodeValue(e, scope);
          if (v.k === "b") {
            const s = await z.simplify(v.t);
            expect(z.isTrue(s) || z.isFalse(s)).toBe(true);
            expect(z.isTrue(s)).toBe(expected);
          } else {
            const raw = v.c ?? rationalOf(z, (await z.simplify(v.t)) as never);
            const got = v.c ? raw : v.k === "i" ? raw.div(Rational.of(v.d)) : raw;
            expect(typeof expected).not.toBe("boolean");
            expect(got.eq(expected as Rational)).toBe(true);
          }
        },
      ),
      { numRuns: 300, seed: 1 },
    );
  }, 30_000);

  it("symbolic sale lines agree with computeDocument for random products, quantities and discounts", async () => {
    const z = await getZ3();
    const sale = saleOf(maya);
    const products = maya.catalogs.find((c) => c.id === "products")!.entries.map((e) => e.id);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...products), fc.integer({ min: 1, max: 10_000 }), fc.integer({ min: 0, max: 2_000 }), async (pid, qty, bp) => {
        const sym = buildSymbolicDoc(z, maya, sale, { K: 1, mode: "bound", lineEntries: [{ products: pid }] });
        const qv = sym.vars.find((v) => v.key === "line[0].qty")!;
        const rv = sym.vars.find((v) => v.key === "doc.discountRate")!;
        const s = new z.Solver();
        for (const a of sym.domain) s.add(a);
        s.add(qv.term.eq(qty), rv.term.eq(bp));
        expect(await s.check()).toBe("sat");
        const input = sym.extract(s.model());
        const want = computeDocument(asDef(sale), input, postingContext(maya)).computed.lines[0]!;
        const scope = sym.lineScopes[0]!;
        for (const f of ["gross", "discount", "net", "cost", "units"]) {
          const nv = encodeValue({ op: "var", name: `line.${f}` }, scope);
          if (nv.k === "b") throw new Error("bool");
          const raw = nv.c ?? rationalOf(z, s.model().eval(nv.t, true));
          const got = nv.c ? raw : nv.k === "i" ? raw.div(Rational.of(nv.d)) : raw;
          expect(got.eq(want[f]!)).toBe(true);
        }
      }),
      { numRuns: 40, seed: 2 },
    );
  }, 30_000);
});

describe("posting-rule synthesis", () => {
  const vocab = ["line.qty", "line.unitPrice", "doc.discountRate"];
  const ex = (q: number, p: string, r: string, out: string) => ({ inputs: { "line.qty": q, "line.unitPrice": p, "doc.discountRate": r }, output: out });

  it("recovers line.qty * line.unitPrice", () => {
    const r = synthesizePostingRule({ examples: [ex(6, "2.50", "0.1", "15.00"), ex(1, "3.00", "0", "3.00"), ex(2, "3.00", "0.2", "6.00")], vocabulary: vocab });
    expect(r.status).toBe("unique");
    if (r.status === "unique") expect(r.rule).toBe("line.qty * line.unitPrice");
  });

  it("recovers round2(line.qty * line.unitPrice * doc.discountRate)", () => {
    const r = synthesizePostingRule({
      examples: [ex(6, "2.50", "0.1", "1.50"), ex(1, "3.00", "0.2", "0.60"), ex(1, "0.99", "0.15", "0.15"), ex(6, "0.99", "0.1", "0.59")],
      vocabulary: vocab,
    });
    expect(r.status).toBe("unique");
    if (r.status === "unique") expect(r.rule).toBe("round2(line.qty * line.unitPrice * doc.discountRate)");
  });

  it("asks per-unit vs per-line rounding when the examples cannot tell", () => {
    const r = synthesizePostingRule({ examples: [ex(6, "2.50", "0.1", "1.50"), ex(1, "3.00", "0.2", "0.60"), ex(1, "0.99", "0.15", "0.15")], vocabulary: vocab, target: "the discount" });
    expect(r.status).toBe("ambiguous");
  });

  it("returns ambiguous with a sensible owner question for an underdetermined set", () => {
    const r = synthesizePostingRule({ examples: [ex(6, "2.50", "0", "15.00"), ex(1, "3.00", "0", "3.00")], vocabulary: vocab, target: "revenue" });
    expect(r.status).toBe("ambiguous");
    if (r.status !== "ambiguous") return;
    const rules = r.candidates.map((c) => c.rule);
    expect(rules).toContain("line.qty * line.unitPrice");
    expect(rules.some((x) => x.includes("1 - doc.discountRate"))).toBe(true);
    expect(r.question.text).toBe("For qty 6, unit price $2.50 and a 10% discount, should revenue be $15.00 or $13.50?");
    expect(Object.values(r.question.answersByCandidate).sort()).toEqual(["$13.50", "$15.00"]);
    // every candidate really fits the examples (ledger-core evaluator)
    for (const c of r.candidates) expect((evaluate(c.expr, { get: (n) => Rational.from(({ "line.qty": 6, "line.unitPrice": "2.50", "doc.discountRate": "0" } as Record<string, string | number>)[n]!), lookup: () => undefined }) as Rational).eq(Rational.parse("15"))).toBe(true);
  });

  it("uses catalog lookups and reports none when nothing fits", () => {
    const r = synthesizePostingRule({
      examples: [
        { inputs: { "line.qty": 2, "lookup(products.cost)": "0.80" }, output: "1.60" },
        { inputs: { "line.qty": 3, "lookup(products.cost)": "4.80" }, output: "14.40" },
      ],
      vocabulary: ["line.qty", "lookup(products.cost)"],
    });
    expect(r.status).toBe("unique");
    if (r.status === "unique") expect(r.rule).toBe("line.qty * lookup(products.cost)");
    const none = synthesizePostingRule({ examples: [{ inputs: { "line.qty": 2 }, output: "7.77" }], vocabulary: ["line.qty"], maxDepth: 2 });
    expect(none.status).toBe("none");
  });
});
