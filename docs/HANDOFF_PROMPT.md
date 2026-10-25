# Prompt to paste into the new Claude session

Open the new session in `/Users/vinci/napkin-inc`, then paste everything below the line.

---

You're taking over **Napkin Inc.**, my solo Cal Hacks 13.0 project. The Devpost deadline is **Sun Oct 25,
9:00 AM PT**, and judging (a live demo) runs 10:30 AM–12:30 PM. Another Claude session built it; I've
switched accounts.

Before doing anything else, read these in order:
1. `docs/HANDOFF.md`: the goal, what's built, what's deployed, the processes that must be running, what's
   left, and the gotchas.
2. `docs/AGENT_BRIEF.md`: the rules.
3. `docs/PLAN.md`: the architecture. Skim it.

The open decisions saved for me are in `docs/MORNING.md`.

Rules I care about:
- Secrets stay in `.env`; never print or commit them.
- Stripe is test mode only.
- Never invent business facts.
- Ask me before making the repo public.

You have my permission to create, deploy and commit what's needed, and to use subagents. Choose each
subagent's model by difficulty: Opus for correctness-critical work, Sonnet for plumbing and UI, Haiku for
chores. Run at most 3 at once. Be economical so we don't hit usage limits before the deadline, and do small
things yourself instead of spawning agents.

Start by checking that the hosted demo is up:

```bash
curl -s https://conservative-independent-nat-traditional.trycloudflare.com/health
```

If it's down, or the tunnel URL changed, restart things per HANDOFF section 4.

Then tell me in a few lines what state it's in. Propose the next steps from HANDOFF section 5: my live
sign-up test, then the demo script, then the Devpost write-up.
