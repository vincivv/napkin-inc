# Handoff: Napkin Inc. (Cal Hacks 13.0)

Written Sat 2026-10-24, about 6 PM PT, at commit `d74e223` plus this file. It is for the next Claude agent
(or person) who picks the project up. Read this first, then `docs/AGENT_BRIEF.md` (rules) and
`docs/PLAN.md` (architecture). `docs/MORNING.md` holds the overnight log and the decisions saved for the
owner. It is accurate up to the red-team work, but older than this file.

---

## 1. The goal

- **Event:** Cal Hacks 13.0, Palace of Fine Arts, SF. The owner is building solo.
  - **Submission deadline (Devpost): Sun Oct 25, 9:00 AM PT.**
  - **Judging: 10:30 AM–12:30 PM** with a live demo.
- **What the owner wants:** a jaw-dropping demo that judges use themselves, not a slideshow. Sponsor tech is
  plumbing, never the pitch. Judging criteria: Application, Functionality/Quality, Creativity, Technical
  Complexity.
- **The product:** Napkin Inc. A photo of a napkin sketch (or a voice description) becomes a running business:
  - a storefront with QR codes and a Stripe **test-mode** checkout;
  - an AI phone line;
  - three AI staff (Shopkeeper, Support, Bookkeeper);
  - a 1C-style back office whose books are proven to balance (Z3).
- **Core principle, used in every design decision:** *the AI does the talking and judgment; deterministic code
  owns the money and the rules.* If the LLM were swapped for a hostile one, no money guarantee may break. The
  red team measured exactly that.

## 2. Hard rules (from the owner; do not relax them)

1. **Secrets live in `.env` only** (repo root, gitignored). Never print, log or commit them. `.env.example`
   lists the names.
2. **Stripe TEST MODE only.** The brain refuses `sk_live`/`rk_live` keys. No real money, ever.
3. **Never invent business facts** (prices, costs, stock). Unconfirmed facts are flagged and asked about.
4. **Do not touch the shared local `napkin` SpacetimeDB database from experiments.** Use a scratch DB such
   as `napkin-<letter>`.
5. **The repo is private** (`github.com/vincivv/napkin-inc`). It must go public before the Devpost
   submission, but **ask the owner first** (decision D7).
6. **Standing permission:** the owner said to create whatever is needed (repo, connectors, deploys) and to use
   subagents. Pick the model by task difficulty:
   - Opus for correctness-critical work;
   - Sonnet for plumbing and UI;
   - Haiku for data chores.

   Run **at most 3 subagents at once**; 6 tripped rate limits.
7. **Commit messages end with** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Branch-per-agent
   for parallel work; merge to `main` yourself after checking.
8. The owner reads prose, not jargon. Lead with what they can do and see.

## 3. What exists and works

### Repo layout (pnpm monorepo, Node 24, TypeScript, vitest)

| Path | What it is |
|---|---|
| `platform/` | SpacetimeDB 2.13 TypeScript module: tables and reducers (orders, ledger, stock, roles, outbox, decisions). The system of record. |
| `packages/ledger-core` | Exact `Rational` math, the posting DSL and engine, and invariant predicates. Frozen contract. |
| `packages/schema` | zod contracts: `Configuration`, `BusinessSpec`, `Fact`, `DecisionRecord`, `ProofReport`. Frozen contract. |
| `packages/stdb-bindings` | Generated client bindings (`pnpm --filter @napkin/platform generate`). |
| `services/brain` | Hono HTTP server on :4000. It handles intake (photo and voice), the question engine, the compiler, guards, AI staff, the phone tools, Stripe, accounts and bootstrap. |
| `services/prover` | Z3 proofs (balance, discount stacking, flow) and posting-rule synthesis. |
| `apps/owner` | Next.js 16 owner app on :3001: landing, sign-up, setup steps, back office. |
| `apps/store` | Next.js 16 storefront on :3002: `/<slug>` shop, `/pay`, order pages. |
| `redteam/` | Attack, chaos and planted-error runner. `redteam/RESULTS.md` has the final real numbers. |
| `fixtures/maya/` | Maya's Cookies: the hand-written configuration and a synthetic napkin photo and voice transcript. |
| `scripts/brain-cloud.sh`, `scripts/deploy-web.sh` | Run the hosted brain, and deploy both web apps. |

### Milestones

- **M1, done:** Maya's Cookies end to end. Storefront checkout and a Stripe test payment post a balanced
  sale; the owner dashboard updates live.
- **M2, done:** napkin to configuration.
  - Intake reads the photo with Claude Opus 5.5, and Cartesia transcribes the voice. Every fact carries its
    provenance: paper, owner_said, or inferred.
  - The interview asks money questions first, in exact wording.
  - The compiler then fills the template, Z3 proves the books, a dry run checks the postings, and the
    configuration is activated.
- **M3, done:**
  - **AI staff** run on Claude Sonnet 5.5, with every tool call guarded and logged as a DecisionRecord.
  - **Phone line:** a Cartesia agent with 7 webhook tools.
  - **Red team:** 45 attacks in two modes. With the guards there were 0 breaches and $0 lost, against a real
    model and against a scripted compromised model. Without the guards, the same runs had 3 and 18 breaches.
- **Multi-tenant accounts, done today (commit `d74e223`):**
  - The landing page has a **Start your business** button that leads to sign-up (email and password).
  - Next the owner names the business (**one business per account**) and goes through three setup steps:
    Your napkin → Money questions → Go live.
  - The owner then lands on **their own dashboard**. The owner role is granted automatically, and the old
    business switcher and "create new business" option are gone.
  - **Brain side** (`services/brain/src/accounts/index.ts`):
    - scrypt password hashes and bearer sessions (7 days);
    - a gate on `/intake/*`, `/spec/*`, `/questions/*`, `/owner/*`, `/compile*`, so an account can only touch
      its own business;
    - rate-limited login.
  - **Owner app:** `apps/owner/app/providers.tsx` (the gate), `src/data/account.tsx`,
    `src/components/onboarding.tsx` and `src/components/landing/Landing.tsx`.
  - **Verified locally:** "Sam's Tacos" went from a typed description through the interview and compile to a
    live dashboard with only its own data.
- **Interview fixes, also in `d74e223`:**
  - Stock units must be whole numbers.
  - Confirmed facts that the compiler would refuse get re-asked.
  - Variant costs must agree per unit of shared stock (for example, 3 tacos at $1.20 must cost $3.60).
  - Stale stored specs get their questions regenerated on read.

  Before these fixes the build could stall with nothing left to answer.

**Tests:** the brain has 188 passing (`pnpm --filter @napkin/brain test`). Typecheck is clean for the brain and
the owner app. Run `pnpm test` and `pnpm typecheck` for everything.

## 4. What is deployed (the hosted demo)

| Piece | Where |
|---|---|
| Owner app | https://napkin-owner.vercel.app (Vercel team `power-of-love`, project `prj_Ix1DAhcegnD5Cu3dq1bRkseJG0VJ`) |
| Storefront | https://napkin-store.vercel.app (project `prj_A1WVgYTDOQqYuPv7rJIOJhxefo2R`); Maya's shop is at `/maya-cookies`, and phone orders are paid at `/pay` |
| Database | SpacetimeDB **maincloud**, database `napkin-inc-mayas` |
| Brain | **runs on the owner's Mac**, exposed by a Cloudflare quick tunnel: `https://conservative-independent-nat-traditional.trycloudflare.com` (as of this writing) |
| Phone | Cartesia number **+1 906-498-9806** (id `ap_KugXKLtEEEvLtNcN58QoEz`), agent `agent_pPr1iGCEp3DS5YX4G9GTYB`, model `claude-haiku-5.5`, voice Skylar `db6b0ed5-d5d3-463d-ae85-518a07d3c2b4` |
| Stripe | test sandbox "Erketoys". Test card `4242 4242 4242 4242`. |
| SMS | simulator only. Twilio was skipped because the trial balance was $0, so the phone agent reads the order number aloud and the caller pays at `napkin-store.vercel.app/pay`. |

**Logins:**
- **Maya's demo account:** email `maya@mayascookies.test`. The password is in `.env` as
  `MAYA_ACCOUNT_PASSWORD`; never paste it into chat or commits. The brain seeds this account on start if
  it's missing.
- **Phone owner mode** needs `OWNER_PHONE` and `OWNER_PIN` in `.env`. `OWNER_PHONE` is still empty, so phone
  owner mode is off.

**Gitignored state that must not be lost:** `services/brain/.data-cloud/` holds the brain's maincloud
identity (the owner of `napkin-inc-mayas`), the accounts, sessions and phone orders. Without it the hosted
brain can't write to its own database. `services/brain/.data/` is the same for local development.

### The processes that must be running for the hosted demo

All of them run on the owner's Mac, from the repo root.

```bash
caffeinate -dimsu -t 36000                       # keep the Mac awake (lid open, on AC power)
~/.local/bin/cloudflared tunnel --no-autoupdate --url http://localhost:4000   # prints the https tunnel URL
BRAIN_PUBLIC_URL=<tunnel url> scripts/brain-cloud.sh                          # brain on :4000 against maincloud
K=$(grep -E '^STRIPE_SECRET_KEY=' .env | cut -d= -f2- | tr -d "\"'"); ~/.local/bin/stripe listen --api-key "$K" \
  --events checkout.session.completed,checkout.session.async_payment_succeeded,charge.succeeded,charge.updated,charge.refunded,refund.created,refund.updated \
  --forward-to localhost:4000/webhooks/stripe                                 # webhooks; secret already in .env
```

Check health: `curl -s <tunnel url>/health`. You want `"ok":true`, `bootstrap.ok`, and `stripe.mode` `test`.

**If the tunnel restarts, its URL changes.** Then do all three of these:
1. Restart the brain with the new `BRAIN_PUBLIC_URL`.
2. Redeploy both apps, because the URL is baked in at build time:
   `BRAIN_PUBLIC_URL=<new url> scripts/deploy-web.sh both`
3. Point the Cartesia agent's tools at the new URL:
   ```bash
   pnpm --filter @napkin/brain exec tsx --env-file-if-exists=../../.env scripts/cartesia-setup.ts <new url> \
     --model claude-haiku-5.5 --voice db6b0ed5-d5d3-463d-ae85-518a07d3c2b4 --phone-number-id ap_KugXKLtEEEvLtNcN58QoEz
   ```
   Try `--dry-run` first. Cartesia fixes the temperature for this model, so the script must not send one.

A named Cloudflare tunnel (stable URL) would remove this chore; that's worth doing if there is time.

Vercel deploys use the Vercel CLI, which is already logged in on the Mac. `deploy-web.sh` sets
`VERCEL_ORG_ID`/`VERCEL_PROJECT_ID` itself.

### Local development (everything on the Mac)

```bash
pnpm stdb                                   # local SpacetimeDB on 127.0.0.1:3000
pnpm publish:local && pnpm bootstrap        # publish the module to local DB `napkin`, load Maya
pnpm --filter @napkin/brain start           # :4000
pnpm --filter @napkin/owner dev             # :3001
pnpm --filter @napkin/store dev             # :3002
```

Only one `next dev` per app directory can run at a time.

## 5. What is left, in priority order

1. **The owner's own live test.** Nobody has signed up on the *live* site yet. The previous agent doesn't type
   passwords into public sites, so this is the owner's job.
   - Create a fresh account on https://napkin-owner.vercel.app, upload a napkin photo, answer the questions,
     and go live.
   - Separately, sign in as Maya.
   - Fix whatever breaks.
2. **Demo script for judges** (`docs/DEMO.md` covers only M1/M2 locally).
   - A 3–4 minute path where the judge is the input:
     1. The judge sketches or says a business.
     2. It goes live in about 30 s of machine time; the interview is the human part, about 30 questions for
        a rich napkin, and fewer when it's simple.
     3. The judge scans the QR code and pays with a test card.
     4. The judge calls +1 906-498-9806 and orders by voice.
     5. The judge tries to talk an AI staffer into a refund it shouldn't give, and the guards refuse.
   - Add the red-team table as the closer.
   - Consider a faster path for the demo, such as a short pre-written napkin, so the interview stays short.
3. **Devpost write-up:** problem, what it does, how it's built (sponsors as plumbing: Anthropic, Cartesia,
   Stripe, SpacetimeDB, Vercel), challenges, what's next, plus a short video if possible. Ask the owner
   before making the repo public (rule 5).
4. **Known gaps (not done; decide whether they matter for the demo):**
   - The storefront home page (`napkin-store.vercel.app/`) lists **every** business, including test ones.
     Consider hiding unlisted or test businesses.
   - The agent chat routes `/agents/:role/message` and `/ask` have no sign-in and aren't scoped to an
     account.
   - After going live, the Build page could link straight to the dashboard and the storefront.
   - The phone line is wired to `maya-cookies` only (`PHONE_BUSINESS_ID`). New businesses have no phone line.
   - `OWNER_PHONE` is empty, so phone owner mode is off.
   - The brain runs on a laptop behind a quick tunnel; see section 4. Keep the Mac awake and online during
     judging.
   - `docs/REAL_VS_SIMULATED.md` and `docs/MORNING.md` don't mention the accounts work yet.
   - The decisions saved in `docs/MORNING.md` are still open, with defaults in place.
5. **Optional polish:** a stable tunnel, storefront theme carry-over on recompile, and asking for per-role
   refund limits in the interview.

## 6. Gotchas the previous agent hit

- **Percent fields:** `marginFloorPct` and `maxDiscountPct` are percent *points* ("20" = 20%). `taxRate` is a
  *fraction* ("0.0725"). A bare 0.2 for a points field is refused with a request to add a % sign.
- **Every role needs an identity:** a new business needs actor identities (storefront, shopkeeper, support,
  bookkeeper) before it can take orders. `grantActors()` in `services/brain/src/bootstrap.ts` runs after
  every activation.
- **Opus 5.5 rejects forced tool calls.** Intake uses auto tool choice plus zod validation instead.
- **Money questions keep exact template wording.** The LLM may only rephrase non-money questions.
- **Cartesia:** `temperature` must be omitted for `claude-haiku-5.5`.
- **Stripe:** `stripe listen` needs an explicit `--events` list. The product ids are `cookie_single`,
  `box-of-6` and `sea-salt`.
- **SpacetimeDB:** only one copy of `spacetimedb` (2.13.0) may be installed. In the module, use `ctx.random`
  and never `Math.random`.
- **The previous agent's shell and background processes die with its session.** After switching accounts,
  check that the brain, tunnel and `stripe listen` are still up (`curl <tunnel>/health`), and restart them per
  section 4 if not.

## 7. Moving to another account or machine

- **Same Mac, different Claude account (the simple case):** everything stays on disk: the repo, `.env`,
  `.data-cloud/`, the Vercel, Stripe and cloudflared CLI logins, and `~/.local/bin`. Open
  `/Users/vinci/napkin-inc` in the new session and paste the prompt in `docs/HANDOFF_PROMPT.md`.
- **Different machine:** clone `vincivv/napkin-inc`, which needs access to the private repo. Then copy these
  three things over **privately** (AirDrop or USB, never chat, email or git):
  - `.env`
  - `services/brain/.data-cloud/`
  - `services/brain/.data/`

  Then install the tools: Node 24, pnpm 10, the `spacetime` 2.13 CLI, the Vercel CLI (logged in to team
  `power-of-love`), the Stripe CLI and cloudflared. Run `pnpm install`.
