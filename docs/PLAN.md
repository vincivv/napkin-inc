# Napkin Inc. — PLAN

Status: **draft, awaiting owner approval.** No product code is written until this is approved.
Docs checked on Fri 2026-10-23 at 8 PM: SpacetimeDB v2.13.0, Cartesia API `2026-08-14`, z3-solver 5.3.1, stripe 23.0.1 (API version `2026-09-30.endive`).

---

## 0. Findings that shape the plan

| Topic | Finding | Consequence |
|---|---|---|
| SpacetimeDB TS modules | First-class since 2.0 (V8, bundled with Rolldown), not labelled beta. Each reducer is one ACID transaction: a `throw` rolls back everything. No `Math.random`; u64 values are `bigint`. Exactly one copy of the `spacetimedb` package may be in the bundle (issue #5740). There is no JSON column type. | **Use a TypeScript module.** Store runtime-defined shapes as JSON strings, and promote the fields we filter on (`configId`, `docType`, `status`, `period`) to indexed columns. |
| SpacetimeDB HTTP | `POST /v1/database/{db}/call/{reducer}` with `Bearer <JWT>`. `POST /v1/identity` mints identities. Procedures can `ctx.http.fetch`. Module HTTP handlers are beta. | The brain talks to the platform with **one SpacetimeDB identity per actor** (system, shopkeeper, support, bookkeeper). The owner app gets the owner identity. Segregation of duties is enforced on `ctx.sender` inside the platform. We avoid beta HTTP handlers. |
| Maincloud | Free tier: about 3M calls a month and 5 DBs. Known issue: subscription delivery stalls under large fan-out. | Develop locally (`spacetime start`) and publish to maincloud for the demo. Our fan-out is small. |
| z3-solver | Works on Node 24, about 80 ms per proof. `Real.val('0.2')` is exact. `check()` calls run one at a time. Call `killThreads` at exit. | The prover runs in-process in Node. Money is in **integer cents**, so the proofs use Z3 `Int` and match runtime arithmetic exactly. |
| Stripe | Checkout Session `price_data` and `idempotencyKey` work. The processor fee comes from `latest_charge.balance_transaction` and may be null at `checkout.session.completed`, in which case we read it on `charge.updated`. | Fee posting is its own step, keyed on the balance transaction. SMS links use our short URL `/p/:orderId`, which creates or reuses a session and redirects. |
| Cartesia phone line | Hosted Line agents are being shut down (Dec 1). **Managed Agents**: no code. They get a phone number (free Cartesia number, or an imported Twilio number). **Webhook tools call our HTTPS endpoints.** `system__caller_id` and `system__conversation_id` can be passed into tool parameters. **No SMS.** The LLM is picked from Cartesia's catalog, which includes Claude but bills through Cartesia rather than our Anthropic key. | Every phone tool is a brain endpoint that checks caller ID and verified status **server-side**. SMS goes through Twilio. See decision D1. |
| Cartesia STT | `ink-2` is realtime-only. Batch `POST /stt` takes `ink-whisper` and accepts webm. | Intake voice: the browser's MediaRecorder sends webm to the brain, which calls batch `ink-whisper`. Streaming is optional polish. |

---

## 1. File tree

```
napkin-inc/
  package.json, pnpm-workspace.yaml, .env.example, README.md
  docs/PLAN.md, docs/DEMO.md (click-through per milestone), docs/REAL_VS_SIMULATED.md
  packages/
    schema/          Fact, BusinessSpec, Configuration, DecisionRecord types + JSON Schemas (ajv) + validators + tests
    ledger-core/     PURE TS, zero deps (bundled into the SpacetimeDB module AND used by brain/prover):
                       money.ts      (integer cents, basis points, exact rounding)
                       dsl.ts        (posting-rule expression AST + parser + evaluator)
                       posting.ts    (document + Configuration -> journal lines + register movements)
                       invariants.ts (balance, stock>=0, margin floor, SoD; pure predicates)
                       pricing.ts    (discount/coupon/refund application = the exact runtime formula the prover models)
  platform/          SpacetimeDB TypeScript module ("the 1C")
    src/index.ts     tables + reducers; imports ledger-core
    src/reports.ts   trial balance, P&L, stock, receivables/payables, margin by item (as views or reducers writing report rows)
    README.md
  services/
    brain/           Node 24 + Hono HTTP server, port 4000
      src/stdb.ts        SpacetimeDB client per actor identity
      src/payments/      stripe checkout, webhooks, fee + payout reconciliation, outbox worker
      src/intake/        photo (Claude vision) + voice (Cartesia STT) -> draft BusinessSpec
      src/questions/     question engine (impact * (1 - confidence)), owner-statement diffs
      src/compiler/      template + LLM structure proposal -> calls prover -> Configuration v(n)
      src/agents/        agent factory, Shopkeeper/Support/Bookkeeper loops (Anthropic tool use), precedents
      src/guards/        policy engine (inv. 4-6) every agent tool call passes through
      src/phone/         Cartesia webhook-tool endpoints (customer + owner mode), Twilio SMS
      src/ask/           "ask the business": answers only from ledger + DecisionRecords, with links
    prover/          z3-solver: posting synthesis, balance prover, discount-stacking proof, flow check
  apps/
    owner/           Next.js (port 3001): intake, interview, build progress, dashboard, documents, registers,
                     reports, agent activity, inbox, ask, proof report. Live via spacetimedb/react.
    store/           Next.js (port 3002): /[slug] catalog with live stock, cart, checkout, /[slug]/order/[id], QR codes
  redteam/           attacks/*.json (~50), chaos tests, planted-error books + answer key, runner, RESULTS.md generator
  fixtures/
    maya/configuration.json (hand-written, M1), maya/spec.json, napkin photos, voice transcripts
```

## 2. Core design decisions

1. **One evaluator, proven and executed.** Posting rules are expressions in a small DSL whose AST lives in `ledger-core`. The prover translates the *same AST* to Z3 terms. The platform runs it with the *same evaluator*, so the rule we prove is the rule that posts.
2. **Money is integer cents (`bigint` in the module); rates are basis points.** The margin-floor check is exact integer arithmetic: `net_cents * 10000 >= cost_cents * (10000 + floor_bps)`. There are no floats anywhere in money paths.
3. **The platform is the last line of defense.** The brain's guards give good UX, refusals the agents can explain, and DecisionRecords. The platform reducers *re-check* invariants 1, 3, 4, 5, 6 and 8 and throw, which rolls back the transaction. A compromised brain or a swapped LLM still cannot violate them.
4. **Authority = SpacetimeDB identity → role**, stored in an `actor` table. `set_policy` and `set_price` require the owner role. Agents' identities simply don't have the permission, so injected text has no path to change a rule.
5. **Exactly-once payments in one transaction.** The `record_processor_event(eventId, …)` reducer inserts into `processor_event` (eventId unique) **and** posts the payment document in the same transaction. A duplicate webhook hits the unique constraint and becomes a no-op. Side effects such as Stripe refunds and SMS go through an `outbox` table, which the brain drains with idempotency keys.
6. **Baseline for the red team** = the same module published as a second database with `ENFORCE=false` (a typed module env var), plus the brain with guards and the prover off. Same model, same tools, same prompts.
7. **Never assume.** Facts carry provenance. The compiler refuses to synthesize money logic while any money-relevant fact is `inferred`/unconfirmed. Agents escalate to the inbox. Owner answers become `precedent` rows, which are injected into agent context and checked by the guards.

## 3. Interfaces between components

### 3.1 Platform tables (SpacetimeDB)
| Table | Key columns (indexed) | Payload |
|---|---|---|
| `business` | id, slug (unique) | name, activeConfigVersion |
| `config_version` | id, businessId, version | json (Configuration), proofReportJson, status |
| `actor` | identity (pk) | businessId, role (owner/shopkeeper/support/bookkeeper/system), name |
| `catalog_item` | id, businessId, catalog | json fields, active |
| `document` | id, businessId, docType, number, status (draft/posted/reversed), period, createdBy, approvedBy | fieldsJson, linesJson, reversalOf |
| `journal_line` | id, documentId, accountCode, period | debitCents, creditCents |
| `register_movement` | id, documentId, registerId, period | dimsJson, kind (in/out/turnover), qty, amountCents |
| `register_balance` | registerId + dimsKey | qty, amountCents (kept in the same transaction as movements) |
| `period` | id (YYYY-MM) | status open/closed |
| `policy` | businessId, key | valueJson, version, setBy |
| `payment_intent_log` | orderId (unique), idempotencyKey (unique) | stripeSessionId, status |
| `processor_event` | eventId (unique) | type, receivedAt, documentId |
| `outbox` | id, status | kind, payloadJson, idempotencyKey, attempts |
| `decision_record` | id, documentRef, actor | DecisionRecord json |
| `inbox_item` | id, status | question, fromAgent, context, answer |
| `precedent` | id, agentRole | rule text, structured condition, sourceInboxId |
| `owner_statement` | id, status (queued/confirmed/rejected) | channel (app/phone), text, diffJson |
| `audit_log` | id | actor, reducer, argsHash, timestamp |

### 3.2 Platform reducers (all check `ctx.sender` role)
`load_configuration(businessId, json, proofReportJson)` (owner/system; rejects a config without a passing proof report) · `create_document(docType, fieldsJson, linesJson)` · `post_document(id)` (SoD: approver ≠ creator, unless the config says that doc type auto-posts by system; checks inv. 1/3/4/8) · `reverse_document(id, reason)` · `close_period(id)` · `record_processor_event(eventId, type, payloadJson)` · `claim_outbox(id)` / `complete_outbox(id, resultJson)` · `record_decision(json)` · `open_inbox(json)` / `answer_inbox(id, answer, makePrecedent)` · `queue_owner_statement(text, diffJson, channel)` / `confirm_owner_statement(id)` (owner identity only) · `set_policy` / `set_price` (owner only) · `grant_role(identity, role)` (system/owner).

### 3.3 Brain HTTP API (port 4000)
- `POST /intake/photo`, `POST /intake/voice` → draft spec + highlights
- `GET /questions/next`, `POST /questions/:id/answer`, `POST /owner/statement` (returns a diff)
- `POST /compile` (Server-Sent Events progress: synthesis → proofs → config vN → storefront → agents)
- `POST /checkout` {slug, cart} → Stripe URL · `GET /p/:orderId` → 303 redirect to Stripe · `POST /webhooks/stripe` (raw body)
- `POST /agents/:role/message` (chat with Shopkeeper/Support) · `POST /ask` {question} → answer + entry refs
- `POST /phone/tools/{menu_lookup|order_status|place_order|escalate|verify_owner|owner_report|owner_instruction}` (Cartesia webhook tools, bearer secret, caller_id/conversation_id passed in)
- `POST /auth/owner` {pin} → grants the owner role to the owner app's SpacetimeDB identity

### 3.4 Guard contract
`guard.check(call: {actor, tool, args, sourceText?}) -> {allow, ruleIds, reason, maxAllowed?}`. Every agent tool call goes `LLM → guard → platform reducer → DecisionRecord` (written whether allowed or refused).

## 4. Chart of accounts and postings for item_seller (Maya's Cookies)
Accounts: 1000 Cash (bank) · 1010 Stripe clearing · 1200 Receivables · 1300 Inventory · 2000 Payables · 2100 Sales tax payable · 4000 Sales revenue · 4100 Discounts given (contra-revenue) · 4200 Refunds (contra-revenue) · 5000 Cost of goods sold · 5100 Processor fees.

- **Sale** (posted when paid): Dr 1200 gross−discount+tax / Dr 4100 discount / Cr 4000 gross / Cr 2100 tax; Dr 5000 cost / Cr 1300 cost; Stock register *out* qty.
- **Payment received** (Stripe event): Dr 1010 net / Dr 5100 fee / Cr 1200 amount.
- **Refund**: Dr 4200 / Cr 1010, capped by policy (see D4).
- **Payout** (simulated in test mode): Dr 1000 / Cr 1010.
- **Stock receipt**: Dr 1300 / Cr 2000 or 1000; Stock register *in*.
- **Invariant 2 check:** ledger(1010) + ledger(1000) payouts reconciles to the Stripe test-mode balance transactions on every processor event, and any mismatch opens an inbox item.

## 5. Build order with parallel agents

Agents run in **separate git worktrees on their own branches**. I merge each one and run all tests after every merge. Before fanning out I add every package and dependency, so the shared lockfile never conflicts.

| Step | Who | Work | Done means |
|---|---|---|---|
| **M1-0** (~1h) | me | `packages/schema` + `packages/ledger-core` (money, DSL, posting, invariants, pricing) with unit + property tests (fast-check). Hand-written `fixtures/maya/configuration.json`. Install the SpacetimeDB CLI. | Shared contracts frozen; tests pass |
| **M1-a** ‖ | agent A | `platform` module: tables, reducers, posting via ledger-core, roles/SoD, period lock, processor-event dedupe, outbox, reports; module unit tests | Publish locally; scripted sale → balanced trial balance |
| **M1-b** ‖ | agent B | `brain` payments: Stripe checkout, `/p/:orderId`, webhooks → `record_processor_event`, fee lookup, outbox worker, actor identities | `stripe trigger` + a real test checkout post correctly; duplicate webhook is a no-op |
| **M1-c** ‖ | agent C | `apps/store`: branded catalog from config, live stock, cart, checkout redirect, order status, QR (business + per item) | Scan QR on phone → pay with 4242 → order page shows paid |
| **M1-d** ‖ | agent D | `apps/owner` M1 views: live dashboard (orders, stock, cash, trial balance), documents, registers, decision records | Sale appears live within ~1s |
| **M1 gate** | me | merge, end-to-end test, DEMO.md, real-vs-simulated | M1 click-through works |
| **M2** ‖ | agents | (E) intake photo+voice, (F) question engine + owner statements, (G) guards + decision records + inbox + precedents, (H) compiler for item_seller using the prover's API stub, plus owner-app intake/interview/build/inbox screens | Napkin photo → questions → confirmed spec → config compiled and loaded |
| **M3** ‖ | agents | (I) prover: synthesis, balance proof, discount proof, flow check, (J) three agents, (K) phone line, (L) red team + RESULTS.md | Proofs gate compilation; phone works in both modes; RESULTS.md table |
| **Tier 3** | — | only after you confirm Tier 2 works | — |

The Tier 1 path is never broken. Every merge re-runs an M1 smoke test: scripted checkout with the Stripe test key → posted → trial balance balances.

## 6. Decisions I need from you

- **D1 — Phone line LLM.** (a) **Recommended:** Cartesia Managed Agent with Claude from Cartesia's catalog, with all logic in our brain's webhook tools. The money guarantees still hold, because the agent can only call guarded tools, and it stays reliable. The cost is that the phone LLM is billed by Cartesia, not our Anthropic key. (b) Twilio Media Streams bridge to Cartesia STT/TTS with our own Claude loop. This keeps the Anthropic key everywhere but adds many more moving parts and latency risk.
- **D2 — Phone number + SMS.** Recommended: a free Cartesia number for voice, plus a **Twilio trial** for SMS payment links. A trial can only text numbers you verify first, so we verify your phone and any demo phones.
- **D3 — Hosting for the demo** (judges scan the QR with their own phones). Recommended: SpacetimeDB **maincloud**; `store` + `owner` on **Vercel**; brain on your laptop behind a **Cloudflare quick tunnel**, which is needed anyway for Cartesia webhook tools. Everything runs locally until M3.
- **D4 — Partial refunds vs the margin floor.** Proposed rule: a refund is either **full** (it reverses the sale, so no sale exists below the floor) or **partial and capped** so the retained amount stays ≥ cost × 1.30. The prover proves exactly this.
- **D5 — Coupon stacking.** Proposed: at most one coupon plus discounts, with the *total* discount capped at 20%. The prover checks that no combination exceeds the cap or breaks the floor.
- **D6 — Parallelism vs "strictly in order".** May agents build deterministic M2/M3 pieces (for example the prover) in parallel while M1 finishes, on their own branches, never touching the M1 path? Recommended: yes for the prover and the red-team attack set, and no for anything UI.
- **D7 — Repo visibility.** It is private now (github.com/vincivv/napkin-inc). We make it public before Devpost submission.

## 7. What I need from you (things I can't or shouldn't do myself)

1. **Keys in `/Users/vinci/napkin-inc/.env`** (copy `.env.example`; I never print or commit them): `ANTHROPIC_API_KEY`, `CARTESIA_API_KEY`, `STRIPE_SECRET_KEY` (**sk_test_** only; the brain refuses to start with a live key).
2. Run `stripe login` once in a terminal (browser approval). After that I run `stripe listen` to get `STRIPE_WEBHOOK_SECRET`.
3. `spacetime login` for maincloud (GitHub OAuth in the browser), when we get to deployment.
4. Twilio trial account (SID, auth token, number) and your phone number verified in it. Set `OWNER_PHONE` and `OWNER_PIN`.
5. **Maya's facts the prompt doesn't give.** I will not invent these, even for the fixture:
   - ingredient cost of one cookie, the box of 6, and the sea-salt add-on (the margin floor depends on them);
   - initial stock;
   - pickup location; hours; timezone (America/Los_Angeles?); sales tax rate (0% is common for this kind of seller, but it's your call);
   - does the box of 6 consume 6 cookies of stock or have its own stock?
6. A real napkin: draw Maya's menu on paper and drop the photo in `fixtures/maya/` (I'll also make a synthetic one for tests).
7. Optional: `sudo xcodebuild -license accept` so Homebrew works again (it's blocked now). I installed pnpm and the Stripe CLI to `~/.local/bin` as a workaround.

## 8. Risks and what I'd cut first
- If M1 runs past ~2 AM: cut owner-app polish (registers and reports tables only), and cut QR per item (keep the business QR).
- If the SpacetimeDB TS module hits a blocker (bundling, bigint, the #5740 double-package bug): tell you immediately; the fallback is a Rust module.
- If posting synthesis runs late: hand-written posting rules for item_seller, still **proven** by Z3 (per the build plan).
- Cartesia free credit is about 17 agent minutes, so test the phone line sparingly and ask at the booth for credits.
