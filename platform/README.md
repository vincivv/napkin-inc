# @napkin/platform — the "1C"

A SpacetimeDB 2.13 TypeScript module: the deterministic core that owns the money. It stores any compiled
`Configuration` (documents, posting rules, registers, roles, policies) and runs every money movement as one
ACID reducer transaction. A rule violation throws `SenderError` and the whole transaction rolls back.

## AI vs deterministic

**Everything in this package is deterministic. There is no AI in it.** The brain's agents (Shopkeeper,
Support, Bookkeeper) and the compiler can only *call* these reducers. If the LLM were swapped or compromised,
these guarantees would still hold, because the platform re-checks them on `ctx.sender`:

| # | Invariant | Where |
|---|---|---|
| 1 | every posting balances (debits = credits), never skipped | `@napkin/ledger-core` `post()` + `checkBalanced` |
| 3 | no stock register goes negative (unless `allowNegative`/`backordersAllowed`) | `planBalances` (orders, postings, reversals) |
| 4 | policy checks: discount cap, margin floor, refund window, full-or-floor refunds (D4) | the configuration's `checks`, run by `post()` |
| 5 | segregation of duties: the creator cannot approve (`cannotApproveOwn`) | `checkCanApprove` |
| 6 | prices, costs and stock units come from the active catalog; they change only when the owner activates a configuration | `fillSaleLine`, `activateConfiguration` |
| 7 | exactly-once payments: `processor_event.eventId` dedupe; side effects go through `outbox` keyed `refund:<docId>` | `recordProcessorEvent`, `afterRefundPosted` |
| 8 | nothing posts into a closed period; posted documents are never edited (reversal documents only) | `openPeriod`, `reversePosted` |

Roles come only from the `actor` table, which is filled by `claimSystem` (the first caller, the brain) and by
one-time `createRoleGrant`/`redeemRoleGrant` codes. They are never taken from arguments.

**Red-team baseline:** `registerBusiness(enforce=false)` creates a business on which role checks, SoD,
policy checks and role limits are skipped, and caller-supplied prices are accepted. Balance (1), stock (3),
dedupe (7), the period lock (8), cross-business isolation and platform administration (claiming system,
registering businesses, role grants) are still enforced.

## Files

- `src/schema.ts`: tables (contract).
- `src/index.ts`: reducers (contract signatures; their doc comments are the spec).
- `src/core.ts`: shared machinery. All posting math is delegated to `@napkin/ledger-core`.
- `test/platform.test.ts`: reducer tests (34 scenarios).
- `test/property.test.ts`: fast-check property test.
- `test/helpers.ts`: test harness.

## Run

```sh
pnpm --filter @napkin/platform test        # vitest, in-process (spacetimedb/server/test-utils), ~2 s
pnpm --filter @napkin/platform typecheck   # module (no Node types) + tests
pnpm --filter @napkin/platform publish     # spacetime publish napkin --server local --yes
pnpm --filter @napkin/platform generate    # regenerate packages/stdb-bindings
```

The tests use SpacetimeDB's own module test utilities (`createModuleTestHarness`, a real datastore compiled
to Wasm, wired by `spacetimedbModuleTestPlugin` in `vitest.config.ts`). Each actor is a separate JWT subject,
so `ctx.sender` differs per actor exactly as it does in production. Note: inside the module the SDK replaces
`console`, so use `process.stdout.write` in tests when you need to debug.

### Bootstrap sequence (what the brain does)

1. `claimSystem()`: the brain's identity becomes `system`.
2. `registerBusiness(id, name, enforce)`.
3. `submitConfiguration(businessId, json, proofReportJson)`: stored as `pending`. A proof report containing a
   `failed` proof is rejected; `""` means no report yet.
4. `activateConfiguration(configId)`: system may do this only while the business has no active config and
   no owner. After that it is owner-only. The first activation posts `opening_balance` from `initialStock`.
5. `createRoleGrant(code, businessId, role, name, ttl)`, then the target identity calls `redeemRoleGrant(code)`.
   Only `system` can grant `owner`.

Sale: `createOrder` (storefront/shopkeeper/owner) creates the order and a sale draft, and checks the discount
cap, margin floor and stock. `recordProcessorEvent(kind="payment_succeeded")` from system then posts
`payment_received` and, in the same transaction, the sale (approved by system), and marks the order paid. A
wrong amount, an unknown order or an already-paid order opens an inbox item and posts nothing. If stock ran out
between the order and the payment, the payment is still booked, the sale stays a draft, and the owner is asked.

Refund: `requestRefund` (support/shopkeeper/owner) creates a draft; the platform fills in the sale facts.
`postDocument` by bookkeeper/owner (not the requester) posts it and queues exactly one `stripe_refund` outbox
item. The brain then calls `claimOutbox` and `completeOutbox`. The `refund_succeeded` webhook completes the
item idempotently.

### Calling over HTTP

`POST /v1/database/<db>/call/<snake_case_reducer>` with `Authorization: Bearer <token>` (from
`POST /v1/identity`). The body is a JSON array of positional args, and **struct fields are snake_case**,
e.g. `[{"product_id":"cookie_box6","qty":1}]`. u64/i64 can be sent as JSON numbers.

## Open questions (not decided here)

- **Fixture:** `sale.inventory` credits Inventory 1300 with every line's cost, including the sea-salt add-on,
  which has no stock item. The Inventory account then drifts below the stock register's value, by 0.20 per
  add-on sold. Should add-on cost go elsewhere, or should `sea_salt` get a stock item?
- **Closed period vs incoming payments:** a `payment_succeeded` event in a closed period is refused, which rolls
  back the whole call, including the `processor_event` row. The brain will keep retrying, and there is no
  reducer to reopen a period. Should it open an inbox item instead?
- **Reversing a paid sale:** the order becomes `cancelled`, but no refund is queued, so the customer's money
  sits in 1200 as a credit. Reversing a `payment_received` leaves the order `paid`. Should either one queue a
  refund, open an inbox item, or be refused?
- `createDocument` lets `system` post `payment_received`/`processor_fee` directly, outside processor-event dedupe.
  The contract allows this. Should it be restricted to `recordProcessorEvent`?
- A replayed processor event writes an `audit_log` row and nothing else.
- Refunds above $15 can be approved only by the owner. If the owner requested the refund, SoD blocks the owner
  from approving it, so large refunds have to be requested by the shopkeeper (who has no refund limit).
- The refund window is checked against `hoursSinceSale` at request time, not at approval time.
