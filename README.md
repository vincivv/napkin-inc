<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-horizontal-dark.svg">
    <img src="docs/brand/logo-horizontal.svg" alt="Paper to Biz" height="56">
  </picture>
</p>

<p align="center">
  <b>From paper to a running business.</b><br>
  Photograph a notebook page and get a full back office (double-entry books, stock, documents and an audit trail, proven to balance), with a storefront, an AI phone line and AI staff running on top.
</p>

<p align="center">
  <a href="https://paperto.biz">paperto.biz</a> ·
  <a href="https://napkin-store.vercel.app/maya-cookies">Demo storefront</a> ·
  <a href="docs/DEMO.md">Demo script</a> ·
  <a href="redteam/RESULTS.md">Red-team results</a>
</p>

---

Built solo at **Cal Hacks 13.0**. Payments run in **Stripe test mode only**; no real money moves.

> **Core principle:** the AI talks and judges; deterministic code owns the money and the rules.
> Swap the language model for a worse one, or a hostile one, and every money guarantee still holds.

## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [Why you can trust it](#why-you-can-trust-it)
- [Tech stack](#tech-stack)
- [Repository layout](#repository-layout)
- [Running it locally](#running-it-locally)
- [Testing](#testing)
- [What's real and what's simulated](#whats-real-and-whats-simulated)
- [Documentation](#documentation)

## What it does

| Step | What happens |
|---|---|
| **1. Intake** | The owner photographs their notebook (several photos are read together) or describes the business by voice. Claude Opus 5.5 extracts facts: products, prices, costs, variants, add-ons, policies. Every fact keeps its quote, its region on the photo, and its provenance: *read from paper*, *owner said* or *inferred*. Inferred facts never reach money logic. |
| **2. Interview** | A deterministic question engine ranks what's missing by impact × uncertainty and asks one-tap questions. Money questions keep fixed wording; nothing about money is guessed. |
| **3. Compile** | Facts become a versioned **Configuration**: chart of accounts, catalogs, stock items, posting rules, discount and refund policies, AI staff limits. A dry run posts sample documents, and **Z3 proofs** (balance, discount stacking, flow) gate activation. If a proof fails, the shop does not go live. |
| **4. Run** | The configuration loads into the platform. The business gets a generated storefront, QR codes, a phone code on the shared AI phone line, and its AI staff identities. |

### The back office (the core)

A general-purpose accounting and inventory engine, configured per business rather than hard-coded:

- **Double-entry journal** with integer-cent amounts and exact rational math.
- **Documents** (sales, payments, refunds, payouts, expenses, stock adjustments) that move from draft → posted → reversed. Posted documents are immutable; corrections are reversals.
- **Registers** for stock and other balances, **periods** that can be closed, and an **audit log** of every change.
- **Roles with segregation of duties**: whoever creates a document can't approve it when the document type says so.
- **Reports**: trial balance, P&L, stock, margin by item, a sales tax report and accountant CSV exports, all computed from posted journal lines.
- **The official side**: expense entry with receipt reading (Claude vision pre-fills; the owner confirms), and a legal checklist linking to real IRS and SBA pages.

### What runs on top

- **Storefront** (`apps/store`): each business gets a generated design. Claude proposes the style, palette, fonts, wording and photo searches; code checks contrast and copy (no prices, numbers or invented claims). Photos are openly licensed from Openverse and credited. Prices and stock always come from the books. Checkout is Stripe Checkout.
- **AI phone line**: **+1 906-498-9806**, shared by every live shop. Callers say the shop's 4-digit code, then browse the live menu, order, and check order status by voice. Owner instructions given by phone are only queued; they apply after the owner confirms in the app.
- **AI staff**: Shopkeeper, Support and Bookkeeper on Claude Sonnet 5.5. Customers can chat with them on the storefront ("Ask the shop"), and each reply shows what the guards allowed, refused or sent to the owner. Escalations land in the owner's inbox, and the owner's answers become **precedents** the staff follow next time.
- **Owner app** (`apps/owner`, at [paperto.biz](https://paperto.biz)): sign-up and onboarding, a live dashboard with a sales chart, orders, documents, registers, reports, expenses, stock, the inbox, agent decisions, the proof report, the audit log, storefront editing and settings. One business per account.

## How it works

```
 owner app (Next.js, Vercel) ──HTTP + bearer──►  brain (Hono, Node 24)  ◄── Stripe webhooks
        │                                          │    ▲                ◄── Cartesia voice-agent tools
        │ live subscriptions (WebSocket)           │    │ reducer calls, one identity per role
        ▼                                          ▼    │
 SpacetimeDB "platform" module (system of record)  ◄── store app (Next.js, Vercel)
        ▲
  Z3 prover (called by the compiler before any configuration activates)
```

- **`platform/`** is a SpacetimeDB TypeScript module and the system of record. Every reducer is one ACID transaction; a thrown error rolls back the whole thing. The invariants are re-checked **inside** these transactions, so the platform is the last line of defense even if the brain is compromised.
- **`services/brain`** orchestrates everything that talks: intake, the interview, the compiler, the AI staff, the phone line, payments and the outbox. It calls the platform as separate SpacetimeDB identities (system, storefront, shopkeeper, support, bookkeeper), so authority comes from the identity's role, not from anything a model says.
- **`services/prover`** turns the posting-rule DSL into Z3 terms. The prover and the platform share one AST from `packages/ledger-core`, so **the rule that is proven is the rule that posts**.
- **The apps** subscribe to the platform directly for live data and call the brain for actions.

### Money

- Ledger amounts are integer cents (`bigint`); rates are basis points. There are no floats anywhere money moves.
- Rounding is `round2(x) = floor(100x + 1/2) / 100`, implemented identically in the runtime and in the Z3 encoding.
- Each sale posts revenue, discounts, tax, cost of goods sold and the stock movement. Each Stripe payment posts the net amount to clearing and the processor fee to its own expense account, using the fee from Stripe's balance transaction.

### The proofs

| Proof | Claim |
|---|---|
| **Balance** | For every valid input a document's checks accept, debits equal credits, every amount is a whole number of cents, and no division by zero happens. |
| **Discount stacking** | For every product, every quantity from 1 to 10,000, and every base discount plus up to the allowed number of coupons, each line nets at least cost × (1 + margin floor). Refunds the policy accepts can't break the floor either. |
| **Flow** | Every referenced account and register exists, every debited receivable or clearing account is also credited, and every non-negative register has a source. |

A proof counts only on `unsat`; a timeout is reported as "not a proof." Every counterexample is replayed through the real posting engine, and suggested fixes (for example the exact largest safe discount, as a fraction) are verified by re-running the proof. The prover can also **synthesize posting rules** from the owner's worked examples by bottom-up enumeration, and asks a distinguishing question when two rules fit equally well. Details and limits: [services/prover/README.md](services/prover/README.md).

## Why you can trust it

### The nine invariants

| # | Invariant | Enforced by |
|---|---|---|
| 1 | Every posted document balances. | ledger-core `post()`, platform, property tests |
| 2 | Ledger cash matches what the processor reports. | Processor-event postings, Bookkeeper reconciliation |
| 3 | Stock never goes negative unless backorders are allowed. | Platform register movements |
| 4 | No sale nets below cost × (1 + margin floor). | Z3 at compile time, platform checks at runtime |
| 5 | Segregation of duties. | Platform, guards |
| 6 | Prices and policies change only through the owner's channel. | Owner-only reducers, phone instruction queue |
| 7 | Exactly-once payments. | Event de-duplication in the posting transaction, outbox with idempotency keys |
| 8 | Posted documents are immutable; closed periods can't be posted to. | Platform reversals and period close |
| 9 | Agents act only through guarded platform APIs and leave a DecisionRecord. | `wrapTool`, guards, `decision_record` |

Invariants 1, 3, 4, 5, 6 and 8 are enforced inside platform transactions. See [docs/INVARIANTS.md](docs/INVARIANTS.md).

### Red team

45 runnable attacks (fake authority, coupon stacking, refund abuse, prompt injection, fake payment confirmations, bookkeeping manipulation and more), each run with guards off and guards on against the real platform:

| Mode | Breaches, guards off | Breaches, guards on | Money lost |
|---|---|---|---|
| Real Claude Sonnet 5.5 staff | 3 | **0** | $0 |
| Scripted "compromised model" that always attacks | 18 | **0** | $0 |

Chaos tests (crashes, timeouts, duplicate webhooks, restarts): 8 of 8 pass. Full methodology and every row: [redteam/RESULTS.md](redteam/RESULTS.md).

## Tech stack

| Layer | Technology |
|---|---|
| System of record | **SpacetimeDB** 2.13 (TypeScript module), hosted on maincloud |
| Formal verification | **Z3** (`z3-solver`, WASM, in-process) |
| Backend | **Node.js 24**, **Hono**, **zod** |
| Frontends | **Next.js 16**, **React**, **Tailwind CSS**, deployed on **Vercel** |
| AI | **Claude** Opus 5.5 (intake, compiler, storefront design, receipts, legal checklist), Sonnet 5.5 (AI staff, photo selection), Haiku 5.5 (phrasing, phone agent) |
| Voice | **Cartesia** (voice agent with webhook tools, `ink-whisper` speech-to-text) |
| Payments | **Stripe** test mode (Checkout, signed webhooks, refunds) |
| Images | Openverse (CC0, public domain, CC BY, CC BY-SA) |
| Tooling | TypeScript 7, pnpm 10 workspaces, vitest, fast-check, Cloudflare Tunnel |

## Repository layout

```
platform/              SpacetimeDB module: tables, reducers, reports (the back office)
packages/
  ledger-core/         Exact rational money, posting DSL, post() engine, invariant predicates
  schema/              zod contracts: Configuration, BusinessSpec, Fact, DecisionRecord, ProofReport
  stdb-bindings/       Generated SpacetimeDB client bindings
services/
  brain/               Orchestrator: intake, interview, compiler, guards, AI staff, phone, payments
  prover/              Z3 proofs and posting-rule synthesis
apps/
  owner/               Owner app (port 3001), served at paperto.biz
  store/               Storefronts, checkout and QR codes (port 3002)
redteam/               Attacks, chaos tests, planted-error books, runner, RESULTS.md
fixtures/              Demo business (Maya's Cookies) and a synthetic sample notebook page
scripts/               Demo stack, deploys, demo data
docs/                  Plan, handoff, demo script, invariants, brand assets
```

The product was renamed from Napkin to Paper to Biz during the hackathon; package names (`@napkin/*`), database names and some URLs keep the original name on purpose.

## Running it locally

**Requirements:** Node 24+, pnpm 10, the `spacetime` CLI 2.13. Optional: the Stripe CLI (test-mode checkout) and an Anthropic and a Cartesia key for the AI features.

```bash
pnpm install
cp .env.example .env          # fill in the keys you have; never commit .env
```

Then start each piece in its own terminal:

```bash
pnpm stdb                                   # local SpacetimeDB on 127.0.0.1:3000
pnpm publish:local && pnpm bootstrap        # publish the module, load the demo business
pnpm --filter @napkin/brain start           # brain on :4000
pnpm --filter @napkin/owner dev             # owner app on :3001
pnpm --filter @napkin/store dev             # storefront on :3002
```

- Without `STRIPE_SECRET_KEY`, payments use a clearly labeled **dev simulator**. With a test key (`sk_test_…`), run `stripe listen --forward-to localhost:4000/webhooks/stripe` and put its secret in `STRIPE_WEBHOOK_SECRET`. The brain refuses to start with a live key.
- The hosted demo runs with `scripts/demo-up.sh`, which supervises the brain, a Cloudflare tunnel and `stripe listen`, and redeploys and re-points the phone line if the tunnel changes. See [docs/HANDOFF.md](docs/HANDOFF.md#7-running-it).

## Testing

```bash
pnpm test                                   # unit and property tests across the workspace
pnpm typecheck                              # TypeScript across the workspace
pnpm --filter @napkin/prover test           # Z3 proofs, encoding agreement, synthesis
pnpm --filter @napkin/redteam run:real      # the full red-team run (calls the model)
```

Deterministic code (ledger-core, the prover encoding, guards, the question engine) is covered by fast-check property tests, including a check that the Z3 encoding agrees with the runtime evaluator on random expressions and inputs.

## What's real and what's simulated

**Real:** accounts and per-account businesses, Claude intake and AI staff, Z3 proofs, the SpacetimeDB back office, Stripe test-mode checkout, webhooks and refunds, the Cartesia phone line, generated storefronts, and the red-team numbers.

**Simulated or placeholder:**
- SMS is simulated; the phone agent reads the order number aloud and callers pay at [/pay](https://napkin-store.vercel.app/pay).
- Stripe test mode has no real bank, so payouts are processor events.
- The demo business's ingredient costs, starting stock and tax rate are flagged placeholders.
- All shops share one phone number; callers pick the shop by its code.
- The hosted backend currently runs on the builder's machine behind a Cloudflare tunnel.

Paper to Biz does not file taxes, apply for permits or give legal or tax advice. Full list: [docs/REAL_VS_SIMULATED.md](docs/REAL_VS_SIMULATED.md).

## Documentation

| Document | What's in it |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Original design: findings, architecture, interfaces, decisions |
| [docs/HANDOFF.md](docs/HANDOFF.md) | Full context: every component in depth, deployment, history, open decisions, gotchas |
| [docs/DEMO.md](docs/DEMO.md) | The 3–4 minute judge demo, plus what to do if something breaks |
| [docs/INVARIANTS.md](docs/INVARIANTS.md) | The nine invariants and where each is enforced |
| [docs/REAL_VS_SIMULATED.md](docs/REAL_VS_SIMULATED.md) | Exactly what is real, simulated or not built |
| [services/prover/README.md](services/prover/README.md) | What is proven, how, and the honest limits |
| [redteam/README.md](redteam/README.md) | How the attacks are run and scored |
| [docs/brand/](docs/brand) | Logo, mark and app icon in SVG and PNG |
