# For you when you wake up

Claude keeps this updated overnight. Newest items at the bottom of each list.

## Things only you can do
1. **`OWNER_PIN` in `.env`** (any 4–6 digits). It's empty, so owner sign-in refuses everyone, and only the owner can activate a compiled configuration (M2).
2. **Maya's real numbers:** ingredient cost per cookie, per box of 6 and for the sea salt; starting stock; pickup location; hours. These are flagged placeholders today ($0.80 / $4.80 / $0.20, 48 cookies, "TBD"). You can also answer them live in the M2 Interview screen.
3. **Stripe test key:** put an `sk_test_...` key in `.env`, then run `~/.local/bin/stripe login` once. Claude then runs `stripe listen` to get `STRIPE_WEBHOOK_SECRET`, and payments switch from the simulator to real test-card checkout.
4. **For M3, the phone line:** a Twilio trial account (SID, auth token, number) with your phone verified; `OWNER_PHONE`; a Cartesia Managed Agent number (Cartesia dashboard). Also a photo of a real napkin with Maya's menu drawn on it.
5. **Optional:** run `sudo xcodebuild -license accept` so Homebrew works again.
6. **Nothing needed for Anthropic.** Your key isn't scoped to a workspace, so every call needs a workspace ID. I found yours in the console (Default workspace) and set `ANTHROPIC_WORKSPACE_ID` in `.env`. If you'd rather not, make a workspace-scoped key in the console and drop it in.

## Decisions saved for you (work continues with the noted default)
- **Sea salt: tracked stock or a supply expense?** Its $0.20 cost currently comes out of Inventory, but sea salt has no stock item, so inventory value drifts by $0.20 per topping sold. Default for now: unchanged, and flagged in docs/REAL_VS_SIMULATED.md.
- **Payouts:** the bookkeeper can no longer create a `payout` by hand. Payouts now only come from processor events. Should a manual bank transfer get its own document type? Default for now: no.
- **Tax rates with 5 decimals** (e.g. 8.875%) are refused. Rates allow at most 4 decimals, matching the prover. Default for now: unchanged; raising the limit is a one-line change on both sides.
- **Refund, then reverse the sale:** the books still balance, but the refund shows up twice (Refunds 4200 and a credit in Receivables 1200). Do returned goods need their own document? Default for now: allowed, pinned by a test.
- **Paid order whose sale couldn't post (sold out mid-checkout):** it can't be refunded through the normal path yet. It goes to the inbox for you. Default for now: inbox only.

## Overnight log
- **05:00:** limits reset. Resumed the prover, M2 intake/questions and M2 compiler/guards. Mac kept awake with `caffeinate` (needs AC power and the lid **open**; a closed lid still sleeps). A watchdog runs every ~20 min to resume agents after limits, merge finished work, and move on through the plan.
- **05:2x:** merged the **Z3 prover**. Maya's full configuration proves in 0.75 s: all 7 document types balance, the discount-stacking proof holds, and the flow check is clean. Breaking a rule gives a counterexample plus a verified fix. For example, removing the discount posting gives "1 cookie at 5% off, off by $0.15; debit line.discount to Discounts given (4100)". Posting-rule synthesis recovers the rules from examples, and when they're ambiguous it asks one question ("should revenue be $15.00 or $13.50?"). 137 tests pass on main.
  - Prover notes for later: proofs are bounded (1–3 lines, qty ≤ 10,000) and rates are proven at 0.01% steps. The "max safe discount 58.4%" figure comes from placeholder costs, so don't quote it as Maya's real number.
- **05:4x:** merged **M2 intake** (photo + voice + the question engine, plus the owner app's Intake and Interview screens) and pushed it.
  - **Real API run:** Claude Opus 5.5 vision on the synthetic napkin and Cartesia STT on a recorded voice clip.
    - **Photo:** 7 fields read from the paper. Each has its quote and image region (name, $3 single, $15 box of 6, +$1 sea salt). "Single" is marked *inferred* because the paper doesn't say it. The model also flagged "is sea salt per cookie or per box?" on its own.
    - **Voice:** the transcript was right, and $3 / $15 / "never more than 20% off" came back as *owner_said*.
    - Nothing is money-ready until you confirm it.
  - **Two fixes the real run forced:**
    - **Forced tool calls:** Opus 5.5 rejects them, so calls now use auto + instruction + zod validation. Structured outputs can't take a schema this big.
    - **Money-question wording:** Haiku rephrased "cost for the sea-salt add-on" as "cost of a batch". Money questions now always use the exact template wording. Test added.
  - **Tests:** 166 passing.
- **05:5x:** merged **platform hardening** (5 fixes). One was a real bug: refund id `sim_re_1` matched outbox item `sim_re_12`. 172 tests pass. Republished locally, and the M1 money path still works: checkout MC-FMKYH, paid $6.00, a double payment was a no-op with 1 payment event + 1 fee event.
