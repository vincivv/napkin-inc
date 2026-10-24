import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  Rational,
  parse,
  print,
  evaluate,
  evalNum,
  depth,
  type Expr,
  type Env,
  post,
  reversalOf,
  PolicyCheckError,
  UnbalancedPostingError,
  checkBalanced,
  applyMovements,
  checkStockNonNegative,
  checkSegregation,
  checkPeriodOpen,
  trialBalance,
  FractionalCentsError,
  type DocumentDef,
  type PostingContext,
} from "../src";
import maya from "../../../fixtures/maya/configuration.json";

const docDef = (id: string) => maya.documents.find((d) => d.id === id) as unknown as DocumentDef;
const ctx: PostingContext = {
  policies: Object.fromEntries(Object.entries(maya.policies).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>,
  catalogs: maya.catalogs.map((c) => ({ id: c.id, lineKey: c.lineKey, entries: c.entries as never })),
};
const product = (id: string) => maya.catalogs[0]!.entries.find((e) => e.id === id)!.data as Record<string, string>;
const saleLine = (productId: string, qty: number) => {
  const p = product(productId);
  return { productId, qty, unitPrice: p.price!, unitCost: p.cost!, stockItem: p.stockItem!, stockUnits: p.stockUnits! };
};

// A rate with at most 2 decimals in [0, max]
const rateArb = (maxHundredths: number) => fc.integer({ min: 0, max: maxHundredths }).map((h) => Rational.of(h, 100).toDecimal());

describe("Rational", () => {
  it("is exact where floats are not", () => {
    expect(Rational.parse("0.1").add(Rational.parse("0.2")).eq(Rational.parse("0.3"))).toBe(true);
  });
  it("round2 rounds half toward +infinity", () => {
    expect(Rational.parse("1.005").round2().toDecimal()).toBe("1.01");
    expect(Rational.parse("1.004").round2().toDecimal()).toBe("1");
    expect(Rational.parse("-1.005").round2().toDecimal()).toBe("-1");
  });
  it("refuses fractional cents", () => {
    expect(() => Rational.parse("0.333").toCents()).toThrow(FractionalCentsError);
  });
  it("property: round2 is idempotent, within half a cent, and always whole cents", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 12n), max: 10n ** 12n }), fc.bigInt({ min: 1n, max: 10n ** 6n }), (n, d) => {
        const x = Rational.of(n, d);
        const r = x.round2();
        expect(r.round2().eq(r)).toBe(true);
        expect(r.sub(x).cmp(Rational.of(1, 200)) <= 0).toBe(true);
        expect(x.sub(r).cmp(Rational.of(1, 200)) < 0).toBe(true);
        expect(() => r.toCents()).not.toThrow();
      }),
    );
  });
});

describe("DSL", () => {
  const env: Env = {
    get: (n) => ({ "line.qty": Rational.of(3), "line.unitPrice": Rational.parse("2.50"), "doc.discountRate": Rational.parse("0.15"), "policy.marginFloor": Rational.parse("0.3") })[n],
    lookup: (p) => (p === "products.cost" ? Rational.parse("0.8") : undefined),
  };
  it("parses and evaluates", () => {
    expect(evalNum(parse("round2(line.qty * line.unitPrice * (1 - doc.discountRate))"), env).toDecimal()).toBe("6.38");
    expect(evaluate(parse("line.qty * lookup(products.cost) * (1 + policy.marginFloor) <= 7.5 && !(line.qty == 2)"), env)).toBe(true);
  });
  it("never assumes a missing name", () => {
    expect(() => evaluate(parse("line.unknown + 1"), env)).toThrow(/unknown name/);
    expect(() => evaluate(parse("lookup(products.nope)"), env)).toThrow(/unknown name/);
  });
  it("rejects garbage", () => {
    expect(() => parse("1 +")).toThrow(SyntaxError);
    expect(() => parse("exec(1)")).toThrow(SyntaxError);
  });

  const leaf = fc.oneof(
    fc.constantFrom("line.qty", "line.unitPrice", "doc.discountRate").map((name): Expr => ({ op: "var", name })),
    fc.integer({ min: 0, max: 999 }).map((n): Expr => ({ op: "num", value: Rational.of(n, 100).toDecimal() })),
    fc.constant<Expr>({ op: "lookup", path: "products.cost" }),
  );
  const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
    e: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      leaf,
      fc.record({ op: fc.constantFrom("add", "sub", "mul", "min", "max"), args: fc.tuple(tie("e"), tie("e")) }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("round2"), arg: tie("e") }) as fc.Arbitrary<Expr>,
    ),
  })).e;

  it("property: print -> parse preserves meaning and is a fixpoint", () => {
    fc.assert(
      fc.property(exprArb, (e) => {
        const s = print(e);
        const e2 = parse(s);
        expect(print(e2)).toBe(s);
        expect(evalNum(e2, env).eq(evalNum(e, env))).toBe(true);
        expect(depth(e2)).toBeLessThanOrEqual(depth(e) + 1); // unary minus may add a level, nothing else
      }),
    );
  });
});

describe("posting: Maya's Cookies sale", () => {
  it("posts a mixed cart, balanced, with the right numbers", () => {
    const r = post(docDef("sale"), { fields: { orderId: "o1", discountRate: "0.10" }, lines: [saleLine("cookie_single", 2), saleLine("cookie_box6", 1), saleLine("sea_salt", 1)] }, ctx);
    expect(r.totalDebitCents).toBe(r.totalCreditCents);
    const tb = Object.fromEntries(trialBalance(r.journal).map((t) => [t.account, t.balanceCents]));
    expect(tb["4000"]).toBe(-2200n); // 6 + 15 + 1
    expect(tb["4100"]).toBe(220n);
    expect(tb["1200"]).toBe(1980n);
    expect(tb["5000"]).toBe(660n); // 1.60 + 4.80 + 0.20
    expect(r.computed.doc["total"]!.toDecimal()).toBe("19.8");
    const stock = r.movements.filter((m) => m.register === "stock");
    expect(stock.reduce((a, m) => a + m.qty, 0n)).toBe(8n); // 2 singles + 6 in the box
  });

  it("refuses a discount above policy (25%)", () => {
    expect(() => post(docDef("sale"), { fields: { orderId: "o2", discountRate: "0.25" }, lines: [saleLine("cookie_box6", 1)] }, ctx)).toThrow(PolicyCheckError);
  });

  it("refuses a missing field instead of assuming it", () => {
    expect(() => post(docDef("sale"), { fields: { orderId: "o3" }, lines: [saleLine("cookie_box6", 1)] }, ctx)).toThrow(/unknown name "doc.discountRate"/);
  });

  it("refuses a below-floor price even within the discount cap", () => {
    const cheap = { ...saleLine("cookie_single", 1), unitPrice: "1.00" };
    expect(() => post(docDef("sale"), { fields: { orderId: "o4", discountRate: "0" }, lines: [cheap] }, ctx)).toThrow(/margin_floor/);
  });

  const cartArb = fc.array(fc.tuple(fc.constantFrom("cookie_single", "cookie_box6", "sea_salt"), fc.integer({ min: 1, max: 40 })), { minLength: 1, maxLength: 6 });

  it("property (inv. 1 + 4): every allowed cart balances and clears the margin floor; discounts above 20% never post", () => {
    fc.assert(
      fc.property(cartArb, rateArb(40), (cart, rate) => {
        const input = { fields: { orderId: "p", discountRate: rate }, lines: cart.map(([p, q]) => saleLine(p, q)) };
        if (Rational.parse(rate).gt(Rational.parse(maya.policies.maxDiscount))) {
          expect(() => post(docDef("sale"), input, ctx)).toThrow(PolicyCheckError);
          return;
        }
        const r = post(docDef("sale"), input, ctx);
        expect(checkBalanced(r.journal)).toBeNull();
        for (const l of r.computed.lines) expect(l["net"]!.ge(l["cost"]!.mul(Rational.parse("1.3")))).toBe(true);
      }),
    );
  });

  it("property (inv. 8): a reversal exactly cancels the original", () => {
    fc.assert(
      fc.property(cartArb, rateArb(20), (cart, rate) => {
        const r = post(docDef("sale"), { fields: { orderId: "p", discountRate: rate }, lines: cart.map(([p, q]) => saleLine(p, q)) }, ctx);
        const rev = reversalOf(r);
        for (const row of trialBalance([...r.journal, ...rev.journal])) expect(row.balanceCents).toBe(0n);
        const bal = applyMovements(applyMovements(new Map(), r.movements), rev.movements);
        for (const b of bal.values()) expect(b.qty).toBe(0n);
      }),
    );
  });
});

describe("posting: refunds (D4: full, or partial that keeps the margin floor)", () => {
  // sale: box of 6 at $15, cost $4.80 -> floor $6.24
  const refund = (amount: string, refundedSoFar = "0", hours = 2) => ({ fields: { orderId: "o", amount, saleTotal: "15.00", saleNet: "15.00", saleCost: "4.80", refundedSoFar, hoursSinceSale: hours }, lines: [] });
  it("allows a full refund", () => expect(post(docDef("refund"), refund("15.00"), ctx).totalDebitCents).toBe(1500n));
  it("allows a partial refund that keeps the floor", () => expect(post(docDef("refund"), refund("8.76"), ctx).totalDebitCents).toBe(876n));
  it("refuses a partial refund one cent past the floor", () => expect(() => post(docDef("refund"), refund("8.77"), ctx)).toThrow(/refund_full_or_floor/));
  it("refuses after the 24h window", () => expect(() => post(docDef("refund"), refund("15.00", "0", 25), ctx)).toThrow(/refund_window/));
  it("refuses refunding more than was paid", () => expect(() => post(docDef("refund"), refund("1.00", "15.00"), ctx)).toThrow(/refund_not_over/));

  it("property: any sequence of accepted refunds leaves a fully refunded sale or one at/above the floor", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 1500 }), { maxLength: 8 }), (attempts) => {
        let so = 0n;
        for (const c of attempts) {
          try {
            post(docDef("refund"), refund(Rational.of(c, 100).toDecimal(), Rational.of(so, 100).toDecimal()), ctx);
            so += BigInt(c);
          } catch (e) {
            expect(e).toBeInstanceOf(PolicyCheckError);
          }
        }
        expect(so === 1500n || 1500n - so >= 624n).toBe(true);
      }),
    );
  });
});

describe("invariants", () => {
  it("detects unbalanced journals", () => {
    expect(checkBalanced([{ debitCents: 100n, creditCents: 0n }, { debitCents: 0n, creditCents: 99n }])?.code).toBe("unbalanced");
  });
  it("an unbalanced rule set cannot post", () => {
    const bad = structuredClone(docDef("sale"));
    bad.postingRules = bad.postingRules.filter((r) => r.id !== "sale.discount"); // the classic "forgot the discounts account" bug
    expect(() => post(bad, { fields: { orderId: "x", discountRate: "0.10" }, lines: [saleLine("cookie_box6", 1)] }, ctx)).toThrow(UnbalancedPostingError);
  });
  it("skipChecks (red-team baseline) skips policy checks but never the balance check", () => {
    const input = { fields: { orderId: "b", discountRate: "0.25" }, lines: [saleLine("cookie_box6", 1)] };
    expect(() => post(docDef("sale"), input, ctx)).toThrow(PolicyCheckError);
    expect(post(docDef("sale"), input, ctx, { skipChecks: true }).computed.doc.total!.toDecimal()).toBe("11.25");
    const bad = structuredClone(docDef("sale"));
    bad.postingRules = bad.postingRules.filter((r) => r.id !== "sale.discount");
    expect(() => post(bad, input, ctx, { skipChecks: true })).toThrow(UnbalancedPostingError);
  });
  it("property (inv. 3): selling more than stock is detected", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 1, max: 20 }), (stock, boxes) => {
        const open = applyMovements(new Map(), [{ register: "stock", dims: { item: "choc_chip_cookie" }, kind: "in", qty: BigInt(stock), amountCents: 0n }]);
        const r = post(docDef("sale"), { fields: { orderId: "s", discountRate: "0" }, lines: [saleLine("cookie_box6", boxes)] }, ctx);
        const after = applyMovements(open, r.movements.filter((m) => m.register === "stock"));
        const v = checkStockNonNegative(after, () => false);
        expect(v === null).toBe(stock >= boxes * 6);
      }),
    );
  });
  it("inv. 5 and 8", () => {
    expect(checkSegregation("shopkeeper", "shopkeeper", true)?.invariant).toBe(5);
    expect(checkSegregation("shopkeeper", "system", true)).toBeNull();
    expect(checkPeriodOpen("2026-09", new Set(["2026-09"]))?.invariant).toBe(8);
  });
});
