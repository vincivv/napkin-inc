# Handoff: Napkin Inc. (Cal Hacks 13.0), full context

Written Sat 2026-10-24, about 6 PM PT, at commit `4cf45ad`; sections 6, 7, 9 and 10 updated Sat night after
the storefront-design and demo-hardening work (history in section 8). The previous Claude session built the whole
project. The owner (GitHub `vincivv`) is switching Claude accounts, so this file has to carry everything
that session knew.

**Sections:**
1. The goal
2. Rules
3. The product, as a user sees it
4. Architecture
5. Each piece in depth
6. What is deployed
7. Running it
8. History
9. What I was doing last
10. What's left
11. Open decisions
12. Gotchas

**Other docs:**

| File | What it has | Status |
|---|---|---|
| `docs/PLAN.md` | Original architecture and decisions D1–D7 | Accurate |
| `docs/AGENT_BRIEF.md` | Rules for build agents | Accurate |
| `docs/INVARIANTS.md` | The nine invariants | Accurate |
| `docs/DEMO.md` | The 3–4 minute hosted judge demo, prep checklist and fallbacks | Accurate |
| `docs/MORNING.md` | Overnight log and decisions saved for the owner | Older than the accounts work |
| `docs/REAL_VS_SIMULATED.md` | What's real vs simulated | Accurate (rewritten Sat night) |
| `redteam/RESULTS.md` | Final red-team numbers | Accurate |

---

## 1. The goal

**Event:** Cal Hacks 13.0, Oct 23–25 2026, Palace of Fine Arts, SF. The owner is building solo.

| When | What |
|---|---|
| **Sun Oct 25, 9:00 AM PT** | **Devpost submission deadline** |
| 10:30 AM–12:30 PM | Judging, with a live demo |

**What the owner wants:**
- **A jaw-dropping demo that judges use themselves.** The judge is the input, something real happens within
  seconds, and a second beat escalates it.
- **Sponsor tech is plumbing, never the pitch.** The owner researched past winners (Cal Hacks, TreeHacks,
  HackMIT): grand prizes went to product-first ideas, and sponsor-wrapper projects didn't win. Light, honest
  sponsor touches are enough to qualify for tracks.
- **Judging criteria:** Application, Functionality/Quality, Creativity, Technical Complexity.

**The pitch:** "From a napkin sketch to a running business." A small-business owner photographs a napkin
menu, or just talks it through. Minutes later they have:
- a storefront with QR codes and real (test-mode) card checkout;
- an AI phone line that takes orders;
- three AI staff: Shopkeeper, Support, Bookkeeper;
- a 1C-style double-entry back office whose books are **proven** to balance with Z3.

**The core principle**, which drives every design decision and is the story for the judges:

> **The AI does the talking and judgment; deterministic code owns the money and the rules.**

If the LLM were swapped for a hostile one, no money guarantee may break. The red team measured exactly that:

| Run | Breaches without guards | Breaches with guards | Money lost |
|---|---|---|---|
| Real Claude Sonnet 5.5 staff | 3 | **0** | $0 |
| Scripted "compromised model" | 18 | **0** | $0 |

The demo persona is **Maya's Cookies**: a single cookie for $3, a box of 6 for $15, and a +$1 sea-salt
topping.

## 2. Rules from the owner (never relax them)

1. **Secrets stay in `.env` only** (repo root, gitignored).
   - Never print, echo, log or commit them; read them with `grep … | cut` inside commands.
   - `.env.example` lists the names: `ANTHROPIC_API_KEY`, `ANTHROPIC_WORKSPACE_ID`, `CARTESIA_API_KEY`,
     `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SPACETIMEDB_URI`, `SPACETIMEDB_DB`, `PHONE_TOOL_SECRET`,
     `PHONE_BUSINESS_ID`, `TWILIO_*`, `OWNER_PHONE`, `OWNER_PIN`, `STORE_PUBLIC_URL`, `OWNER_APP_URL`,
     `BRAIN_URL`, `MAYA_ACCOUNT_EMAIL`, `MAYA_ACCOUNT_PASSWORD`.
2. **Stripe TEST MODE only.** The brain refuses to start with an `sk_live`/`rk_live` key. No real money.
3. **Never invent business facts** (prices, costs, stock, locations). Facts carry provenance, and unconfirmed
   facts are asked about, never guessed.
4. **Never touch the shared local `napkin` SpacetimeDB database from experiments.** Use a scratch database
   such as `napkin-x`. The hosted database `napkin-inc-mayas` on maincloud is the live demo; be careful
   with it.
5. **The repo is private** (`github.com/vincivv/napkin-inc`). It must go public before Devpost (decision
   D7), but **ask the owner first.**
6. **Standing permission (verbatim):** "create whatever u need, github repo, connectors etc. U have access to
   my google chrome through connector, if u need anything else, u have my full permission. Also, spin up
   multiple agents to do the job faster." Choose each agent's model by difficulty. Run **at most 3 subagents
   at once**; 6 tripped rate limits.
7. **Commit messages end with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Parallel agents
   work in their own worktree and branch; the lead session merges to `main` after checking.
8. **Safety:** the previous session would not type passwords or create accounts on public (non-localhost)
   sites, so the owner does live sign-in tests. Test credentials on `localhost` are fine.
9. **How the owner likes to be talked to:** casual and fast-typing, often with typos. They want plain
   language, the outcome first, and concrete steps. They are not a deep backend person; say what they can
   click or see.

## 3. The product, as a user sees it

### A new business owner, on the owner app (https://napkin-owner.vercel.app)

1. **Landing page:**
   - a hero with a napkin-to-storefront visual;
   - how it works, and what you get;
   - the money-rules section with the red-team bars (3 to 0 and 18 to 0, from 45 attacks);
   - the invariants;
   - a **Start your business** button, plus Sign in.
2. **Sign up** with email and password, at least 8 characters.
3. **Name your business.** The name becomes the slug, e.g. "Sam's Tacos" becomes `sams-tacos`. **There is
   one business per account**, and the brain refuses a second one with a 409.
4. **Setup steps**, shown as a three-step header:
   1. **Your napkin** (`/intake`): upload a photo or type or record a description. Claude Opus 5.5 extracts
      facts, each with its quote and image region.
   2. **Money questions** (`/interview`): one question at a time, the money ones first, in exact template
      wording. There is a money-ready checklist, and "Something changed? Tell me" proposes a diff.
   3. **Go live** (`/build`): compile, then watch progress stream:
      - facts check;
      - template;
      - posting-rule synthesis;
      - dry run and Z3 proofs;
      - configuration;
      - storefront theme (proposed by Opus);
      - AI staff;
      - submit to the books and activate.
5. **Live:** the app switches to the back office for *their* business only. The owner role is granted
   automatically (`OwnerAutoGrant`). Pages:

   | Page | Shows |
   |---|---|
   | Dashboard | Books-balance banner, sales, orders, Stripe clearing, bank, fees, gross margin, stock, receivables, recent decisions |
   | Orders | All orders, filterable by status |
   | Documents | Every document (sale, payment, refund…) |
   | Registers | Stock and other registers |
   | Reports | Trial balance, P&L (with operating expenses), **sales tax by month or quarter**, **For your accountant** CSV downloads (journal, trial balance, sales tax), stock, receivables, payables, cash flow, margin by item |
   | Expenses | Rent, supplies, wages, utilities, other. Snap a receipt: Opus reads vendor, date, total and a category as a pre-fill; the owner checks it, picks paid now (Cash 1000) or owed (Payables 2000), and saves. It posts immediately as an `expense` document. Shops compiled before this existed see "Recompile on the Build page" |
   | Getting legal | A checklist: six basics every US small business needs (structure and registration, EIN, licenses, sales tax permit, insurance, bank account) with official IRS/SBA links, plus items tailored by Opus to what the shop sells and where (links kept only if `.gov`-style and they resolve). Done / Not needed / To do with notes. A starting list, not legal advice; Napkin files nothing. Also linked from the setup header and from Build once live |
   | Inbox | Agent escalations for the owner to answer |
   | Decisions | Every DecisionRecord |
   | Audit log | Everything that changed |
   | Proof report | The Z3 results |
   | Intake / Interview / Build | Still there for changes after launch |

   The sidebar footer shows the account email and **Sign out**. There is no business switcher.

### A customer, on the store (https://napkin-store.vercel.app)

- **`/<slug>`:** the shop, with live stock ("42 left"), a cart and add-ons.
- **Checkout:** a real Stripe test checkout (card `4242 4242 4242 4242`).
- **`/<slug>/order/<id>`:** flips to "Thank you… paid" live.
- **`/<slug>/qr`:** a QR sheet.
- **`/<slug>/item/<entryId>`:** an item page.
- **`/pay`:** a customer types a phone order's number to pay. The page fixes common typos (O→0, I/L→1) and
  redirects to the brain's `/p/<orderId>`, which goes on to Stripe.
- **`/`:** lists every business. This is a known gap: it includes test businesses.

### A caller, on the phone line (+1 906-498-9806, shared by every live shop)

- One number serves every live shop. Each shop has a **4-digit phone code**, assigned the moment it goes
  live and saved in `phone-codes.json` in the brain's data folder (never changes). The agent asks for the
  code and `find_shop` ties the call to that shop; if the caller has no code it falls back to the shop name
  (fuzzy match) and the agent confirms the shop. Every other tool then acts for that shop only,
  server-side, per conversation. The code is shown on the store (pickup section, footer), the QR sheet, and
  the owner's Build page and dashboard, all from public `GET /phone/code/:businessId`.
- The Cartesia voice agent (Claude Haiku 5.5, voice "Skylar") can do these things, through 8 webhook tools
  on the brain:
  - read the menu (`menu_lookup`);
  - place an order (`place_order`);
  - check an order's status (`order_status`);
  - escalate (`escalate`).
- **Paying:** there's no Twilio, so SMS is a simulator. The agent spells the order number aloud and tells the
  caller to pay at `napkin-store.vercel.app/pay`.
- **Owner mode:** the owner can verify (`verify_owner`: caller ID plus PIN, locked after 3 failures), get a
  report (`owner_report`), and give instructions (`owner_instruction`). Instructions only **queue**; they
  apply after the owner confirms in the app (invariant 6). Owner mode exists only for the shop
  `PHONE_BUSINESS_ID` names (Maya's), and it is **off** right now because `OWNER_PHONE` is empty in `.env`.

## 4. Architecture

```
 owner app (Next 16, Vercel) ──HTTP+Bearer──► brain (Hono, Node 24, on the Mac :4000) ◄── Stripe webhooks (stripe listen)
        │                                         │   ▲                                     ◄── Cartesia tool webhooks
        │ live subscriptions (WebSocket)          │   │ reducer calls, as per-role identities
        ▼                                         ▼   │
 SpacetimeDB "platform" module (maincloud DB napkin-inc-mayas) ◄── store app (Next 16, Vercel) subscribes + calls brain
        ▲
  Z3 prover (services/prover, called by the compiler)
```

| Package | Role |
|---|---|
| **`platform/`** | SpacetimeDB 2.13 TypeScript module, the system of record (the "1C"). Reducers re-check invariants inside each transaction; throwing rolls it back. **It is the last line of defense:** even a compromised brain can't break invariants 1, 3, 4, 5, 6 or 8. |
| **`packages/ledger-core`** | Exact `Rational` math (bigint, no floats); the posting DSL (`parse`/`evaluate`/`print`); the `post()` engine; invariant predicates. **The prover proves the same AST that the platform executes.** Frozen contract. |
| **`packages/schema`** | zod contracts: `Configuration`, `BusinessSpec`, `Fact` (value, provenance paper/owner_said/inferred, confidence, source, confirmed), `DecisionRecord`, `ProofReport`, `usableForMoney()`. Frozen contract. |
| **`packages/stdb-bindings`** | Generated client bindings, regenerated with `pnpm --filter @napkin/platform generate`. |
| **`services/brain`** | The orchestrator, a Hono HTTP server. Every piece is described in section 5. |
| **`services/prover`** | Z3 (z3-solver): balance, discount-stacking and flow proofs, plus posting-rule synthesis from worked examples. Proofs are bounded: 1–3 lines, quantity ≤ 10,000, rates in 0.01% steps. |
| **`apps/owner`** | Next.js 16 owner app (port 3001). |
| **`apps/store`** | Next.js 16 storefront (port 3002). |
| **`redteam/`** | Attack, chaos and planted-error runner. |
| **`fixtures/maya/`** | The hand-written M1 configuration, plus a synthetic napkin image and voice transcript. |

**Money:**
- Integer cents everywhere in the ledger; rates in basis points.
- The margin-floor check is `net_cents*10000 >= cost_cents*(10000+floor_bps)`.
- Rounding is `round2(x) = floor(100x + 1/2)/100`.

**Authority:**
- Every actor is a SpacetimeDB identity with a role in `role_grant`/`actor`: system, storefront,
  shopkeeper, support, bookkeeper, owner.
- Agents simply don't hold the owner's permissions, so injected text has no path to change a price or
  policy.

**Platform tables:** `business`, `config_version`, `actor`, `role_grant`, `catalog_item`, `document`,
`journal_line`, `register_movement`, `register_balance`, `period`, `customer_order`, `payment_intent_log`,
`processor_event`, `outbox`, `decision_record`, `inbox_item`, `precedent`, `owner_statement`, `audit_log`.

**Platform reducers:** `claimSystem`, `createRoleGrant`, `redeemRoleGrant`, `registerBusiness`,
`submitConfiguration`, `activateConfiguration`, `rejectConfiguration`, `createOrder`, `updateOrderStatus`,
`createDocument`, `postDocument`, `reverseDocument`, `closePeriod`, `requestRefund`, `logPaymentIntent`,
`attachCheckoutSession`, `recordProcessorEvent`, `claimOutbox`, `completeOutbox`, `enqueueOutbox`,
`recordDecision`, `openInbox`, `answerInbox`, `queueOwnerStatement`, `decideOwnerStatement`,
`markOwnerStatementApplied`.

**Chart of accounts (item_seller template):**

| Code | Account |
|---|---|
| 1000 | Bank |
| 1010 | Stripe clearing |
| 1200 | Receivables |
| 1300 | Inventory |
| 2000 | Payables |
| 2100 | Sales tax payable |
| 4000 | Sales revenue |
| 4100 | Discounts given |
| 4200 | Refunds |
| 5000 | Cost of goods sold |
| 5100 | Processor fees |

**Postings:**
- **Sale** (posted when paid): Dr 1200 / Dr 4100 discount / Cr 4000 / Cr 2100 tax, plus Dr 5000 / Cr 1300 at
  cost, with stock going out.
- **Payment:** Dr 1010 net / Dr 5100 fee / Cr 1200.
- **Refund:** Dr 4200 / Cr 1010.
- **Payout:** Dr 1000 / Cr 1010.

**The nine invariants** (`docs/INVARIANTS.md`):
1. Balanced entries.
2. Ledger cash equals what the processor reports.
3. Stock ≥ 0.
4. Margin floor.
5. Segregation of duties.
6. Policies change only through the owner channel.
7. Exactly-once payments.
8. Posted documents are immutable.
9. Agents act only through guarded platform APIs, with DecisionRecords.

## 5. Each piece in depth

### Brain HTTP routes (`services/brain/src`)

| Area | Routes |
|---|---|
| Health | `GET /health`: STDB connection, Stripe mode, bootstrap state per business, outbox, phone status |
| Accounts | `POST /accounts/signup`, `/accounts/login`, `/accounts/logout`; `GET /accounts/me` (account plus `businessLive`); `POST /accounts/business {name}` (409 if the account already has one); `POST /accounts/owner-grant` (one-time code; the owner app's per-account STDB identity redeems it for the owner role; 409 if no business, or the business isn't live) |
| Owner PIN | `POST /auth/owner`: the old PIN login, now **restricted to the phone business** (`PHONE_BUSINESS_ID`) |
| Intake | `POST /intake/photo`, `POST /intake/voice`, `POST /intake/merge`, `GET /intake/photo/:businessId` |
| Spec and questions | `GET /spec/:businessId`, `GET /questions/next`, `POST /questions/:id/answer`, `POST /questions/:id/dismiss` |
| Owner statements | `POST /owner/statement`, `GET /owner/statements`, `POST /owner/statement/:id/decide`: "something changed" diffs, plus phone instructions waiting for confirmation |
| Compiler | `POST /compile` (streams progress), `GET /compile/:businessId/latest` |
| Payments | `POST /checkout`, `GET /p/:orderId` (pay link, 303 to Stripe), `POST /webhooks/stripe` (signature verified), `POST /dev/simulate-payment/:orderId` (simulator only) |
| AI staff | `POST /agents/:role/message`, `POST /ask`. Bookkeeper and `/ask` need the owning account; Shopkeeper and Support are public (store chat) and rate-limited. |
| Phone | `POST /phone/tools/:name`: Cartesia webhook tools, bearer `PHONE_TOOL_SECRET` |
| Expenses | `POST /expenses/receipt` (multipart `businessId` + `image`: stores it under `dataDir/receipts/`, returns the Opus read as a pre-fill), `GET /expenses/receipt?businessId=&ref=`. The expense itself is a `createDocument` from the owner app |
| Getting legal | `GET /legal/:businessId`, `POST /legal/:businessId/location {city,state}`, `POST /legal/:businessId/generate`, `PATCH /legal/:businessId/items/:itemId {status?,note?}`; stored in `dataDir/legal/` |

**The account gate** (`businessGate` in `accounts/index.ts`) protects
`/intake/*, /spec/*, /questions/*, /owner/*, /compile, /compile/*, /expenses/*, /legal/*` (the storefront
design routes mount it per route):
- It collects every businessId the request names: the path, the query, and (for POSTs without one in the
  path) the body, multipart or JSON. Every one of them must be the caller's own.
- The answer is **401** with no session, **403** if any of them is another business, and **400** when there's
  no businessId.

**Accounts store details:**
- **Storage:** `dataDir/accounts.json`.
- **Passwords:** scrypt, N=16384.
- **Sessions:** bearer tokens stored as sha256 hashes, with a 7-day TTL.
- **Rate limits:** login and sign-up allow 20 per 15 minutes per client and 300 globally. The client key
  prefers `cf-connecting-ip` when the request comes through the tunnel.
- **Slugs:** a slug is unique against both the platform and the spec store; a suffix is added on collision.
- **Maya's seed:** `ensureSeedAccount` creates Maya's account from `MAYA_ACCOUNT_EMAIL`/`PASSWORD` on start,
  if the account doesn't exist and `maya-cookies` is unclaimed.

### Intake (`intake/`)

- `extract.ts` sends the photo or text to Claude Opus 5.5 with a tool schema.
  - **Opus 5.5 rejects forced tool calls**, so the call uses auto tool choice plus an instruction, validated
    with zod.
  - Each fact keeps its quote and image region.
- **Voice:** `/intake/voice` uses Cartesia speech-to-text.
- `merge.ts` merges photo and voice facts. A conflict becomes a question with candidates.
- **Timing:** reading a photo takes about 8 s.

### Question engine (`questions/engine.ts`)

The engine is deterministic: impact scoring decides what to ask next. The LLM may only rephrase non-money
questions; money questions keep their exact template wording.

- **`refreshQuestions(spec)`** regenerates the open questions from the facts:
  1. `withRequiredPlaceholders` first adds "missing" placeholders for stock fields the photo never
     mentioned.
  2. Then it opens one question per fact that isn't `usableForMoney`.
  3. It also opens one per entry in **`invalidFacts(spec)`**: confirmed facts the compiler would refuse.
     That covers the compiler's validators (`moneyFacts` in `compiler/facts.ts`) and the per-unit stock-cost
     consistency check (`stockCostProblems`).
- **`applyAnswer`** coerces the answer per field kind (`spec/coerce.ts`).
  - It **rejects** an answer that would leave the field invalid.
  - It refuses to "confirm" an invalid value.
- **`moneyBlockers`** returns why each money fact blocks: missing, guess, unconfirmed or invalid.
- **Stale specs:** `routes.ts` `withFreshQuestions` regenerates and saves the questions of a stored spec
  whenever it's read, so specs saved under older rules heal themselves.
- **Field kinds:**

  | Kind | Fields | Rule |
  |---|---|---|
  | `money` | prices, costs | |
  | `pct` | `taxRate` | a fraction: "0.0725" |
  | `points` | `marginFloorPct`, `maxDiscountPct` | percent points: "20" = 20%; a bare 0–1 is refused with "add a %"; over 100 is refused |
  | `hours` | | |
  | `qty` | `stockUnits` | a whole number ≥ 1 |
  | `int` | `initialStock` | |
  | others | | bool, fulfillment, currency, methods, list, text |

### Compiler (`compiler/`)

1. **Facts check:** `checkMoneyFacts` lists every offending field.
2. **`fillTemplate`:** catalogs, stock items and policies from the `item_seller` template.
   - It raises owner questions on conflicts.
   - There is one stock item per tracked offering, so **all variants must agree on cost per unit of stock**.
3. **Posting-rule synthesis** from the owner's worked examples, if there are any. Otherwise it uses the
   template's rules.
4. **Dry run** (16 sample postings) and **Z3 proofs** (balance, discount, flow).
5. **Configuration vN.**
6. **Storefront:** Opus proposes the theme, emoji, font, headline and tagline, validated against limits.
7. **AI staff:** tools and limits per role.
8. **Submit** to the platform, and activate on the first version (bootstrap activation).
9. **`grantActors()`** (`bootstrap.ts`) creates the storefront, shopkeeper, support and bookkeeper
   identities for the new business. Without them a new business can't take orders.

Compile plus activation takes about 6 s. Refund limits per role default to 0, so every agent refund goes to
the owner.

### Guards (`guards/`)

Every agent tool call goes through `wrapTool`, then a guard check, then the platform, then a
`DecisionRecord`. Rule ids:
- `inv4.margin_floor`, `inv4.ledger_accepts`
- `inv5.sod`, `inv5.sod_ok`
- `inv6.owner_only`, `inv6.owner_app`, `inv6.catalog_prices`, `inv6.phone_needs_app_confirmation`
- `refund.not_over`, `refund.ledger_accepts`
- `approval.role`
- `catalog.unknown_product`, `order.unknown`, `document.*`

**Refund limits apply per order, and pending drafts count against them.** The red team found the
split-refund hole that made this necessary, and it's fixed.

### AI staff (`agents/`)

All three run on Claude Sonnet 5.5.

| Role | Tools |
|---|---|
| Shopkeeper | `menu_lookup`, `quote`, `create_order`, `escalate` |
| Support | `order_status`, `request_refund`, `escalate` |
| Bookkeeper | `ledger_read`, `approve_refund`, `reconcile`, `escalate` |

- **Escalations** open inbox items. The owner's answers become `precedent` rows, which are fed back to the
  agents.
- **Coupons:** there's no coupon list, so all codes are refused.

### Payments (`payments/`)

- **Checkout:** the brain logs a payment intent, then creates a Stripe Checkout session.
- **Webhook:** `recordProcessorEvent` de-duplicates by event id **in the same transaction** as posting
  (invariant 7).
- **Side effects:** Stripe refunds and SMS go through the platform `outbox` with idempotency keys.
- **Simulator:** used only if no Stripe key is set. Today the real test key is set.

### Phone (`phone/`)

- **`cartesia-agent.ts`** holds the agent's prompt and config. It tells the agent to spell the order number
  and follow the `say` field the tools return.
- **`tools.ts`** has the 8 tools, `find_shop` first. The shop each call is bound to lives in memory
  (`ConversationShops`, 2 h); after a brain restart the agent just asks again. `smsSay` produces the "pay at …/pay, order number X" line when no text was
  sent.
- **`sms.ts`:** Twilio adapter or simulator.
- **`scripts/cartesia-setup.ts`** creates or updates the agent and tools (see section 7). It reads the live
  shop names from the brain (`GET /phone/shops`) as speech-to-text keyterms; a shop that goes live later is
  still found by `find_shop`, and the next setup run (every tunnel change) adds its name.
- **Why one number:** Cartesia includes 1 number on the free plan (3 on Pro, 5 Startup, 10 Scale), plus
  per-minute charges, so a number per business doesn't scale for free. A dedicated number could be a paid
  upgrade later.
- **Number provisioning:** the Cartesia dashboard didn't show a way to claim a number, so it was claimed
  through the API: `POST https://api.cartesia.ai/agents/phone-numbers/provision`.

### Red team (`redteam/`)

- **Assets:** 57 attacks in 12 categories (45 runnable), 11 chaos cases, and 2 planted-error books with an
  answer key.
- **Modes:** baseline (the same module published with `ENFORCE=false`, guards off) vs napkin.
- **Results:** in `redteam/RESULTS.md`:

  | Table | Baseline | Napkin |
  |---|---|---|
  | Real model | 3 breaches | **0** |
  | Compromised model | 18 breaches | **0** |
  | Chaos | 8/8 pass | 8/8 pass |
  | Bookkeeper on planted books | set A 56% precision / 83% recall | set A 75% / 100%; set B 100% / 100% |

  Money lost was $0 in every run.
- **Not run:** 12 attacks, which need the phone channel, a sale older than 24 hours, or a name over 64
  characters.

### Owner app internals (`apps/owner`)

- **`app/providers.tsx`** is the gate. `AccountProvider` drives these states:

  | State | Renders |
  |---|---|
  | loading | `BootScreen` |
  | unreachable | Retry screen |
  | signed out | `/signup` → `SignUpScreen`, `/signin` → `SignInScreen`, anything else → `Landing` |
  | signed in, no business | `NameBusinessScreen` |
  | business not live | `DataProvider`, then `SetupShell` |
  | business live (`activeConfigId` ≠ 0) | `Shell`, plus `OwnerAutoGrant`, which retries every 5 s on failure |
- **`src/data/account.tsx`:** the session token lives in localStorage `napkin-owner:session`, and
  `authHeaders()` attaches it.
- **`src/data/env.ts`:** `tokenKey(uri, db, accountId)` gives each account its own SpacetimeDB identity
  token.
- **`src/data/context.tsx`:** `DataProvider({businessId, accountId})` is live-only. Preview mode and the
  business switcher were removed.
- **`src/lib/brain.ts`:** API calls. Photos load with `photoObjectUrl` (an authenticated fetch that returns a
  blob URL).
- **`src/components/onboarding.tsx`:** the sign-up, sign-in and naming screens, `SetupShell` and
  `OwnerAutoGrant`.
- **`src/components/landing/Landing.tsx`**, plus the `/* ---- landing ---- */` section of `globals.css`.
- **`app/signin/page.tsx` and `app/signup/page.tsx`** return null; the gate renders those screens.

**Tests:** the brain has 188 passing (`pnpm --filter @napkin/brain test`). There are also ledger-core,
platform, prover and redteam suites; `pnpm test` runs everything. `pnpm typecheck` is clean.

## 6. What is deployed (the hosted demo)

| Piece | Where |
|---|---|
| Owner app | https://napkin-owner.vercel.app. Vercel team `power-of-love` (`team_Etn72hUqGT17AAqVNuULBgIb`), project `prj_Ix1DAhcegnD5Cu3dq1bRkseJG0VJ` |
| Store | https://napkin-store.vercel.app, project `prj_A1WVgYTDOQqYuPv7rJIOJhxefo2R`. Maya's shop: `/maya-cookies`; phone payments: `/pay` |
| Database | SpacetimeDB maincloud, database **`napkin-inc-mayas`**. It holds `maya-cookies`, `maya-cookies-baseline`, and businesses created during tests |
| Brain | **On the owner's Mac**, behind a Cloudflare quick tunnel. The URL changes whenever the tunnel is replaced; the current one is in `.demo/deployed-url` |
| Phone | +1 906-498-9806 (id `ap_KugXKLtEEEvLtNcN58QoEz`), agent `agent_pPr1iGCEp3DS5YX4G9GTYB`, model `claude-haiku-5.5`, voice Skylar `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4` |
| Stripe | Test sandbox "Erketoys". `STRIPE_WEBHOOK_SECRET` (from `stripe listen`) is already in `.env` |
| SMS | Simulator only. Twilio was skipped because the trial balance was $0 |

**Vercel projects:** both use `rootDirectory` `apps/<x>`, Node 24, with source files outside the root
directory included.

**`NEXT_PUBLIC_*` values are baked in at build time:** the brain URL, `wss://maincloud.spacetimedb.com`, the
database name, and the store and owner URLs.

**Logins:**
- **Maya:** `maya@mayascookies.test`. The password is in `.env` as `MAYA_ACCOUNT_PASSWORD`; never show it in
  chat.
- **Test account `sam-test@napkin.test`:** exists only in the **local** brain's data.

**Gitignored state that must never be lost** (back it up before experiments):
- **`services/brain/.data-cloud/`:** the hosted brain's maincloud identities (the system identity owns
  `napkin-inc-mayas`), plus accounts, sessions, phone orders, shop phone codes and storefront designs. Without it the hosted brain can't act as
  the system or as its actors.
- **`services/brain/.data/`:** the same for the local `napkin` database, plus specs.

The `.data-*/` folders are covered by `.gitignore`, and `.vercelignore` excludes `.env` and the data
folders. It was verified that `.env` is not served from either Vercel deployment.

## 7. Running it

### Hosted demo: one command on the owner's Mac (from the repo root)

```bash
scripts/demo-up.sh
```

It runs and watches everything the hosted demo needs:
- the brain on :4000 against maincloud (`scripts/brain-cloud.sh`);
- a Cloudflare quick tunnel;
- `stripe listen`, forwarding webhooks to the brain (key read from `.env`).

Every 30 s it checks them. If the brain or `stripe listen` exits, it restarts it. If the public `/health`
fails 3 times in a row (a quick tunnel dies on any network drop), it opens a new tunnel and does the URL
change by itself: restart the brain with the new `BRAIN_PUBLIC_URL`, redeploy both Vercel apps
(`scripts/deploy-web.sh both`), and point the Cartesia phone agent at the new URL. Recovery takes about
2 minutes. The deployed URL is kept in `.demo/deployed-url`, so restarting the script with the same tunnel
skips the redeploy. Logs: `.demo/{brain,tunnel,stripe,deploy,cartesia}.log`. Ctrl-C stops everything.

Also keep the Mac awake: `caffeinate -dimsu -t 36000` (lid open, on AC power).

Health check:

```bash
curl -s "$(cat .demo/deployed-url)/health"
```

You want `"ok":true`, `bootstrap.ok`, both businesses registered, and `stripe.mode` `test`.

`scripts/brain-cloud.sh` sets these and then runs `pnpm --filter @napkin/brain start`, which loads `.env`
through `tsx --env-file-if-exists`:
- the maincloud URI and database;
- `BRAIN_DATA_DIR=services/brain/.data-cloud`;
- the store and owner URLs;
- `BRAIN_URL`.

CORS allows the two Vercel origins and localhost 3001/3002.

**Doing a URL change by hand** (only if the script can't): restart the brain with the new
`BRAIN_PUBLIC_URL`, run `BRAIN_PUBLIC_URL=<new> scripts/deploy-web.sh both`, then:

```bash
cd services/brain && npx tsx --env-file-if-exists=../../.env scripts/cartesia-setup.ts <new url> \
  --model claude-haiku-5.5 --voice db6b0ed5-d5d3-463d-ae85-518a07d3c2b4 --phone-number-id ap_KugXKLtEEEvLtNcN58QoEz
```

Add `--dry-run` first to print the requests without sending them.

A **named Cloudflare tunnel** (stable URL) would remove the redeploys entirely; it needs a Cloudflare
account and domain, which the owner would have to set up.

**Finding the brain process:** use `lsof -nP -iTCP:4000 -sTCP:LISTEN`. A plain `lsof -ti tcp:4000` also
matches client sockets (for example the Claude app's network helper) and killing those breaks other things.

### Local development

```bash
pnpm stdb                                   # local SpacetimeDB 127.0.0.1:3000
pnpm publish:local && pnpm bootstrap        # publish the module to local DB `napkin`, load Maya + baseline
pnpm --filter @napkin/brain start           # :4000 (needs a free port 4000; the hosted brain uses it too)
pnpm --filter @napkin/owner dev             # :3001
pnpm --filter @napkin/store dev             # :3002
```

- **The hosted brain already uses port 4000.** For end-to-end tests, `.claude/launch.json` has
  `brain-e2e` (:4100), `owner-e2e` (:3001) and `store-e2e` (:3002). They use the scratch database
  `napkin-e2e` on the local SpacetimeDB and `services/brain/.data-e2e`, with no Stripe key (DEV SIMULATOR
  payments). Publish the module to it first: `spacetime publish napkin-e2e --server local --yes`
  from `platform/`. Never point experiments at the shared local `napkin` database.
- **Only one `next dev` per app directory** can run at a time.

**Tools on the Mac:**
- Node 24 and pnpm 10;
- the `spacetime` 2.13 CLI;
- the Vercel CLI, logged in;
- the Stripe CLI and cloudflared, in `~/.local/bin`.

Homebrew is blocked until `sudo xcodebuild -license accept`.

## 8. History: how we got here

**Night 1 (Fri → Sat):** the owner slept while the previous session built with parallel agents.
- **M1:** the platform, ledger-core, store and owner app, end to end with hand-written Maya data. Verified
  at 2 AM.
- **M2:** the prover, intake, the question engine, the compiler, guards and the Build page.
- **M3:** AI staff, the phone line and the red team. It paused twice on usage limits.
- **Red team:** the real-model and compromised-model passes. They found and fixed the split-refund guard
  gap, and the final run is in `RESULTS.md`.

**Saturday daytime**, with the owner, in order:
1. The owner added keys and logged in to services. The Anthropic key needs `ANTHROPIC_WORKSPACE_ID`, which
   is set.
2. **Deployment:** maincloud, Vercel and the quick tunnel; real Stripe test checkouts verified (orders
   MC-R0353 and TB-YKMN0). Commit `6869986`.
3. **Twilio:** the trial had $0 balance, so it was skipped. **Cartesia:** the number was claimed through the
   API and the agent created. Pay-without-SMS was added: the `/pay` page plus the agent reading the order
   number aloud. Commit `abed2c8`.
4. The owner asked what a brand-new user experiences. Testing it found bugs: no stock questions, percent
   answers marked ambiguous, and new businesses without actor identities. All fixed in commit `6e8f1d7`.
   Timing was measured at about 27 s of machine time end to end; the interview is the human part, about 30
   questions for a rich napkin.
5. **The owner's request (verbatim, the most recent feature):** "I need a page for new customers. Cause my
   project is not just for one user: maya. Other people should go to the website, and see the info and
   everything, and button that says start ur business. And when they do, they need to create an accound
   and etc. Then, after onboarding and business creation, they have their own dashboard, which is not
   maya's cookies, it is a different entity… And maya's or other user's dashboard shouldnt't have create a
   new business. One busieness per account."
   - **Built:** accounts, landing page, onboarding, per-account dashboards, plus the interview dead-end
     fixes. Commit `d74e223`, deployed.
6. Handoff docs: commit `4cf45ad` and this rewrite.

**Saturday night**, the next session (commits `a8f61ca` to `bf9b453`):
1. **The owner's request:** the dashboard is fine, but the customer storefront looked bad. Stores should be
   generated in the style of https://www.warbyparker.com/ and https://www.asos.com/.
   - **Built:** a `StorefrontDesign` per business, separate from the Configuration. Claude Opus proposes
     style, palette, fonts, wording and image queries; code checks contrast and copy. Photos come from
     Openverse (CC licenses, credited in the footer): stock-photo providers first, then a general search,
     with a Sonnet vision pick that rejects snapshots and seasonal scenes. The store renders it like a
     modern retail site. A live business without a design gets one on its first visit; the owner can edit,
     upload images and regenerate on the owner app's Storefront page.
2. **AI staff:** store chat ("Ask the shop") with the checks shown under each reply. The Bookkeeper and
   `/ask` are owner-only; the customer roles are rate-limited per caller and globally.
3. **Go-live links** on the Build page (dashboard, storefront, QR); the store index lists only live shops.
4. **Interview:** a review list ("Confirm N facts") for everything read from paper, one-tap answers for
   yes/no-style questions, clearer stock-units wording, and money-ready now matches what compile needs.
5. **Intake fixes found by a full local end-to-end run:** percentages as bare fractions, inventory counts
   read as stock units, items left over after "Replace photo", currency and payment methods not read.
6. **Demo hardening:** `scripts/demo-up.sh` (section 7), the sample napkin (`fixtures/demo/`, also the
   "Use a sample" button on intake), the new `docs/DEMO.md` and `docs/REAL_VS_SIMULATED.md`.

## 9. What I was doing last

The previous session finished the storefront designs, the demo hardening and the docs.

**Verified locally**, on `napkin-e2e` with the `*-e2e` launch configurations:
- The sample napkin read as 30 facts; "Confirm 30" plus a few taps made it money-ready.
- Compile proved balance, discount and flow, and the business went live.
- The generated Juniper Candles store showed a green design with a candle hero photo.
- Order JC-Y67B7 ($15) was paid through the simulator; the dashboard showed balanced books, stock 20 → 19
  and a 66.7% gross margin.
- Asking the chat for 50% off was refused at the menu price and escalated to the owner.

**Verified live:** the hosted brain answers `/health` through the watchdog's tunnel, the owner app was
redeployed with the latest code, and Maya's store shows its generated design (all stock photos).

**Not yet verified by a human on the live site:** a real sign-up and new business, and Maya signing in.
The owner does live sign-ins; the agent must not create accounts on public sites.

## 10. What's left, in priority order

Done since the first handoff: the judge demo script (`docs/DEMO.md`), `docs/REAL_VS_SIMULATED.md`, the store
index showing only live shops, sign-in on the Bookkeeper and `/ask`, rate limits on customer chat, go-live
links on Build, the storefront redesign, "Ask your books" on the dashboard, the shared phone line for every
live shop, and reconnecting every live shop's actors at brain startup (before, shops created from a napkin
stopped taking orders after any brain restart).

Done on 2026-10-25: the official side. Reports has a sales tax report (tax collected, tax handed back with
refunds, tax due, by month or quarter) and CSV downloads for an accountant; owners log expenses with a
receipt photo (new `expense` document type, accounts 6000 Rent, 6100 Supplies, 6200 Wages, 6300 Utilities,
6900 Other; P&L shows them); and a getting-legal checklist. Existing shops (Maya included) need a recompile
on Build to get expenses; **ask the owner before recompiling hosted Maya**.

1. **Live end-to-end test by the owner.** Sign up on https://napkin-owner.vercel.app, use the sample napkin,
   go live, open the storefront, and pay with `4242…`. Sign in as Maya and check her dashboard. Fix
   whatever breaks.
2. **Devpost write-up.** Cover the problem, what it does, how it's built (Anthropic: Opus intake, design and
   compiler theme, Sonnet staff and photo picks, Haiku phone; Cartesia: voice agent and speech-to-text;
   Stripe test mode; SpacetimeDB; Vercel; Z3; Openverse), the challenges, what's next, and a 1–2 minute
   video if possible. **Ask the owner before making the repo public.**
3. **Gaps worth closing** (judgment calls):
   - `OWNER_PHONE` is empty, so phone owner mode is off. Ask the owner for their number (+1… form) and
     check that `OWNER_PIN` is set.
   - A replacement photo can create conflicts on non-item facts (for example the refund method) between
     the two readings; the owner resolves them in the interview, but it adds questions.
   - When no photo passes the vision pick for an item, the store shows a label tile instead.
   - The quick tunnel is fragile; the watchdog recovers in about 2 minutes, a named tunnel would avoid it.
   - **Refunds book their tax to Refunds 4200**, not back out of Sales tax payable 2100, so the trial balance
     overstates tax owed after a refund. The sales tax report already backs it out (from the refund's
     saleTotal/saleNet); the real fix is a third refund posting rule, and it must pass the Z3 balance proof.
   - Recompiling regenerates the storefront tagline (the owner didn't ask for that).
   - No document pays off an "owed" expense yet, so Payables 2000 only grows; receipts uploaded without
     saving an expense stay in `dataDir/receipts/`.
   - Real payouts to the owner's bank need Stripe Connect (owner's call; everything is test mode now).
4. **Polish, if there's time:**
   - An "Ask your books" box on the dashboard using the owner-only `/ask`.
   - Keep the approved storefront theme on recompile.
   - Ask for per-role refund limits in the interview.
   - The impact scores shown in the interview UI.
   - Clean up the test businesses on maincloud.

## 11. Open decisions (defaults are in place; see `docs/MORNING.md` for details)

- Sea salt: tracked stock or a supply expense?
- Manual payouts.
- 5-decimal tax rates are refused.
- Returned-goods document type.
- A paid order whose sale couldn't post goes to the inbox only.
- Per-role refund limits default to 0.
- Storefront theme resets on recompile.
- Older pending configurations stay pending.
- A spoofed caller ID can trigger a 15-minute lockout.
- Chat customers proving an order is theirs.
- Coupons: none exist.
- Shopkeeper discretion on discounts.
- An order id reveals the status and total only.
- Stuck refund drafts count against the order's limit.

## 12. Gotchas

**Models and AI providers:**
- **Model ids:** `claude-opus-5-5` (intake, compiler theme), `claude-sonnet-5-5` (AI staff),
  `claude-haiku-5-5` (classification and phrasing). The phone agent uses Cartesia's catalog id
  `claude-haiku-5.5`.
- **Opus 5.5 rejects forced tool calls.** Use auto tool choice plus an instruction plus zod. A schema this
  large is too big for structured outputs.
- **Money-question wording stays fixed.** Haiku once turned "cost for the sea-salt add-on" into "cost of a
  batch".
- **Cartesia:** omit `temperature` for `claude-haiku-5.5`; it's fixed at 1.

**Stripe:**
- `stripe listen` requires `--events`.
- Maya's product ids are `cookie_single`, `box-of-6` and `sea-salt`.

**SpacetimeDB:**
- Exactly one copy of the `spacetimedb` package (2.13.0) may be installed (SpacetimeDB issue #5740).
- In the module, use `ctx.random`, never `Math.random`.
- `u64`/`i64` values are `bigint`.
- To roll back a reducer's transaction, `throw new SenderError(...)`.

**Repo and tooling:**
- `pnpm publish:local` must use the script (pnpm's built-in `publish` shadows it).
- Only one `next dev` per app directory. Port 4000 is the hosted brain.
- Sizable runs: **at most 3 subagents at once.**

**Data and the owner app:**
- **Percent conventions:** see "Field kinds" in section 5. A margin refusal on a business with unrealistic
  costs is correct behavior, not a bug.
- **Removed preview mode:** a stale sessionStorage preview flag once showed Maya's data in a new account. The
  owner app now clears it.
