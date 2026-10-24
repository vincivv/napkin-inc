# What's real vs simulated

Updated at the end of each milestone. Current: **M1**.

## Real
- **Platform ("the 1C"):** a SpacetimeDB 2.13 TypeScript module running locally.
  - Generic catalogs, documents (draft → posted → reversed) and registers.
  - Double-entry journal, period close, roles with segregation of duties, audit log, live subscriptions.
  - All posting math goes through `@napkin/ledger-core`: exact rationals, no floats.
- **Invariants enforced inside platform transactions:**
  - balanced postings (1)
  - stock ≥ 0 (3)
  - discount cap and margin floor (4)
  - creator ≠ approver (5)
  - prices and policies change only through owner-activated configurations (6)
  - processor-event de-duplication, intent log and outbox (7)
  - immutable posted documents and closed periods (8)
- **Tests:** property-based tests for the invariants (fast-check) in ledger-core and platform.
- **Storefront:** live catalog and stock, cart, checkout through the brain, live order status, QR sheet.
- **Owner app:** live dashboard, orders, documents, registers, reports (trial balance, P&L, stock, receivables, payables, cash flow, margin by item), decisions, inbox, audit log, proof report page, owner PIN sign-in flow.
- **Brain:**
  - one SpacetimeDB identity per actor (system, storefront, shopkeeper, support, bookkeeper)
  - idempotent bootstrap
  - checkout, Stripe webhook handler with signature verification, outbox refund worker
  - owner PIN auth
- **Red-team assets:** 57 attacks in 12 categories, 11 chaos cases, 2 planted-error books with an answer key, and the results generator.

## Simulated or placeholder (be explicit on stage)
- **Payments: DEV SIMULATOR** until a Stripe test key is set.
  - The simulated payment runs through the same handler code as real Stripe webhooks.
  - The fee uses the list-price formula (2.9% + 30¢).
  - No Stripe API call has been made yet.
  - With a key, it is Stripe **test mode** only: no real money, ever.
- **Payouts:** simulated (Stripe test mode has no real bank).
- **Maya's numbers are placeholders**, flagged in the configuration's `_unconfirmed` block and in the owner app:
  - ingredient costs ($0.80 per cookie, $4.80 per box, $0.20 for sea salt)
  - starting stock (48)
  - tax rate (0)
  - pickup location and hours
- **M1 configuration is hand-written.** The proof report says "Not proven yet". The Z3 prover lands in M3.

## Not built yet
- **M2:** photo and voice intake, question engine, compiler, guards layer, owner inbox flows driven by agents.
- **M3:** Z3 proofs gating configurations (the prover is in progress on its own branch), the three AI staff, the phone line, wiring the red-team runs. No real `RESULTS.md` exists yet.

## Known gaps (tracked)
- **Sea-salt add-on cost:** its $0.20 cost is credited to Inventory (1300), but sea salt isn't a stock item. This needs an owner answer: is sea salt tracked stock, or a supply expense?
- **Reversing a paid sale:** this cancels the order but doesn't queue a refund. It should require or queue a refund.
- **Direct payment documents:** `createDocument` lets the system post `payment_received` directly. It should be restricted to the processor-event path so de-duplication can't be bypassed.
