# Demo paths

## M2: napkin to running configuration (merged Sat 2026-10-24, ~6 AM)
Same servers as M1. You need `OWNER_PIN` set in `.env` before the activate step.
1. In the owner app (http://localhost:3001), open **Intake**. Upload a photo of the napkin (or `fixtures/maya/napkin.SYNTHETIC.png`) and/or record your voice.
   - Claude Opus 5.5 reads the photo. Every value shows its quote and the place on the image it came from.
   - Cartesia transcribes the voice. Values you said are marked "owner said".
2. Open **Interview**. Questions are ordered by money impact. Money questions use exact, fixed wording; the AI only rephrases the others.
3. Open **Build** and press compile. Progress streams step by step: checks, Z3 proofs, a dry run, then configuration vN pending.
   - Compiling is refused while any money fact is unconfirmed, and the page lists each one.
4. Sign in with your PIN, review the diff and the proof report, then press **Activate**. The storefront picks up the new prices live.

## M1: hand-written Maya's Cookies, end to end (verified Sat 2026-10-24, 2 AM)

### Start everything (4 terminals, from the repo root)
```bash
pnpm stdb                                   # SpacetimeDB on 127.0.0.1:3000 (skip if already running)
pnpm publish:local && pnpm bootstrap        # publish the platform module, load Maya + baseline (idempotent)
pnpm --filter @napkin/brain start           # brain on :4000 (prints DEV SIMULATOR banner without a Stripe key)
pnpm --filter @napkin/store dev             # storefront on :3002
pnpm --filter @napkin/owner dev             # owner app on :3001
```
Check: `curl localhost:4000/health` → `"ok":true`, both businesses `registered`, stripe mode `simulator` (or `test` once a key is set).

### Click-through
1. Open the owner app at http://localhost:3001 next to the storefront. The banner reads **"Books balance: debits = credits ✓"**.
2. Open the store at http://localhost:3002/maya-cookies (phone width looks best). It shows the live stock count, e.g. "42 left".
3. Add **Box of 6**, then **Sea-salt topping (+$1)**. Enter a first name and press **Checkout**.
4. The order page shows "Almost there". Without a Stripe key it also shows the **DEV SIMULATOR** box: press **Simulate test payment**. With a key you get the real Stripe test checkout instead; pay with card `4242 4242 4242 4242`.
5. The order page flips to **"Thank you … Your order is paid"** by itself, and the owner dashboard updates live:
   - orders +1
   - net sales +$16.00
   - Stripe clearing +$16.00 minus the fee
   - stock −6
   - books still balanced
6. In the owner app, open **Documents** to see the sale, the payment received and the processor fee. Each one lists its journal lines and register movements. **Reports → Trial balance** sums to zero.
7. Try to break it:
   - **Oversell:** order 20 boxes. The platform refuses with `invariant 3 (stock): not enough stock …`.
   - **Replay a payment:** press "Simulate test payment" again, or `curl -X POST localhost:4000/dev/simulate-payment/<orderId>` twice. Nothing changes; the processor event id is de-duplicated.
   - **Over-discount:** a 25% discount is refused by the platform (`invariant 4`). The UI doesn't offer it; the platform tests cover it.
8. QR codes are at http://localhost:3002/maya-cookies/qr. For real phones, set `NEXT_PUBLIC_STORE_URL` to a public or LAN URL (D3: Cloudflare tunnel).

### Verified on Sat 2026-10-24
- **Checkout through the UI:** order `MC-NV9F7` for $16.00, then simulated payment, then the page flipped to paid live.
- **Owner dashboard:** debits = credits = $113.92 (opening stock plus 2 sales, 2 payments and 2 fees); Stripe clearing $30.48 = $32.00 − $1.52 fees; stock 48 → 36.
- **Database checks:** a replayed payment left exactly 2 processor events; selling 20 boxes was refused.
- **Tests:** `pnpm -r test` → 123 passing:

  | Package | Tests |
  |---|---|
  | ledger-core | 25 |
  | schema | 7 |
  | platform | 34 |
  | brain | 22 |
  | store | 8 |
  | redteam | 25 |
