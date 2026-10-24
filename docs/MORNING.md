# For you when you wake up

Claude keeps this updated overnight. Newest items at the bottom of each list.

## Things only you can do
1. **`OWNER_PIN` in `.env`** (any 4–6 digits). It's empty, so owner sign-in refuses everyone, and only the owner can activate a compiled configuration (M2).
2. **Maya's real numbers:** ingredient cost per cookie, per box of 6 and for the sea salt; starting stock; pickup location; hours. These are flagged placeholders today ($0.80 / $4.80 / $0.20, 48 cookies, "TBD"). You can also answer them live in the M2 Interview screen.
3. **Stripe test key:** put an `sk_test_...` key in `.env`, then run `~/.local/bin/stripe login` once. Claude then runs `stripe listen` to get `STRIPE_WEBHOOK_SECRET`, and payments switch from the simulator to real test-card checkout.
4. **For M3, the phone line:** a Twilio trial account (SID, auth token, number) with your phone verified; `OWNER_PHONE`; a Cartesia Managed Agent number (Cartesia dashboard). Also a photo of a real napkin with Maya's menu drawn on it.
5. **Optional:** run `sudo xcodebuild -license accept` so Homebrew works again.

## Decisions saved for you (work continues with the noted default)
- **Sea salt: tracked stock or a supply expense?** Its $0.20 cost currently comes out of Inventory, but sea salt has no stock item, so inventory value drifts by $0.20 per topping sold. Default for now: unchanged, and flagged in docs/REAL_VS_SIMULATED.md.

## Overnight log
- **05:00:** limits reset. Resumed the prover, M2 intake/questions and M2 compiler/guards. Mac kept awake with `caffeinate` (needs AC power and the lid **open**; a closed lid still sleeps). A watchdog runs every ~20 min to resume agents after limits, merge finished work, and move on through the plan.
