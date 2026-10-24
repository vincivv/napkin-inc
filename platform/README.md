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
| 7 | exactly-once payments: `processor_event.eventId` dedupe; `payment_received`, `processor_fee` and `payout` exist only through `recordProcessorEvent` (`createDocument` refuses them for every role, baseline included); side effects go through `outbox` keyed `refund:<docId>` (refunds) or queued by the system actor via `enqueueOutbox` (kind `sms` only, idempotent on the key); a processor refund matches its outbox item by exact ref | `recordProcessorEvent`, `createDocument`, `afterRefundPosted`, `processRefundSucceeded` |
| 8 | nothing posts into a closed period; only months that have ended can be closed (`closePeriod` refuses the current and future months), so postings, including processor events, always land in an open month; posted documents are never edited (reversal documents only) | `closePeriod`, `openPeriod`, `reversePosted` |
| — | money the customer paid stays accounted for: processor documents cannot be reversed; a paid sale can be reversed only after it is fully refunded (refund first via `requestRefund`); a refund cannot be reversed once its order's sale was reversed, or once its processor refund is in flight or sent | `reverseDocument` |
| — | rates are whole basis points in [0, 1], the domain the prover proves (`services/prover`): `createOrder`'s `discountRate`, every document field typed `rate`, and the `marginFloor`, `maxDiscount`, `taxRate` policies in `submitConfiguration`. Enforced on the baseline too (input domain, not a policy) | `checkRate`, `checkRatePolicies` |

Roles come only from the `actor` table, which is filled by `claimSystem` (the first caller, the brain) and by
one-time `createRoleGrant`/`redeemRoleGrant` codes. They are never taken from arguments.

**Red-team baseline:** `registerBusiness(enforce=false)` creates a business on which role checks, SoD,
policy checks and role limits are skipped, and caller-supplied prices are accepted. Balance (1), stock (3),
dedupe (7, including the processor-documents-only-via-events rule), the period lock (8), the reversal rules,
the rate domain, cross-business isolation and platform administration (claiming system, registering
businesses, role grants) are still enforced.

## Files

- `src/schema.ts`: tables (contract).
- `src/index.ts`: reducers (contract signatures; their doc comments are the spec).
- `src/core.ts`: shared machinery. All posting math is delegated to `@napkin/ledger-core`.
- `test/platform.test.ts`: reducer tests (including `enqueueOutbox`).
- `test/property.test.ts`: fast-check property test (150 random sequences of orders, payments, refunds,
  reversals of sales/refunds/payments, stock receipts, clock advances across month ends and period closes).
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

Brain-queued side effects: `enqueueOutbox(businessId, kind, payloadJson, idempotencyKey)` (system only, refused
for every other role, the red-team baseline included) inserts a pending outbox row. Only kind `sms` is allowed
(refunds are queued only by posting a refund document). `payloadJson` must be a JSON object of at most 2048
bytes; `idempotencyKey` is 1..200 characters. It is idempotent on the key (the existing `idempotencyKey` unique
index, no schema change): the same business, kind and payload is a no-op, anything different under that key
is refused. The brain's outbox worker drains it with `claimOutbox`/`completeOutbox` like any other row (the phone
line queues pay-link texts as `paylink:<orderId>`). A failed `sms` completion opens no inbox item; that is only
for refunds.

Reversal: `reverseDocument` (bookkeeper/owner) posts a mirror document. It refuses processor documents
(`payment_received`, `processor_fee`, `payout`) and a sale whose order is paid and not fully refunded
("refund first via requestRefund"). Unpaid sale drafts are drafts: there is nothing posted to reverse.

Periods: `closePeriod` closes only a month that has ended (by `ctx.timestamp`, UTC). Everything posts into the
current month, so a late payment for an October order posts into November and is never refused.

### Calling over HTTP

`POST /v1/database/<db>/call/<snake_case_reducer>` with `Authorization: Bearer <token>` (from
`POST /v1/identity`). The body is a JSON array of positional args, and **struct fields are snake_case**,
e.g. `[{"product_id":"cookie_box6","qty":1}]`. u64/i64 can be sent as JSON numbers.

## Open questions (not decided here)

- **Fixture:** `sale.inventory` credits Inventory 1300 with every line's cost, including the sea-salt add-on,
  which has no stock item. The Inventory account then drifts below the stock register's value, by 0.20 per
  add-on sold. Should add-on cost go elsewhere, or should `sea_salt` get a stock item?
- **Refund, then reverse the sale (returned goods):** reversing a fully refunded sale is allowed (it restores
  stock and cancels the order), but the revenue reduction is then booked twice: Refunds (4200) keeps the refund
  and Receivables (1200) shows a credit of the same amount, as if the customer were still owed it. Should returned
  goods be booked with their own document (Dr 1300 / Cr 5000 + stock in) instead of a sale reversal, or should a
  fully refunded sale's reversal leave out the revenue lines? (Test: "a paid sale cannot be reversed until...".)
- **Paid order whose sale could not post (stock ran out):** the inbox says "restock and post the sale, or refund
  the customer", but `requestRefund` needs a posted sale, so only restocking works. A refund of an unposted sale
  would have to debit 1200 (not Refunds 4200). How should that refund be booked?
- **Sales tax with more than 4 decimals:** rates are whole basis points (the prover's domain), so a
  `taxRate` like 8.875% (`0.08875`) is refused by `submitConfiguration`. Raising the prover's
  `bounds.rateDenominator` (and the platform's check) to 100000 would allow it.
- **Bookkeeper payouts:** the fixture grants the bookkeeper `document.create:payout` and lists it in the payout's
  `creatorRoles`, but `createDocument` now refuses `payout` for every role (payouts come only from processor
  events). Should a manual bank transfer get its own document type?
- A replayed processor event writes an `audit_log` row and nothing else. A "replay" whose content differs (other
  business, kind, order or amount under the same event id) is also ignored silently. Refusing it would make the
  brain retry forever; opening an inbox item would repeat on every retry. Which do we want?
- Refunds above $15 can be approved only by the owner. If the owner requested the refund, SoD blocks the owner
  from approving it, so large refunds have to be requested by the shopkeeper (who has no refund limit).
- The refund window is checked against `hoursSinceSale` at request time, not at approval time.
- Reversing a refund puts the order back to `paid`/`partially_refunded` even if it was `ready` or `picked_up`
  (the earlier fulfilment status is not stored).

### Resolved

- Closed period vs incoming payments: `closePeriod` refuses the current and future months, so a processor event
  (which posts into the current month) is never refused for a closed period.
- Reversing a paid sale or a `payment_received`: refused (refund first via `requestRefund`; processor documents
  cannot be reversed). Reversing a refund after its sale was reversed is refused too.
- `createDocument` posting `payment_received`/`processor_fee`/`payout` directly: refused for every role.
- Rates outside the prover's domain (more than 4 decimals, outside [0, 1]): refused.
- A processor refund event matched an outbox item by substring of its result (`sim_re_1` matched `sim_re_12`):
  now an exact match.
