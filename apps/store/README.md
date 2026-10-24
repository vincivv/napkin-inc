# @napkin/store — Napkin Inc. storefront

One Next.js 16 / React 19 / Tailwind v4 deployment (port 3002) serving every business by slug, mobile-first, themed from `config.storefront.theme`.

## Run
    pnpm --filter @napkin/store dev      # http://localhost:3002
    pnpm --filter @napkin/store build | typecheck | test

Env (all optional): `NEXT_PUBLIC_SPACETIMEDB_URI` (ws://localhost:3000), `NEXT_PUBLIC_SPACETIMEDB_DB` (napkin), `NEXT_PUBLIC_BRAIN_URL` (checkout/simulator host), `NEXT_PUBLIC_STORE_URL` (http://localhost:3002, used for QR codes; set to a LAN/public URL so phones can scan).

## Routes
- `/` businesses index; `/[slug]` catalog; `/[slug]/item/[entryId]`; cart drawer (localStorage)
- `/[slug]/order/[orderId]` live order status (`?simulate=1` shows the dev "Simulate test payment" button)
- `/[slug]/qr` printable business + per-item QR codes

## Real vs simulated
- Real: catalog, config, stock (`register_balance` "stock", `item=<stockItem>`, floor(qty/stockUnits)) and order status are live SpacetimeDB subscriptions (anonymous identity). Checkout POSTs `{businessId, lines, customerName, couponCode?}` to `${BRAIN_URL}/checkout`, shows the brain's refusal message, redirects to the returned url. Client totals are labelled estimates; the brain prices.
- Simulated: `/dev/simulate-payment/<orderId>` button (only with `?simulate=1`). Stripe is test mode only.
- Preview mode (`?preview=fixture`, off by default): renders from `fixtures/maya/configuration.json` with a banner; checkout disabled. Placeholder stock/pickup values ("TBD") are shown as-is.
