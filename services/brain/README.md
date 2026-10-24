# @napkin/brain

Node 24 + Hono service on port 4000. It is the only component that talks to Stripe and the only one that holds the
`system` SpacetimeDB identity. M1 scope: bootstrap, payments (exactly-once), owner login, health.

## AI vs deterministic
Everything in M1 is deterministic. No LLM is involved in money movement. The platform (SpacetimeDB) prices orders
from the active catalog and enforces the rules; the brain relays the platform's sale document to Stripe and relays
Stripe's events back using Stripe's own ids, so replays are no-ops.

## Run
```
pnpm --filter @napkin/brain bootstrap   # idempotent: system actor, maya-cookies (+ -baseline), config, actor identities
pnpm --filter @napkin/brain start       # or `dev`; also bootstraps at startup (retries every 15s until the platform is up)
pnpm --filter @napkin/brain test        # vitest, no platform needed (fake PlatformPort)
pnpm --filter @napkin/brain typecheck
```
Identity tokens live in `services/brain/.data/identities.json` (gitignored), checkout sessions in `.data/sessions.json`.

## Endpoints
- `GET /health` stdb connected, stripe mode (`test` | `simulator`), bootstrapped, outbox counts.
- `POST /checkout {businessId, lines:[{productId,qty}], customerName, couponCode?}` -> `{orderId, url, simulated}`.
  Flow: storefront identity `createOrder` -> system `logPaymentIntent` -> Stripe Checkout Session (line items from the
  platform's sale document, never the request; idempotency key from the intent; metadata.orderId on session and payment
  intent) -> `attachCheckoutSession`. Platform refusals come back as 422 with the platform's message.
- `GET /p/:orderId` 303 to the existing unexpired session, or a new one.
- `POST /webhooks/stripe` raw body verified with `STRIPE_WEBHOOK_SECRET`. `checkout.session.completed` (paid) ->
  `payment_succeeded` (event id = Stripe event id) then `fee` (id `fee:<balance_txn>`, amount = balance transaction fee;
  if not settled yet, posted on `charge.updated`). `charge.refunded` / `refund.*` -> `refund_succeeded` (id `refund:<re_id>`).
- Outbox worker: claims pending `stripe_refund` rows, calls `refunds.create` with the row's idempotency key, completes it;
  items stuck in `claimed` longer than `OUTBOX_STALE_SECONDS` are retried with the same key.
- `POST /auth/owner {pin}` constant-time PIN check, rate limited (5/client, 30 global per 5 min); the system mints a
  one-time owner role grant (120 s) and returns `{code}`. Disabled (503) if `OWNER_PIN` is unset.
- DEV SIMULATOR only (no Stripe key): `POST /dev/simulate-payment/:orderId` runs `sim_evt_<orderId>` through the same
  handlers as the webhook; fee = round(2.9% + 30c). `/checkout` returns `STORE_PUBLIC_URL/<slug>/order/<id>?simulate=1`.
  The server logs a loud banner. Disabled once a test key is configured.

## Env (repo-root `.env`)
`STRIPE_SECRET_KEY` (sk_test_/rk_test_ only; `sk_live`/`rk_live` and anything else refuse to start; absent = simulator),
`STRIPE_WEBHOOK_SECRET` (whsec_...), `OWNER_PIN`, `STORE_PUBLIC_URL` (default http://localhost:3002),
`OWNER_APP_URL` (3001), `BRAIN_URL`, `PORT` (4000), `SPACETIMEDB_URI` (http://localhost:3000), `SPACETIMEDB_DB` (napkin),
`CORS_ORIGINS` (extra, comma separated), `BRAIN_DATA_DIR`, `OUTBOX_STALE_SECONDS` (60).
CORS allows localhost 3001/3002, `OWNER_APP_URL`, `STORE_PUBLIC_URL`, and `CORS_ORIGINS`.

## M2: intake + question engine (never assume)
Every field of the draft `BusinessSpec` is a `Fact` {value, provenance owner_said|paper|inferred, confidence, source{kind, ref, region, quote}, confirmed}.
A fact may drive money only when `usableForMoney` (confirmed and not inferred). Code: `src/intake`, `src/questions`, `src/spec`, `src/m2.ts` (mounted by one line in `server.ts`).

**AI vs deterministic.** AI: read the photo (`claude-opus-5-5` vision, forced tool call), extract facts from a transcript, parse an owner statement into
proposed field changes, and re-word (never choose) a question (`claude-haiku-5-5`, rejected if any number changed). Deterministic code: provenance
assignment (paper/owner_said only with a quote, otherwise inferred and capped at 0.4), value coercion, merge, impact scoring, which question is next,
moneyReady, applying/reverting diffs. Fields nobody mentioned are typed placeholders (provenance inferred, confidence 0, ref "missing") and become questions.

Endpoints (businessId = lowercase slug):
- `POST /intake/photo` multipart `businessId`, `image` -> draft spec (+ `facts`, `counts`, `moneyReady`, `blockers`). Retries once on invalid model output.
- `POST /intake/voice` multipart `businessId` + `audio` (webm; Cartesia `ink-whisper` batch STT) or `transcript` (typed fallback, source kind "chat").
- `POST /intake/merge {businessId}` re-merges stored photo+voice drafts into the spec (idempotent). Photo/voice also merge into the current spec on arrival.
  Merge rules (`src/intake/merge.ts`): same value -> keep, max confidence; one side confirmed or the other a mere guess -> the stronger wins, loser kept in `alternatives`;
  otherwise conflict -> both candidates kept in an OpenQuestion `conflict.<path>`; order-independent (property tested).
- `GET /intake/photo/:businessId` the stored photo. Drafts: `.data/specs/<businessId>.json` (gitignored, `version` bumps on every write).
- `GET /spec/:businessId` -> spec + `moneyReady` (every money-relevant fact usableForMoney) + `blockers`. **The compiler must refuse when `moneyReady` is false.**
- `GET /questions/next?businessId=` top unresolved question by `impactScore = moneyImpact(path) * (1 - confidence)` (table in `src/questions/impact.ts`).
- `POST /questions/:id/answer {businessId, answer? | confirm?}` fact becomes owner_said + confirmed; records a DecisionRecord (system identity) when the business exists on the platform.
- `POST /questions/:id/dismiss` only for non-money questions.
- `POST /owner/statement {businessId, text, channel: app|phone}` -> structured diff (nothing applied). `phone` also calls `queueOwnerStatement`; the owner confirms in the app Inbox
  (platform `decideOwnerStatement`), and `GET /owner/statements` / `GET /spec` then apply it and call `markOwnerStatementApplied`. `POST /owner/statement/:id/decide {businessId, confirm}` is for app statements only (phone -> 409).
- Env: `ANTHROPIC_API_KEY` (+ `ANTHROPIC_WORKSPACE_ID` if the key is not workspace scoped), `CARTESIA_API_KEY`. Missing keys -> 503, nothing is faked.
- Dev without keys: `PORT=4010 DEV_ORIGINS=http://localhost:3015 pnpm --filter @napkin/brain exec tsx scripts/dev-fixture-server.ts` (FAKE LLM, serves only M2 routes).
- Real smoke: `pnpm --filter @napkin/brain exec tsx --env-file=/path/.env scripts/real-intake.ts ../../fixtures/maya/napkin.SYNTHETIC.png [voice.wav]`.

## M2: compiler (`src/compiler`, `POST /compile`)
`compile(spec, {businessId, version, prover, proposer?, roleLimits?, onStep?}) -> {config, proofReport, dryRun, log}`.
Steps: facts -> template -> synthesis -> proofs -> configuration -> storefront -> agents (then `submit` in the route).

- **facts**: every money-relevant fact (prices, costs, stock units/initial stock when tracked, all policies) must be
  `usableForMoney` and well-formed (whole cents, percent <= 100, rates in whole basis points: the platform's and the
  prover's rate domain). Otherwise `UnconfirmedMoneyFacts` lists every field with an OpenQuestion. Nothing is defaulted or rounded.
- **template**: `templates/item_seller.ts` (documents, chart of accounts, registers, role permissions, reports, agents)
  factored out of the fixture. Filled deterministically: catalogs, policies as exact decimal strings, initialStock.
  Platform rules, not owner facts: backorders off, at most 1 coupon per order (D5). Refund limits for support and
  bookkeeper are not in the spec: they carry over from the active (owner-approved) configuration, else 0 (every
  agent refund goes to the owner).
- **synthesis/proofs**: through a `ProverPort` (`prover-port.ts`). `/compile` uses `Z3Prover` (`z3-prover.ts`,
  services/prover): balance, discount-stacking/margin-floor (+D4) and flow proofs are real; a failed proof refuses the
  compile. `COMPILE_PROVER=stub` falls back to `StubProver` (every proof `skipped`, solver "STUB (no prover wired)",
  shown as "skipped (stub)" in the owner app). Synthesis is reported `skipped`: the spec's document-level examples are
  not yet mapped to the prover's expression synthesis, so examples are checked deterministically against the
  template rules instead (a mismatch becomes an owner question). An `ambiguous` synthesis becomes an owner question. Independently of the prover: `parseConfiguration`, `checkConfigurationSemantics`
  and a ledger-core dry run (per product: sale at 0 and at the max discount, full refund, payment; plus fee, payout,
  stock receipt, opening balance) must pass.
- **storefront/agents** (the only LLM step, optional): `LlmCopyProposer` (via `src/llm.ts`, Claude Opus 5.5) proposes
  theme colors, emoji, font, headline, tagline and agent goal wording, from names only (no prices). Every field is
  validated (hex, WCAG contrast, font allowlist, no digits/currency/money words/links) and dropped on failure; safety
  goals are always kept. The money sections are fingerprinted before and after and the compile refuses on any change.
- `POST /compile {businessId}` streams SSE `step` events, then `result {configId, version, status, activated}` or
  `error {code, message, questions}`. It submits v(n+1) as **pending**; the owner activates it in the owner app.
  Only a brand-new business with no owner and no active config is activated by the brain (bootstrap).
  `GET /compile/:businessId/latest` replays the last run. One run per business at a time (409).

## M2: guards (`src/guards`)
Every agent tool call: `guard.check({actor:{role,identity}, businessId, tool, args, provenance:{source, text?}})
-> {allow, outcome, ruleIds, reason, maxAllowed?, wouldChangeIf, checkedArgs, ...}`. `wrapTool(fn, guard)` runs the
tool only on allow, with the guard's parsed args. `createStdbGuard(hub)` is the live wiring.

Rules (`rules.ts`, pure): unknown tool refused; invariant 6 (only role owner + source owner_app may change price,
policy or configuration; owner_phone_verified is queued as an owner statement; anything else is refused); role
permissions and agent tool lists; catalog prices only (caller prices ignored); D5 coupon stacking; rate domain
(whole basis points); discount cap and margin floor checked with ledger-core `post()` on catalog prices, with the
exact max discount (`maxAllowed.discountRate`, a fraction) and its basis-point floor; refund window (escalates), D4
full-or-floor refunds, role refund limits (escalate); segregation of duties on approvals; precedents only tighten.
Prompt injection in `provenance.text` or order notes never changes a decision (property tested). Each check writes
exactly one DecisionRecord (`recordDecision`, as the agent's identity when the brain holds it); escalations open an
inbox item. If the record cannot be written the call is not allowed (`GuardUnavailable`).

Real vs simulated: compiler, dry run, Z3 proofs, guards and the SSE route are real and run against the real
platform. Posting-rule synthesis from examples is not wired (reported `skipped`). The LLM copy step runs only with `ANTHROPIC_API_KEY`; without it defaults are
used. Tests: `test/compiler.test.ts`, `test/compile-route.test.ts`, `test/guards.test.ts`, `test/z3-prover.test.ts` (TEST data in
`test/fixtures/maya-spec.TEST.ts`: the fixture's placeholder costs, marked confirmed for tests only).

## M3-K: phone line (`src/phone`, `POST /phone/tools/:name`)
A **Cartesia Managed Agent** owns the voice and the LLM (a Claude model from Cartesia's catalog, billed by Cartesia).
All logic is in brain **webhook tools**; the agent only talks and picks tools. Cartesia fills `caller_id` from
`{{system__caller_id}}` and `conversation_id` from `{{system__conversation_id}}` (hidden from the model), and
`business_id` is a constant, so the model cannot choose any of them. Cartesia has no SMS: pay links go by Twilio.

| Tool | Mode | What it does |
|---|---|---|
| `menu_lookup` | customer | live catalog prices + availability (`floor(stock / stockUnits)`); never costs |
| `order_status` | customer / owner | details only if the caller ID placed that phone order (or the owner is verified); otherwise one generic reply, identical for unknown orders |
| `place_order` | customer | validates lines against the live catalog, then `createCheckout(..., {channel: "phone"})` (the storefront's path). Total = platform pricing. Pay link `BRAIN_URL/p/<orderId>` texted to the **caller ID** via the platform outbox (`enqueueOutbox`, kind `sms`, key `paylink:<orderId>`). A retry (same conversation + caller + cart) returns the same order and never queues a second text. The reply says `queued` (never "texted") until the platform row is done with a real send |
| `escalate` | customer | `openInbox` with the conversation id, masked caller (`…0111`) and the summary marked `untrusted` (max 3 per call) |
| `verify_owner` | customer | caller ID == `OWNER_PHONE` (E.164) **and** PIN == `OWNER_PIN`, both compared in constant time; 3 failures per conversation and per caller in 15 min lock it (even with the right PIN); either env var empty = everyone refused |
| `owner_report` | owner | today (in the active config's `business.timezone`): orders, paid orders, sales, refunds, stock, open inbox, statements awaiting confirmation |
| `owner_instruction` | owner | `submitOwnerStatement(..., "phone")`: LLM diff + `queueOwnerStatement`. **Never applied**; the owner confirms in the app Inbox (invariant 6). Needs `ANTHROPIC_API_KEY` and an intake spec, otherwise it refuses and nothing changes |

**Security.** Every call needs `Authorization: Bearer $PHONE_TOOL_SECRET` (at least 24 chars; unset or short = every call 401).
Inputs are zod-validated (unknown fields ignored). Owner mode exists only as server-side state: `OwnerSessions` is
**in memory**, keyed by conversation id, bound to caller ID and business, TTL 30 min, set only by a successful
`verify_owner`. A brain restart forgets it (the owner verifies again). No parameter or text can grant it. The platform's
`customer_order` has no phone column, so `.data/phone-orders.json` maps orderId -> caller ID (plus the place_order
idempotency index). Money and policy rules are enforced by the platform reducers the tools call.

**SMS.** `TwilioSms` posts to `https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json` (form `To/From/Body`,
basic auth; the `twilio` SDK is not used). Without all three `TWILIO_*` vars the **SMS SIMULATOR** logs
`[SMS SIMULATOR] NOT SENT ...`, keeps messages in memory, and the agent is told *no text was sent*.

Texts use the **platform outbox** (invariant 7); there is no brain-local outbox file any more. `place_order` calls the
`enqueueOutbox` reducer as the system actor (idempotent on `paylink:<orderId>`), and the brain's `OutboxWorker` drains
rows of kind `sms` with `SmsExecutor`: `claimOutbox`, send, `completeOutbox`. 4xx from Twilio is permanent (row
`failed`); 5xx/429/network leave the row claimed and it is retried after `OUTBOX_STALE_SECONDS` (up to 5 transient
failures per brain process, then `failed`).

**Remaining at-most-twice window.** Exactly-once holds for creating and completing the row, not at Twilio, whose
message creation has no idempotency key. If the brain crashes (or `completeOutbox` fails) after Twilio accepted the
message and before the row is completed, the row stays `claimed` and the stale retry sends the text again: the customer
can get the pay link twice for that order, never more per crash. It is not hidden: every send logs
`[sms] paylink:<id>: sent (SM...) ...; completeOutbox pending`, and a stale re-run logs a `DUPLICATE` warning (plus the
worker's "retrying stale claimed item"). Both texts carry the same pay link for the same order, so a duplicate cannot
double charge. Do not read this as exactly-once at Twilio.

**Setup (real phone).**
1. `.env`: `PHONE_TOOL_SECRET` (`openssl rand -hex 32`), `OWNER_PHONE=+1...`, `OWNER_PIN`, `TWILIO_ACCOUNT_SID`,
   `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `CARTESIA_API_KEY`. Twilio trial: verify every phone that should get texts.
2. Tunnel: `cloudflared tunnel --url http://localhost:4000`, set `BRAIN_URL` to the https URL, restart the brain.
3. Model and voice: `pnpm --filter @napkin/brain exec tsx --env-file-if-exists=../../.env scripts/cartesia-setup.ts --list-models`
   (pick a Claude id), and a voice id from the Cartesia Playground.
4. `... scripts/cartesia-setup.ts https://<tunnel> --model <id> --voice <id> --dry-run` prints every request (secret
   redacted, no network). Without `--dry-run` it creates or updates the 7 tools and the agent.
5. Number: Cartesia Playground -> Phone Numbers -> Cartesia Number (free plan = 1 slot), assign it to the agent there or
   pass `--phone-number-id <id>`. A new tunnel URL means re-running step 4.

**Demo without a phone.** `... scripts/phone-sim.ts customer | owner | attack | call <tool> '<json>' [--brain URL]` sends
exactly the bodies Cartesia would (needs `PHONE_TOOL_SECRET`; `owner` uses `OWNER_PHONE`/`OWNER_PIN`).

**Real vs simulated.** Real: all 7 tools against the real platform; the Twilio REST adapter (unit-tested with a fake
fetch, never called for real yet); the Cartesia setup script (only `--dry-run` has been run). Simulated when keys are
missing: SMS (simulator) and payments (DEV SIMULATOR pay links). Tests: `test/phone.test.ts` (auth, privacy, lockout,
injection, idempotent SMS, Twilio errors, and a fast-check property that no customer-mode call sequence reaches owner
tools or changes policy).

## M3: Agents (`src/agents`) — the AI staff
Three staff on **Claude Sonnet 5.5** (`claude-sonnet-5-5`): **Shopkeeper** (sells via chat: `menu_lookup`, `quote`,
`create_order`, `escalate`), **Support** (`order_status`, `request_refund`, `escalate`) and **Bookkeeper**
(`ledger_read`, `reconcile`, `approve_refund`, `escalate`; in chat and `/ask`, whose callers are unauthenticated, only `ledger_read`, `reconcile`, `escalate`: safer, so no chat path approves refunds). The offered tools are always the agent's configured list
(`configuration.agents[].tools`) ∩ the guard registry `TOOLS` ∩ the implemented tools.

Every tool call: **LLM -> guard (`wrapTool`) -> platform reducer as the agent's own identity -> DecisionRecord**.
- The manual loop (`loop.ts`) caps iterations (8), runs parallel tool calls in order and returns all `tool_result`
  blocks in one user message. A refusal goes back as `is_error: true` with the guard's reason, rule ids, `maxAllowed`
  and `wouldChangeIf`, so the model can explain it; an escalation comes back as `status: escalated_to_owner` (the
  guard already opened the inbox item). A tool the agent was not offered (or an unknown name) is refused by the loop
  and recorded (`agent_tools.not_offered`). Exactly one DecisionRecord per tool call.
- History is append-only: the full `response.content` (thinking blocks included) is appended unchanged. `stop_reason`
  `refusal` / `max_tokens` / context exhaustion are checked before content is read; nothing in such a response runs,
  a fixed reply is given and a fixed assistant text closes the turn. Model params: `tool_choice` auto, no `thinking`
  param (adaptive default), no sampling params, no prefill, `output_config.effort: "medium"`, no server-side fallback.
- The system prompt (`prompt.ts`) comes only from the active configuration (business facts, menu prices, policies,
  goals, escalation rules; `_unconfirmed`/TBD facts are marked "not confirmed, escalate"; costs are never shown to the
  Shopkeeper) and the platform `precedent` rows for that role, re-read every turn (owner inbox answers saved as
  precedents reach the agent on its next turn). Customer text (and anything pasted from web pages) is sent only as a
  JSON-escaped `<customer_message>` data block. The role comes from the route path and the identity from the brain's
  identity store; no text or body field can change either.
- **Shopkeeper orders** go through the storefront checkout path (`payments/checkout.ts` `checkoutOrder`, now shared):
  the platform prices the order from the catalog as the **shopkeeper** identity, channel `agent`, and the pay link is
  made exactly as for the storefront. Discounts only with an owner precedent (prompt) and always guard + platform
  checked. Coupon codes are **not honored** (the configuration has no coupon list to verify them; the tool refuses).
- **Support** `request_refund` creates a draft as the support identity; over the role limit or outside the window the
  guard escalates to the inbox and nothing is created. `order_status` returns no customer name (callers are not verified).
- **Bookkeeper** tools only read and compute facts (`books.ts`): documents with journal totals, trial balance;
  `reconcile` = unbalanced documents, processor statement vs processor documents (missing / duplicate / amount
  differences), Stripe clearing 1010 vs statement net, stock running balances, closed periods. The agent decides what
  is an error. Live books come from the platform (statement = the `processor_event` table, not a fresh Stripe read).

Routes (mounted in `server.ts` with one line): `POST /agents/:role/message {businessId, conversationId, text}` ->
`{reply, toolCalls:[{tool, args, decision, result}], stopReason}` (conversations in memory, 500 max, one turn at a time
per conversation); `POST /ask {businessId, question}` -> the Bookkeeper with read tools + escalate only ->
`{answer, refs, unverifiedRefs, toolCalls}`; `refs` are `[doc <id>]` citations that appeared in tool output,
anything else is listed as `unverifiedRefs`. 503 without `ANTHROPIC_API_KEY`.

Red team (`harness.ts`): `createAgentHarness({staff})` implements `redteam/src/run.ts` `AgentHarness`
(`send(target, turns, mode) -> Transcript`). `napkin` = `maya-cookies` with the guard; `baseline` =
`maya-cookies-baseline` with `BaselineGuard`: the same prompt and tools, args only schema-parsed, no policy checks,
straight to the platform (enforce=false), still one DecisionRecord per call (`baseline.no_guard`). Target `platform`
returns a transcript with `error`. Extra: `harness.audit(plantedSet, mode)` runs the Bookkeeper on a provided book
set (answer key never sent) and returns findings `{kind, entries, note}` for `redteam/src/score.ts`.

Real vs simulated: the agent loop, guards, platform calls and DecisionRecords are real. Tests use a scripted LLM
(`test/agents.test.ts`, `test/agents.fakes.ts`; fixture costs are placeholders, TEST data). Real smoke run against a
scratch DB: `cd platform && spacetime publish napkin-j --server local --yes`, then
`pnpm --filter @napkin/brain exec tsx --env-file=../../.env scripts/agents-smoke.ts [--audit]` (hard-wired to
`napkin-j`; payments are the DEV SIMULATOR, so pay links are `?simulate=1` order pages, not Stripe).
