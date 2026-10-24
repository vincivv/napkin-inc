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
