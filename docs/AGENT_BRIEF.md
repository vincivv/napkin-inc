# Brief for build agents (read this first)

You are one of several agents building **Napkin Inc.** in parallel at Cal Hacks 13 (solo hacker, ~36h).
Read `docs/PLAN.md` for the whole system. This brief has the rules every agent must follow.

## Principles (non-negotiable)
1. **The AI talks and judges; deterministic code owns the money and the rules.** If the LLM were swapped, every money guarantee must still hold.
2. **Never assume.** If something is ambiguous, or a library's docs disagree with this brief, STOP and put the question in your final report instead of guessing. Never invent business facts (prices, costs, stock, locations) — Maya's costs and stock in `fixtures/maya/configuration.json` are flagged placeholders (see its `_unconfirmed` block); treat them as placeholders in any UI copy too.
3. **Stripe is TEST MODE only.** Refuse to start if `STRIPE_SECRET_KEY` starts with `sk_live`/`rk_live`. Never print or commit secrets. `.env` lives at the repo root and is gitignored. The Stripe key is NOT available yet; build so the code runs without it (clearly labeled dev simulator path) and switches to real test checkout when the key appears.

## Frozen contracts (do not change without saying so in your report)
- `packages/ledger-core` — exact rationals (`Rational`), posting DSL (`parse/evaluate/print`), `post()` engine, invariant predicates. Money in the DSL = exact rational dollars; ledger = integer cents (`bigint`). `round2(x) = floor(100x + 1/2)/100`.
- `packages/schema` — zod contracts: `Configuration`, `BusinessSpec`, `Fact`, `DecisionRecord`, `ProofReport`, `checkConfigurationSemantics()`.
- `platform/src/schema.ts` (tables) and the **reducer signatures** in `platform/src/index.ts`.
- `packages/stdb-bindings` — generated TypeScript client bindings (`pnpm --filter @napkin/platform generate`). Only the platform agent regenerates them.
- `fixtures/maya/configuration.json` — the M1 hand-written Configuration.

If you truly need a contract change (a new reducer, a new column), make the smallest change, list it under "Contract changes" in your report, and explain why.

## Environment
- macOS, Node 24, pnpm 10 (`~/.local/bin` is on PATH), TypeScript 7, vitest 5, fast-check 4.
- Ports: SpacetimeDB 3000 (already running locally: `spacetime` CLI 2.13.0, server `local`), owner app 3001, store 3002, brain 4000.
- SpacetimeDB local DB names: `napkin` is owned by the platform agent. Any other agent that needs its own scratch database must use `napkin-<your-agent-letter>`.
- Package versions are pinned in each package.json; exactly ONE copy of `spacetimedb` (2.13.0) may exist (SpacetimeDB issue #5740). Prefer not to add dependencies; if you must, add them only to your own package.
- SpacetimeDB TypeScript module rules: see `platform/` and https://spacetimedb.com/docs (no `Math.random` — use `ctx.random`; `u64/i64` are `bigint`; reducers are one transaction, `throw new SenderError(...)` rolls back).
- Models (Anthropic API): `claude-opus-5-5` (intake/interview/compiler), `claude-sonnet-5-5` (AI staff), `claude-haiku-5-5` (classification).

## How to work
- You are in your own git worktree on your own branch. Run `pnpm install` first. Commit your work on your branch with clear messages, ending each commit message with:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  Do NOT push, do NOT merge into main, do NOT touch other agents' directories.
- Deterministic code gets unit + property tests (fast-check). Every invariant you enforce gets a test.
- Keep a `README.md` in your component: what it does, what is AI vs deterministic, how to run it.
- Prefer simple, reliable solutions for UI and plumbing.
- Final report (your last message): branch name, what works (with the commands you ran and their results), what is real vs simulated, contract changes, open questions, anything you could not finish.
