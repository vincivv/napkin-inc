# What's real vs simulated

Updated at the end of each milestone. Current: **M1 + M2 + most of M3** (red-team runs in progress).

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

- **M2:** compiler, Z3 proofs that gate activation, guards with DecisionRecords, owner Build/Activate page.
- **M3 AI staff:** Shopkeeper, Support and Bookkeeper run on Claude Sonnet 5.5 with real API calls. Every tool call goes through the guards, then the platform, then a DecisionRecord.
- **M3 phone line:** the 7 webhook tools, owner verification, and the SMS outbox are real code, tested against the platform.

## Simulated or placeholder (be explicit on stage)
- **Phone:**
  - The Cartesia agent hasn't been created yet (dry run only), and no phone number is attached.
  - Texts go through the **SMS SIMULATOR** until Twilio keys are set; the caller is told no text was sent.
  - The Twilio adapter is tested only against a fake.
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
- **M2:** compiler and guards layer (in progress), owner inbox flows driven by agents. Photo/voice intake and the question engine are **real** (Claude Opus 5.5 vision + Cartesia STT; verified with real keys).
- **M3:** red-team runs against the real system are in progress. No real `RESULTS.md` exists yet. Posting-rule synthesis from the spec's examples isn't wired into the compiler: it's reported as "skipped", and the examples are checked against the template instead.

## Known gaps (tracked)
- **Sea-salt add-on cost:** its $0.20 cost is credited to Inventory (1300), but sea salt isn't a stock item. This needs an owner answer: is sea salt tracked stock, or a supply expense?
- **Fixed overnight (platform hardening):**
  - Processor documents (payment, fee, payout) are created only through de-duplicated processor events.
  - A paid sale can't be reversed until it is refunded.
  - Processor documents can't be reversed.
  - Rates are in [0, 1] with at most 4 decimals, matching the prover.
  - The current and future months can't be closed.
  - Refund events are matched to outbox items exactly.
- **Open (owner/accounting decisions):** see docs/MORNING.md and platform/README.md.
