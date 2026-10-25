# Devpost answers

## About the project (paste everything between the lines)

---

## Inspiration

I've always wanted to start a side business. I had the ideas, and some of them are still sitting in my notebook: what I'd sell, rough prices, who might buy it. But I never actually started, and if I'm honest, it's because I was scared. Not of the idea itself, but of everything around it: setting up books, tracking stock, taxes, payments, the feeling that one mistake with money would sink the whole thing before it began.

When I looked for help, the options didn't fit someone like me. A website builder gives you a pretty page with nothing behind it. Real business software, the accounting and inventory systems bigger companies run on, does everything, but it assumes you already know what you're doing, or can pay someone who does.

I figured there are a lot of people like me, with a notebook full of ideas and no idea how to turn one into a real business. So I built the thing I wish I'd had. You bring the page from your notebook, and it sets up the serious part for you: a real back office with real books. Only then does AI run on top of it, under rules it physically can't break, because handing your money to an AI that can be sweet-talked into a 50% "birthday discount" is exactly the kind of thing that would have kept me from starting. The line I kept coming back to: **the AI talks and judges; code owns the money and the rules.**

## What it does

You take a photo of your notebook, and Paper to Biz turns it into a running business.

- **Intake.** Claude reads the paper and pulls out the facts: products, prices, costs, add-ons, policies. Every fact keeps the quote and the spot on the photo it came from, and it's marked "read from paper," "owner said," or "my guess." Nothing that was guessed is allowed to touch money.
- **Interview.** A few one-tap questions fill the gaps. Money questions keep their exact wording, because early on a model "helpfully" rephrased *cost of the sea-salt add-on* into *cost of a batch*.
- **Compile.** The facts become a configuration: chart of accounts, catalogs, stock items, posting rules, discount and refund policies. Before anything goes live it does a dry run of sample postings, and Z3 proves that every document balances, discounts can't stack below the margin floor, and stock flows add up. If a proof fails, the shop doesn't launch.
- **The back office.** This is the core of the whole thing. A double-entry journal, documents that go draft → posted → reversed (posted ones are never edited), stock registers, periods you can close, roles with segregation of duties, and an audit log. Plus the official side: expenses, receipt scanning, a sales tax report, CSV exports for your accountant, and a legal checklist that links to real IRS and SBA pages.
- **What runs on top:**
  - a generated storefront with its own design, openly licensed photos, live stock, QR codes and Stripe checkout (test mode);
  - an AI phone line: call **+1 906-498-9806**, say the shop's 4-digit code, and order by voice;
  - AI staff (Shopkeeper, Support, Bookkeeper) who talk to customers and send anything they're unsure about to the owner's inbox instead of guessing. The owner's answers become precedents they follow next time.

When someone pays, the owner's dashboard updates live: the order, the Stripe fee split out, stock down by one, and a "Books balance ✓" that's actually computed from the journal, not hardcoded.

## How I built it

I built it solo over the weekend.

- **SpacetimeDB is the system of record.** The whole back office is a TypeScript module: tables, reducers, live subscriptions. Every reducer is one ACID transaction, and that's where the rules live. Balanced postings, stock never going negative, the margin floor, creator ≠ approver, owner-only price changes and immutable posted documents are all re-checked inside the transaction. If anything is off, it throws and everything rolls back, so even a compromised AI layer can't break them.
- **Money is integer cents with exact rational math.** No floats anywhere money moves.
- **Z3 proves the configuration before it can activate.** Posting rules are written in a small DSL, and the prover and the database share the same AST, so the rule that gets proven is literally the rule that posts. The hardest proof is discount stacking: for every product, every quantity, and every base discount plus up to *k* coupons the policy accepts, each line has to stay above cost plus the margin floor *m*.

$$\forall\, p,\;\; q \in [1, 10^4],\;\; d = d_0 + \sum_{i=1}^{k} c_i \le d_{\max} \;:\quad \text{round}_2\big(q \cdot \text{price}_p \cdot (1 - d)\big) \;\ge\; q \cdot \text{cost}_p \cdot (1 + m)$$

Z3 proves it by asserting the negation and getting `unsat`. Rounding is encoded with integer division, so the solver does the exact same arithmetic as the runtime, down to the cent:

$$\text{round}_2\!\left(\frac{t}{s}\right) = \frac{1}{100}\left\lfloor \frac{200\,t + s}{2s} \right\rfloor$$

A timeout is never treated as a proof, and every counterexample is replayed through the real posting engine before it's shown. When the proof fails, the prover computes the largest safe discount, d* = 1 − (1 + m) · cost / price, as an exact fraction (for the demo cookie shop: 73/125, or 58.4%, set by the box of 6), re-runs the proof with that fix, and only then suggests it to the owner.

- **Posting rules can be learned from examples.** If the owner says "6 cookies at $2.50 each come to $15," the prover does bottom-up program synthesis: it enumerates small expressions over `+ − × round₂ (1 − x)` and catalog lookups, with unit types (money, quantity, rate) and observational-equivalence pruning, then keeps the simplest rule that fits every example. If two different rules fit equally well, it doesn't guess. It finds the input that tells them apart and asks: *"For 6 at $2.50 with a 10% discount, should revenue be $15.00 or $13.50?"*
- **Claude does the reading and talking.** Opus 5.5 reads notebook pages and receipts, designs the storefronts and drafts the legal checklist. Sonnet 5.5 runs the AI staff and picks photos. Haiku 5.5 handles phrasing and powers the phone agent. Every agent tool call goes through guards, then the platform, then gets written down as a DecisionRecord.
- **Cartesia** runs the voice agent and the speech-to-text for voice intake. The phone agent calls 8 webhook tools on my backend. Owner instructions given over the phone only get queued; they apply after the owner confirms in the app.
- **Stripe, test mode only** (the backend refuses to start with a live key): Checkout, signed webhooks, fees read from the balance transaction, and refunds through an outbox with idempotency keys. Webhooks are de-duplicated in the same transaction as the posting, so a payment lands exactly once.
- **Next.js on Vercel** for the owner app and the storefronts, a **Hono** backend for the AI and payments, and **zod**, **vitest** and **fast-check** property tests for all the deterministic parts.

## Challenges I ran into

- **Getting AI and accounting to coexist.** LLMs are great at reading a messy napkin and terrible at being the source of truth for money. Deciding exactly where that line goes, what the model may decide and what code has to own, took most of my design time.
- **Proving the thing that actually runs.** It's easy to prove a model of your system and then ship different code. Sharing one posting-rule AST between Z3 and the database fixed that, but getting cent-level rounding to match exactly on both sides took a while.
- **Payments are messy.** Stripe's fee isn't always there when checkout completes, webhooks can arrive twice, and refunds can be split. My own red team found a split-refund hole (two small refunds sneaking under a limit that one big refund would hit). I fixed it by counting pending drafts against the per-order limit.
- **Real-world integrations.** Twilio's trial had a $0 balance, so SMS is simulated: the phone agent reads your order number out loud and you pay at a short link. The backend runs on my laptop behind a Cloudflare tunnel, so I wrote a watchdog that opens a new tunnel, redeploys and re-points the phone line by itself if the old one dies.

## Accomplishments that I'm proud of

- **I attacked it 45 different ways, in two modes.** With the real Claude staff: 3 breaches with my guards off, **0** with them on. With a scripted "compromised model" that always goes for the attack: 18 breaches with guards off, **0** with guards on. **$0 lost** in every run.
- Going from a photo to a live shop with proven books, a storefront and a phone line takes about half a minute of machine time. The slow part is the human answering questions, which is how it should be.
- It's not a one-shop demo. Anyone can sign up, and every account gets its own business, its own database identity and its own storefront.
- Every number on the dashboard comes from the posted journal. Nothing is faked to look good.

## What I learned

- The best way to make AI agents safe is to give them less power, not better prompts. Once the rules lived inside the database transaction, I stopped worrying about jailbreaks.
- "Never assume" is a real design principle. Letting the system say "I don't know, let me ask the owner" made it far more trustworthy than letting it guess.
- Formal methods are more practical than I expected. A Z3 proof takes around 80 ms, fast enough to sit right in the middle of onboarding.

## What's next for Paper to Biz

- Real SMS, and a phone number per business instead of one shared line.
- Bank feeds and real payouts, so the books reconcile against an actual bank account.
- More templates beyond selling products: services, appointments, subscriptions.
- An accountant role, so owners can bring their bookkeeper in with the right permissions.

---

## Built with (19 tags; type each and press Enter)

typescript, node.js, next.js, react, tailwindcss, hono, spacetimedb, claude, anthropic, z3, stripe, cartesia, vercel, cloudflare, zod, vitest, fast-check, openverse, pnpm

## "Try it out" links

1. https://paperto.biz (sign up and turn a napkin into a business)
2. https://napkin-store.vercel.app/maya-cookies (a live demo storefront; pay with test card 4242 4242 4242 4242)
3. https://github.com/vincivv/napkin-inc (the repo is private right now; make it public before adding this link)
