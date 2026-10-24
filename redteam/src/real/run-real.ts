// The real red-team runner:  pnpm --filter @napkin/redteam run:real [--only attacks,chaos,planted]
//
// Runs against the local SpacetimeDB server (127.0.0.1:3000) on the scratch database napkin-l ONLY
// (never `napkin`, which runs the live demo), re-published clean for every row.
//
//   chaos     11 cases x 2 modes through the brain's payment code (DEV SIMULATOR); Stripe-only cases skipped
//   planted   the deterministic reference auditor over both planted book sets, plus the Bookkeeper agent's audit
//             (harness.audit) in both modes when the harness is present
//   attacks   webhook-channel attacks run for real (no agent needed); chat, order-note and web-page attacks run
//             through the live AI staff (services/brain/src/agents/harness.ts, loaded by dynamic import) when it
//             exists and ANTHROPIC_API_KEY is set; otherwise they are "not run". Phone attacks are not run (see classify.ts).
//
// Writes redteam/out/run-<timestamp>.json (gitignored) and regenerates redteam/RESULTS.md from real rows only.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAttacks, loadChaos, loadPlanted, REDTEAM_ROOT } from "../load";
import { measureAttack } from "../measure";
import { assertRunRoutable, renderResults, writeResults } from "../results";
import { attackSetHash, MODES } from "../run";
import { scorePlanted } from "../score";
import { RunFile, type RunResult } from "../types";
import { auditBooks, policiesFromConfig } from "./auditor";
import { RealChaosDriver } from "./chaos";
import { classifyAttack, HARNESS_MISSING, notRunRow, turnsFor } from "./classify";
import { loadLiveAgents, type LiveAgents } from "./agents";
import { buildBundle, SCRATCH_DB, ScratchWorld, STDB_URI } from "./db";
import { RealInspector, SetupUnsupported, unsupportedSetup } from "./inspector";
import { newWebhookSecret } from "./stripe-events";
import { deliverAttackWebhook } from "./webhook-channel";
import { FIXTURE_PATH } from "./brain";

type Section = "attacks" | "chaos" | "planted";

function gitCommit(): string {
  try {
    const root = join(REDTEAM_ROOT, "..");
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() && !l.endsWith("redteam/RESULTS.md")).length > 0;
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown";
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function main(argv = process.argv.slice(2)): Promise<string> {
  const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined);
  const sections = new Set<Section>((onlyArg ? onlyArg.split(",") : ["attacks", "chaos", "planted"]) as Section[]);
  const commit = gitCommit();
  const ranAt = new Date().toISOString();
  buildBundle();

  const world = new ScratchWorld();
  const results: RunResult[] = [];
  const traces: Record<string, unknown> = {};
  const notes: string[] = [];
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const inspector = new RealInspector(world);
  const { agents, why: harnessWhy } = await loadLiveAgents(world, inspector);
  const harness: LiveAgents | undefined = agents;
  log(`agents: ${agents ? `loaded (${agents.model})` : harnessWhy}`);
  let agentRowsRan = 0;

  try {
    // ---------- chaos ----------
    if (sections.has("chaos")) {
      const driver = new RealChaosDriver(world);
      for (const c of loadChaos().sort((a, b) => (a.id < b.id ? -1 : 1))) {
        for (const mode of MODES) {
          const r = await driver.runCase(c, mode);
          if (r.skipped) {
            results.push(notRunRow("chaos", c.id, c.kind, mode, "skipped", r.skipped));
            log(`chaos ${c.id} ${mode}: SKIPPED`);
            continue;
          }
          results.push({ kind: "chaos", caseId: c.id, chaosKind: c.kind, mode, passed: r.passed, failures: r.failures, invariantIds: c.invariantIds });
          traces[`chaos:${c.id}:${mode}`] = r.trace;
          log(`chaos ${c.id} ${mode}: ${r.passed ? "pass" : `FAIL ${r.failures.join(" | ")}`}`);
        }
      }
    }

    // ---------- planted ----------
    if (sections.has("planted")) {
      const policies = policiesFromConfig(JSON.parse(readFileSync(FIXTURE_PATH, "utf8")));
      for (const { set } of loadPlanted()) {
        const findings = auditBooks(set, policies);
        const s = scorePlanted(set.answerKey, findings);
        results.push({ kind: "planted", setId: set.id, mode: "napkin", auditor: "reference_auditor", errors: s.errors, findings: s.findings, truePositives: s.truePositives, precision: s.precision, recall: s.recall, missed: s.missed });
        traces[`planted:${set.id}:reference_auditor`] = { findings, matches: s.matches };
        const unmatched = findings.filter((_, i) => !Object.values(s.matches).includes(i));
        for (const f of unmatched) notes.push(`reference auditor, ${set.id}: finding not in the answer key: ${f.kind} on ${f.entries.join(", ")} (${f.note ?? ""})`);
        log(`planted ${set.id} reference_auditor: precision ${s.precision.toFixed(3)} recall ${s.recall.toFixed(3)}`);
        for (const mode of MODES) {
          if (!agents) {
            results.push(notRunRow("planted", set.id, "bookkeeper_agent", mode, "not_run", harnessWhy ?? HARNESS_MISSING));
            continue;
          }
          try {
            await world.reset();
            const a = await agents.make().audit({ id: set.id, documents: set.documents, periods: set.periods, processorStatement: set.processorStatement }, mode);
            agentRowsRan++;
            if (a.error) {
              results.push(notRunRow("planted", set.id, "bookkeeper_agent", mode, "not_run", `not run: audit error: ${a.error}`));
              log(`planted ${set.id} bookkeeper_agent ${mode}: ERROR ${a.error}`);
              continue;
            }
            const sc = scorePlanted(set.answerKey, a.findings);
            results.push({ kind: "planted", setId: set.id, mode, auditor: "bookkeeper_agent", errors: sc.errors, findings: sc.findings, truePositives: sc.truePositives, precision: sc.precision, recall: sc.recall, missed: sc.missed });
            traces[`planted:${set.id}:bookkeeper_agent:${mode}`] = { findings: a.findings, matches: sc.matches, reply: a.reply, toolCalls: a.toolCalls };
            log(`planted ${set.id} bookkeeper_agent ${mode}: precision ${sc.precision.toFixed(3)} recall ${sc.recall.toFixed(3)}`);
          } catch (e) {
            results.push(notRunRow("planted", set.id, "bookkeeper_agent", mode, "not_run", `not run: run error: ${errMsg(e)}`));
          }
        }
      }
      notes.push("The reference auditor reads only the planted books, the processor statement and the configuration's policies and approval rules; it never reads the answer key. It runs on the book JSON, not on the platform (the planted books contain errors the platform refuses to post).");
    }

    // ---------- attacks ----------
    if (sections.has("attacks")) {
      const secret = newWebhookSecret();
      for (const a of loadAttacks().sort((x, y) => (x.id < y.id ? -1 : 1))) {
        const route = classifyAttack(a, { harnessAvailable: !!harness, setupProblems: unsupportedSetup(a) });
        for (const mode of MODES) {
          if (route.route === "not_run") {
            results.push(notRunRow("attack", a.id, a.category, mode, route.status, route.reason));
            continue;
          }
          try {
            if (route.route === "platform") {
              await inspector.prepare(a, mode);
              const before = await inspector.snapshot(mode);
              const transcript = await deliverAttackWebhook(world, a, mode, secret);
              const after = await inspector.snapshot(mode);
              const r = measureAttack(a, mode, before, after, transcript);
              results.push(r);
              traces[`attack:${a.id}:${mode}`] = { transcript, notes: inspector.notes };
              log(`attack ${a.id} ${mode}: ${r.breached ? `BREACH ${r.breachCodes.join(",")}` : "held"} (${r.observed})`);
            } else {
              await inspector.prepare(a, mode);
              const before = await inspector.snapshot(mode);
              const transcript = await agents!.make().send(a.target, turnsFor(a), mode);
              agentRowsRan++;
              const after = await inspector.snapshot(mode);
              traces[`attack:${a.id}:${mode}`] = { transcript, notes: inspector.notes };
              if (transcript.error && !transcript.turns.some((t) => t.role === "agent")) {
                // the agent never answered (API or platform error): nothing was measured
                results.push(notRunRow("attack", a.id, a.category, mode, "not_run", `not run: agent error before any reply: ${transcript.error}`));
                log(`attack ${a.id} ${mode}: ERROR ${transcript.error}`);
                continue;
              }
              const r = measureAttack(a, mode, before, after, transcript);
              results.push(r);
              log(`attack ${a.id} ${mode}: ${r.breached ? `BREACH ${r.breachCodes.join(",")}` : "held"} (${r.observed}, expected ${r.expected}${r.behaviorOk ? "" : ", behaviour NOT ok"})`);
            }
          } catch (e) {
            const reason = e instanceof SetupUnsupported ? `not run: setup unsupported: ${e.message}` : `not run: run error: ${errMsg(e)}`;
            results.push(notRunRow("attack", a.id, a.category, mode, "not_run", reason));
            log(`attack ${a.id} ${mode}: ${reason}`);
          }
        }
      }
    }
  } finally {
    world.close();
  }

  const attacks = loadAttacks();
  const ranLlm = agentRowsRan > 0;
  const run: RunFile = RunFile.parse({
    schema: "napkin-redteam-run/1",
    fake: false,
    label: `real run (${[...sections].sort().join(", ")})`,
    model: ranLlm
      ? `${harness!.model} (AI staff: Shopkeeper, Support, Bookkeeper; napkin = real Guard, baseline = BaselineGuard). Chaos, webhook attacks and the reference auditor use no LLM`
      : "none: no LLM ran (platform, brain payment code and the deterministic reference auditor only)",
    ranAt,
    attackSetHash: attackSetHash(attacks),
    gitCommit: commit,
    environment: [
      `Platform: SpacetimeDB 2.13.0 local server (${STDB_URI}), scratch database ${SCRATCH_DB}, re-published clean (clear-on-publish) and bootstrapped with the brain's bootstrap before every row`,
      "Businesses: maya-cookies (napkin mode, enforce=true) and maya-cookies-baseline (baseline mode, enforce=false), M1 fixture configuration (placeholder costs and stock)",
      "Payments: the brain's DEV SIMULATOR (no Stripe key); webhooks are Stripe-shaped events signed with a locally generated secret and verified by the brain's verifyStripeEvent",
      "Faults: injected at the processor-gateway boundary (timeouts, crashes); a brain restart drops all connections and in-memory state and reconnects with the same identities",
    ],
    notes,
    results,
  });

  const outDir = join(REDTEAM_ROOT, "out");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `run-${ranAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(jsonPath, JSON.stringify({ ...run, traces }, null, 2) + "\n");
  // Only a full run regenerates redteam/RESULTS.md; a partial (--only) run writes out/RESULTS.partial.md.
  const full = (["attacks", "chaos", "planted"] as const).every((x) => sections.has(x));
  let md: string;
  if (full) {
    md = writeResults(run);
  } else {
    assertRunRoutable(run);
    md = join(outDir, "RESULTS.partial.md");
    writeFileSync(md, renderResults(run));
  }
  log(`wrote ${jsonPath}`);
  log(`wrote ${md}`);
  return md;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then(() => process.exit(0))
    .catch((e: unknown) => {
      console.error(errMsg(e));
      process.exit(1);
    });
}
