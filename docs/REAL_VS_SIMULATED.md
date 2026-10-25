# What's real vs simulated

Updated Sat 2026-10-24, evening, for the hosted demo (Devpost submission). If something here disagrees with
the code, the code wins; tell us.

## Real

**The hosted demo**
- Owner app: https://napkin-owner.vercel.app. Store: https://napkin-store.vercel.app. Both on Vercel.
- System of record: SpacetimeDB maincloud, database `napkin-inc-mayas`.
- The brain (orchestrator) runs on the builder's laptop behind a Cloudflare tunnel. If the laptop sleeps,
  the demo is down; nothing is faked to hide that.

**Accounts and onboarding**
- Sign up with email and password (scrypt-hashed, sessions as hashed bearer tokens), one business per
  account. Each account gets its own SpacetimeDB identity and is granted the owner role for its own
  business only. Another account's business answers 403.

**Napkin to business**
- Photo intake: Claude Opus 5.5 reads the napkin and returns facts, each with its quote and image region.
  Voice intake: Cartesia speech-to-text (`ink-whisper`).
- The interview: a deterministic question engine. Money questions keep their exact wording; nothing about
  money is guessed. Facts carry provenance (read from paper, owner said, inferred).
- The compiler: template, posting-rule synthesis from the owner's worked examples (Z3), a 16-posting dry
  run, and Z3 proofs (balance, discount stacking, flow) that gate activation. Then the configuration is
  submitted to the platform and the AI staff and storefront identities are created.

**The books (the "1C")**
- A SpacetimeDB TypeScript module: catalogs, documents (draft, posted, reversed), double-entry journal,
  registers (stock and others), periods, roles with segregation of duties, an audit log, live subscriptions.
- Money is integer cents with exact rational math (`@napkin/ledger-core`); no floats anywhere money moves.
- Invariants enforced **inside platform transactions**, so a compromised brain still can't break them:
  balanced postings (1), stock ≥ 0 (3), discount cap and margin floor (4), creator ≠ approver (5), prices
  and policies change only through owner-activated configurations (6), immutable posted documents and
  closed periods (8). Exactly-once payments (7): processor events are de-duplicated in the same
  transaction as the posting; refunds and texts go through an outbox with idempotency keys.

**Payments**
- Stripe **test mode**, real API calls: Checkout Sessions, signed webhooks (`stripe listen` forwards them to
  the brain), fees read from the balance transaction, refunds through the outbox. The brain refuses to
  start with a live key. Test card: 4242 4242 4242 4242. No real money moves, ever.

**AI staff**
- Shopkeeper, Support and Bookkeeper run on Claude Sonnet 5.5. Every tool call goes through the guards,
  then the platform, then a DecisionRecord. Escalations land in the owner's inbox; the owner's answers
  become precedents the staff follow.
- Customers can chat with the Shopkeeper and Support on the storefront ("Ask the shop"); each reply shows
  what the guards allowed, refused or sent to the owner.

**Phone line**
- +1 906-498-9806, one number shared by every live shop: the agent asks which shop and the brain ties the
  call to it. A Cartesia voice agent (Claude Haiku 5.5, voice "Skylar") calling 8 webhook tools on the
  brain: find the shop, menu, order, order status, escalate, and owner verification / report / instruction. Owner instructions only queue; they apply after the owner confirms in the app.

**Storefronts**
- Each business gets a generated storefront design: Claude Opus 5.5 proposes the style (editorial or bold),
  palette, fonts, wording and photo searches; code checks every field (contrast, fonts, no prices, numbers
  or invented claims). Photos are openly licensed (Openverse: CC0, public domain, CC BY, CC BY-SA) with
  credits in the footer, or uploaded by the owner. The design never touches money: prices and stock come
  from the books.

**Red team** (`redteam/RESULTS.md`, measured, not estimated)
- 45 runnable attacks × 2 modes against the real platform. Real Claude Sonnet 5.5 staff: 3 breaches with
  guards off, **0** with guards on. A scripted "compromised model": 18 breaches with guards off, **0** with
  guards on. $0 lost in every run. Chaos: 8/8 pass.

## Simulated or placeholder (say so on stage)
- **SMS:** a simulator. Twilio was skipped (trial balance $0), so callers are told the order number out
  loud and pay at https://napkin-store.vercel.app/pay.
- **Payouts:** Stripe test mode has no real bank, so payouts are processor events, not bank transfers.
- **Maya's numbers are placeholders**, flagged in her configuration's `_unconfirmed` block and in the
  owner app: ingredient costs ($0.80 per cookie, $4.80 per box, $0.20 for sea salt), starting stock, tax
  rate 0, and pickup location and hours (hidden from customers while they say "TBD").
- **Maya's Cookies' configuration is the hand-written M1 fixture.** Businesses created through the app get
  compiled, Z3-proven configurations.
- **Red-team runs** used a local scratch database and the Stripe simulator, not the hosted demo.

## Not built / known gaps
- Shops share one phone number (the caller says the shop name); no business gets its own number.
- Phone owner mode is off until an owner phone number is configured, and then only for Maya's Cookies.
- The sea-salt add-on's $0.20 cost is credited to Inventory although sea salt isn't a stock item (an
  open accounting decision for the owner).
- Other open owner decisions are listed in `docs/HANDOFF.md` section 11 and `docs/MORNING.md`.
