# @napkin/prover

Proofs that gate a Configuration before the platform loads it, plus posting-rule synthesis.
Everything here is **deterministic**: no LLM is involved. The solver is Z3 (`z3-solver` 5.3.1, WASM, in-process).
The rules we prove are the same DSL ASTs that `@napkin/ledger-core` executes, and every counterexample is
replayed through ledger-core `post()` before we report it.

```ts
import { proveConfiguration, proveBalance, proveDiscountStacking, flowCheck, synthesizePostingRule, encode, shutdown } from "@napkin/prover";
const report = await proveConfiguration(cfg); // packages/schema ProofReport
await shutdown();                              // stop Z3 worker threads so Node can exit
```

Run: `pnpm --filter @napkin/prover test` (16 tests, about 8 s) · `pnpm --filter @napkin/prover typecheck`
· `npx tsx scripts/report.ts` (prove Maya) · `scripts/broken.ts nodiscount|noround` · `scripts/discount.ts 0.20 0.75` · `scripts/synth.ts`.
`PROVER_DEBUG=1` prints every solver call with its result and time.

## What is proven

| API | Claim |
|---|---|
| `proveBalance(cfg, docTypeId)` | For every valid input that passes the document's checks (and its `when` conditions): signed debits − credits = 0, every rule amount is a whole number of cents, every register quantity is whole, and no division by zero happens. |
| `proveDiscountStacking(cfg)` | For every product, every qty 1..10000, and every base discount plus up to `maxCouponsPerOrder` coupons whose **total** passes the sale's checks (so it is ≤ `maxDiscount`), every line nets ≥ cost × (1 + marginFloor). The sale's own margin-floor check is left out on purpose: the claim is that the discount policy alone keeps the floor, so the runtime check never refuses a policy-compliant sale. Also: every refund the refund document's checks accept leaves the sale fully refunded or with retained ≥ saleCost × (1 + marginFloor) (decision D4). |
| `flowCheck(cfg)` | Structural, no solver: referenced accounts/registers exist and sides fit; each doc type with account rules has a debit and a credit; receivable/clearing accounts that are debited are also credited; every non-negative register has an "in" source. One-way accounts such as Payables are logged as notes. |
| `proveConfiguration(cfg)` | All of the above as a `ProofReport` with per-proof `durationMs`, the solver name and version, and a log. |

Valid inputs are: K = 1..3 lines; qty an integer in [1, 10000]; money a non-negative multiple of $0.01 up to $1,000,000;
rates multiples of 0.0001 in [0, 1]; policies fixed from the configuration; catalog-filled line fields
(`unitPrice`, `unitCost`, `stockUnits`, ...) are either free (first attempt) or the exact catalog values (fallback).

On Maya's configuration the whole report proves in about 0.75 s (sale balance about 0.4 s, discount proof about 0.12 s).

## How

**Exact encoding, mostly integers.** `encode` maps every DSL value to a scaled integer `t/d` (Z3 `Int` term `t`,
constant `d`): literals (`0.30` = 30/100), money (cents/100), qty, rates (basis points/10000), and every `+ - * min max`
and comparison over them. `round2(t/d) = floor((200t + d) / 2d) / 100` uses Z3 integer division, which is floor for a
positive divisor: the same arithmetic as `Rational.round2`. Z3 `Real` is used only for free `number` fields and for
division by a non-constant (with a side condition that the divisor is not zero); there `round2` uses `ToInt` (floor).
The fast-check property in the tests checks that this encoding agrees with the ledger-core evaluator on random expressions
and inputs, and that symbolic sale lines agree with `computeDocument`.

**Free first, then one query per catalog combination.** The balance proof first treats line fields as free inputs (the strongest
claim; Maya's sale proves this way because the debits and credits cancel algebraically). If that does not prove, it fixes which
catalog entry each line uses and asks one solver query per multiset of entries (lines are order-independent in the DSL), so
`qty * unitPrice` becomes `qty * constant` and stays linear. The discount proof always works per product.

**Never "proved" without unsat.** A timeout or `unknown` is reported as a failure that says "this is NOT a proof". Every
`sat` model is checked independently (each assertion is evaluated under the model) before it is used, then replayed
through ledger-core. A vacuity check makes sure some input passes the checks; otherwise the proof would be empty.

**Counterexamples and fixes.** Models are re-solved with "nice" constraints (small quantities, round-dollar prices,
whole-percent discounts) to get readable counterexamples. Failure details include the concrete `input` (replayable with
`post()`), the counterexample as strings, and a suggested fix that is **verified** by re-running the proof with it:
- imbalance equal to a derived field such as `line.discount` → debit it to a contra-revenue account such as "Discounts given" (4100);
- fractional cents → wrap the derived field in `round2(...)` where it is defined;
- discount floor → the exact max safe discount `1 − (1 + marginFloor) × cost / price` as a fraction (for Maya at 75%: `73/125 (58.4%)`,
  set by the box of 6), or the minimum price at the current cap.

**Synthesis.** `synthesizePostingRule({ examples, vocabulary, constants?, maxDepth = 4, target? })` enumerates programs bottom-up by size over
`+ - * (1 − x) round2 lookup(catalog.field)` with a small unit discipline (money, qty, rate) and observational-equivalence pruning
on the examples **plus fixed probe inputs**. The probes are what keep `qty * price` and `qty * price * (1 − discountRate)` apart
when every example has a 0% discount. Node values are computed with the ledger-core `evaluate`, and every returned rule is re-checked
on the whole expression. The simplest fitting rule wins. The result is `ambiguous` when several distinct rules have the minimal size, or
when a rule up to 3 nodes larger fits and reads an input the simplest one ignores. Then the prover picks the input that best splits the candidates
and asks, for example: *"For qty 6, unit price $2.50 and a 10% discount, should revenue be $15.00 or $13.50?"* Callers can pass
`describeInputs` to phrase it in business terms ("a box of 6"). It also catches rounding granularity: per-line vs per-unit rounding of
the discount gives a $0.59 vs $0.60 question.

## Honest limits

- **Bounded.** Documents are proven for 1..3 lines (`bounds.kMax`), qty ≤ 10000 and money ≤ $1,000,000. Line-scoped rules make a
  cart of K lines the sum of K independent lines, so larger carts are very likely fine, but that is not proven here.
- **Rates are basis points.** Rates are proven for every multiple of 0.0001 in [0, 1] (as PLAN §2 says). A rate like 1/3 is
  not covered. We tried exact Real rates: Z3 5.3.1's mixed Int/Real nonlinear solver returned models that did not satisfy the query
  (we caught them by checking the models), so rates are integers for now. `bounds.rateDenominator` can be raised.
- **Catalog binding is a naming heuristic** (`unitPrice` ← `products.price`, `unitCost` ← `products.cost`, by `lineKey`). It is only
  used when the free proof fails, and the message says which mode proved. Pass `bindings` to override it.
- **Discount proof assumptions.** It assumes the discount is the sale's `rate` field (base + coupons summed into it), and that
  lines are independent (checked: no line field reads a document total). The margin-floor goal is the sale's own margin check
  expression, or `line.net >= line.cost * (1 + policy.marginFloor)`. The refund proof checks the stated D4 property over all values of the
  platform-filled sale fields. It does not check that those fields match the referenced sale.
- **Flow check is structural.** It does not prove that money actually leaves an account, only that some document can move it.
- **Synthesis is bounded.** Depth ≤ 4, size ≤ 15, budget 400k programs. Probe inputs are fixed (seeded), so two rules that agree on all
  examples and probes are treated as the same rule.
- Maya's costs and stock are placeholders (`_unconfirmed` in the fixture). The discount numbers above use those placeholder costs.
