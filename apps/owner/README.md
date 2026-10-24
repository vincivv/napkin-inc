# @napkin/owner — owner back office (port 3001)

A calm, dense finance back office for the business owner. Next.js 16, React 19, Tailwind v4.
Everything is live: the app subscribes to SpacetimeDB tables for one business and re-renders as rows change.

## Run
```
pnpm --filter @napkin/owner dev        # http://localhost:3001
pnpm --filter @napkin/owner build
pnpm --filter @napkin/owner typecheck
```
Env (all optional): `NEXT_PUBLIC_SPACETIMEDB_URI` (ws://localhost:3000), `NEXT_PUBLIC_SPACETIMEDB_DB` (napkin),
`NEXT_PUBLIC_BRAIN_URL` (http://localhost:4000), `NEXT_PUBLIC_BUSINESS_SLUG` (maya-cookies).

## Screens
Dashboard, Orders (+detail, mark ready / picked up), Documents (+detail: fields, lines, journal lines, register
movements, approval roles, reversal links; post drafts you did not create; reverse with reason), Registers,
Reports (trial balance via `@napkin/ledger-core`, P&L, stock, receivables, payables, cash flow, margin by item),
Decisions, Inbox (answer + "make this a precedent"; phone owner statements "needs your confirmation"), Audit log,
Proof report (active `proofReportJson`, else "Not proven yet"; plus "Facts not confirmed by the owner"),
Intake (photo + voice -> facts drawn over the photo with provenance badges and confidence), Interview (one top-impact question at a time, owner-statement diffs to confirm, money-ready checklist), Build (compile the confirmed spec with live SSE progress from `POST {BRAIN_URL}/compile`; typed refusals with the
owner questions and a link to the Interview; the newest pending version diffed against the active one: prices, costs,
stock units, policies, accounts, starting stock, role limits, storefront; its proof report, with stub proofs labelled
"skipped (stub)"; owner-only "Activate configuration vN" via the `activateConfiguration` reducer). Intake/Interview/Build
talk to the brain (`NEXT_PUBLIC_BRAIN_URL`).

## Owner sign-in
`/signin`: PIN -> `POST {BRAIN_URL}/auth/owner {pin}` -> `{code}` -> `redeemRoleGrant(code)` with this browser's own
SpacetimeDB identity (token in localStorage). The PIN is cleared immediately and never stored. Owner-only buttons are
disabled with a tooltip until the identity has the `owner` actor row.

## Preview mode
`/?preview=fixture` (leave with `?preview=off`) swaps the data source for an in-memory world: invented customers,
orders, fees and agent decisions, posted through the real `@napkin/ledger-core` engine using
`fixtures/maya/configuration.json`. Nothing is written to SpacetimeDB. "Simulate a sale" adds a live order; the
sign-in page offers a one-click preview sign-in. Use it to check the design when the local database is empty.

## Real vs simulated
Real: subscriptions, reducer calls, report math (bigint cents, string formatting, no floats), trial balance engine.
Simulated only in preview mode (data + owner actions). Display-only stock "low/critical" levels are a UI hint, not a rule.

## Layout
`src/data` (live and preview sources behind one `useData()` context), `src/lib` (money, reports, config naming),
`src/components` (design system and widgets), `app/*` (routes).
