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
