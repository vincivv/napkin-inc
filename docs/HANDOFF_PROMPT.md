# Onboarding prompt for the new Claude session

Open a new Claude Code session in `/Users/vinci/napkin-inc` on this Mac, then paste everything below the
line as the first message.

---

You're taking over **Napkin Inc.**, my solo Cal Hacks 13.0 project. Another Claude session built all of it,
and I've switched accounts, so you start with no memory of that work. The Devpost deadline is **Sun Oct 25,
9:00 AM PT**, and judging (a live demo) is 10:30 AM–12:30 PM.

**Step 1: get the full context before you do anything.** Read these completely, not skimmed:
1. `docs/HANDOFF.md`: everything the previous session knew. That's the goal, the rules, the product,
   architecture, every component, what's deployed and where, how to run and restart it, the history, what
   it was doing last, what's left and the gotchas. This is the main document.
2. `docs/AGENT_BRIEF.md`, `docs/INVARIANTS.md` and `docs/PLAN.md`.
3. `docs/MORNING.md` (overnight log and the decisions saved for me) and `redteam/RESULTS.md`.
4. `git log --oneline | head -40`, then look around the code that HANDOFF points to, enough to be confident
   in it: `services/brain/src`, `apps/owner`, `apps/store`, `platform/src`.

Take your time. A thorough start matters more than a fast one.

**Step 2: check the live demo is up.**

```bash
curl -s https://conservative-independent-nat-traditional.trycloudflare.com/health
```

If it's down, or the tunnel URL changed, bring it back using HANDOFF section 7. That includes redeploying
both Vercel apps and re-pointing the Cartesia phone agent when the URL changes.

**Step 3: report back to me** in a few plain lines:
- what state the demo is in;
- anything in the docs that didn't match the code;
- your plan for HANDOFF section 10: my live sign-up test first, then the judges' demo script, then the
  Devpost write-up, then the gaps worth closing.

**Rules I care about:**
- Secrets stay in `.env`. Never print, log or commit them; read them inside commands only.
- Stripe is test mode only.
- Never invent business facts (prices, costs, stock). Ask me.
- Don't touch the local `napkin` database for experiments; use a scratch one. Be careful with the live
  maincloud database `napkin-inc-mayas`.
- Back up `services/brain/.data-cloud/` before anything risky. It holds the hosted brain's identities.
- Ask me before making the repo public.
- End commit messages with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

**Permissions:**
- You have my full permission to create, change, deploy and commit what the project needs: GitHub, Vercel,
  Stripe test mode, Cartesia, the browser.
- You can use subagents for parallel work. Pick each one's model by difficulty: Opus for
  correctness-critical work, Sonnet for plumbing and UI, Haiku for chores. Run at most 3 at once; more than
  that hit rate limits.

**How I like to work:** talk to me in plain, short language, outcome first, with concrete steps I can click
or run. I type fast and make typos; figure out what I mean.
