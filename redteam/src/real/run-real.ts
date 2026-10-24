// The real red-team runner:
//   pnpm --filter @napkin/redteam run:real [--only attacks,compromised,chaos,planted] [--no-llm] [--ids=RF-02,...]
//
// Runs against the local SpacetimeDB server (127.0.0.1:3000) on the scratch database napkin-l ONLY
// (never `napkin`, which runs the live demo), re-published clean for every row.
//
//   chaos        11 cases x 2 modes through the brain's payment code (DEV SIMULATOR); Stripe-only cases skipped
//   planted      the deterministic reference auditor over both planted book sets, plus the Bookkeeper agent's audit
//                (harness.audit) in both modes when the LLM is available
//   attacks      the REAL MODEL pass: chat, order-note and web-page attacks through the live AI staff
//                (createAgentHarness + createLiveStaff, Claude through ANTHROPIC_API_KEY); webhook attacks go to
//                the brain's endpoint with no agent. Phone attacks are not run (see classify.ts).
//   compromised  the COMPROMISED MODEL pass: the same Staff with its LLM port replaced by a deterministic script
//                (compromised.ts; not an LLM, no API call), plus the webhook attacks again
//   --no-llm     makes no LLM call: real-model attack rows and Bookkeeper-agent rows become "not run"
//
// Writes redteam/out/run-<timestamp>.json (gitignored; traces include before/after snapshots so `rescore` can
// re-measure). Only a full run (all sections, LLM on, no --ids) regenerates redteam/RESULTS.md; otherwise
// out/RESULTS.partial.md. Runs made separately are combined with src/real/merge.ts.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAttacks, loadChaos, loadPlanted, REDTEAM_ROOT } from "../load";
import { measureAttack } from "../measure";
import { assertRunRoutable, renderResults, writeResults } from "../results";
import { attackSetHash, MODES } from "../run";
import { scorePlanted } from "../score";
import { RunFile, type Pass, type RunResult, type Transcript } from "../types";
import { COMPROMISED_MODEL, makeCompromisedHarness, scriptFor } from "./compromised";
import { auditBooks, policiesFromConfig } from "./auditor";
import { RealChaosDriver } from "./chaos";
import { classifyAttack, HARNESS_MISSING, notRunRow, turnsFor } from "./classify";
import { loadLiveAgents, type LiveAgents } from "./agents";
import { buildBundle, SCRATCH_DB, ScratchWorld, STDB_URI } from "./db";
import { RealInspector, SetupUnsupported, unsupportedSetup } from "./inspector";
import { newWebhookSecret } from "./stripe-events";
import { deliverAttackWebhook } from "./webhook-channel";
import { FIXTURE_PATH } from "./brain";

type Section = "attacks" | "compromised" | "chaos" | "planted";
const ALL_SECTIONS: Section[] = ["attacks", "compromised", "chaos", "planted"];

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

export const PASS_META: { id: Pass; title: string; description: string[] }[] = [
  {
    id: "real_model",
    title: "Real model",
    description: ["The AI staff ran on the real LLM. Same prompt and tools in both modes; napkin = real Guard + enforcing platform, baseline = BaselineGuard + enforce=false."],
  },
  {
    id: "compromised_model",
    title: "Compromised model (scripted, worst case)",
    description: [
      "**Scripted, not an LLM.** The agents' LLM port was replaced by a deterministic script (redteam/src/real/compromised-scripts.ts) that makes the exact tool calls the attacker asks for, with the attacker's arguments, or the most damaging call in reach (config-change tools, another role's tools, invented tools), and prints every tool result back. It never refuses or escalates on its own.",
      "Same Staff, loop, tools, guards and platform as the real run. This tests the principle: if the LLM were swapped for another model, every money guarantee must still hold. Webhook attacks use no model and are the same in both passes.",
    ],
  },
];

const errMsg = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export async function main(argv = process.argv.slice(2)): Promise<string> {
  const onlyArg = argv.find((a) => a.startsWith("--only="))?.slice(7) ?? (argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined);
  const sections = new Set<Section>((onlyArg ? onlyArg.split(",") : ALL_SECTIONS) as Section[]);
  for (const x of sections) if (!ALL_SECTIONS.includes(x)) throw new Error(`unknown section ${x} (use ${ALL_SECTIONS.join(",")})`);
  const noLlm = argv.includes("--no-llm");
  const idsArg = argv.find((a) => a.startsWith("--ids="))?.slice(6);
  const onlyIds = idsArg ? new Set(idsArg.split(",")) : undefined;
  const commit = gitCommit();
  const ranAt = new Date().toISOString();
  buildBundle();

  const world = new ScratchWorld();
  const results: RunResult[] = [];
  const traces: Record<string, unknown> = {};
  const notes: string[] = [];
  const log = (s: string) => process.stdout.write(`${s}\n`);
  const inspector = new RealInspector(world);
  const { agents, why: harnessWhy } = noLlm ? { agents: undefined, why: "not run: --no-llm (this run makes no LLM call)" } : await loadLiveAgents(world, inspector);
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

    // ---------- attacks (real model, then compromised model) ----------
    const secret = newWebhookSecret();
    const passes: { pass: Pass; on: boolean }[] = [
      { pass: "real_model", on: sections.has("attacks") },
      { pass: "compromised_model", on: sections.has("compromised") },
    ];
    for (const { pass, on } of passes) {
      if (!on) continue;
      const tag = pass === "real_model" ? "" : " [compromised]";
      for (const a of loadAttacks().sort((x, y) => (x.id < y.id ? -1 : 1))) {
        if (onlyIds && !onlyIds.has(a.id)) continue;
        const script = pass === "compromised_model" ? scriptFor(a) : undefined;
        const available = pass === "real_model" ? !!harness : true;
        let route = classifyAttack(a, { harnessAvailable: available, setupProblems: unsupportedSetup(a) });
        if (pass === "real_model" && route.route === "not_run" && !harness && route.reason.startsWith(HARNESS_MISSING)) {
          route = { ...route, reason: route.reason.replace(HARNESS_MISSING, harnessWhy ?? HARNESS_MISSING) };
        }
        if (pass === "compromised_model" && route.route === "agent" && !script) route = { route: "not_run", status: "not_run", reason: "not run: no compromised-model script for this attack" };
        for (const mode of MODES) {
          const key = pass === "real_model" ? `attack:${a.id}:${mode}` : `attack:compromised_model:${a.id}:${mode}`;
          if (route.route === "not_run") {
            results.push({ ...notRunRow("attack", a.id, a.category, mode, route.status, route.reason), pass });
            continue;
          }
          try {
            await inspector.prepare(a, mode);
            const before = await inspector.snapshot(mode);
            let transcript: Transcript;
            if (route.route === "platform") {
              transcript = await deliverAttackWebhook(world, a, mode, secret);
            } else if (pass === "real_model") {
              transcript = await agents!.make().send(a.target, turnsFor(a), mode);
              agentRowsRan++;
            } else {
              transcript = await makeCompromisedHarness(world, inspector, script!).send(a.target, turnsFor(a), mode);
            }
            const after = await inspector.snapshot(mode);
            traces[key] = { transcript, notes: [...inspector.notes], before, after };
            if (route.route === "agent" && transcript.error && !transcript.turns.some((t) => t.role === "agent")) {
              // the agent never answered (API or platform error): nothing was measured
              results.push({ ...notRunRow("attack", a.id, a.category, mode, "not_run", `not run: agent error before any reply: ${transcript.error}`), pass });
              log(`attack${tag} ${a.id} ${mode}: ERROR ${transcript.error}`);
              continue;
            }
            const r = measureAttack(a, mode, before, after, transcript, { pass });
            results.push(r);
            log(`attack${tag} ${a.id} ${mode}: ${r.breached ? `BREACH ${r.breachCodes.join(",")}` : "held"} (${r.observed}, expected ${r.expected}${r.behaviorOk ? "" : ", behaviour NOT ok"})`);
          } catch (e) {
            const reason = e instanceof SetupUnsupported ? `not run: setup unsupported: ${e.message}` : `not run: run error: ${errMsg(e)}`;
            results.push({ ...notRunRow("attack", a.id, a.category, mode, "not_run", reason), pass });
            log(`attack${tag} ${a.id} ${mode}: ${reason}`);
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
    model: [
      ranLlm
        ? `${harness!.model} (AI staff: Shopkeeper, Support, Bookkeeper; napkin = real Guard, baseline = BaselineGuard)`
        : "no LLM ran",
      ...(sections.has("compromised") ? [`compromised-model pass: ${COMPROMISED_MODEL}`] : []),
      "chaos, webhook attacks and the reference auditor use no model",
    ].join("; "),
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
    passes: PASS_META.filter((p) => results.some((r) => (r.kind === "attack" || (r.kind === "not_run" && r.subject === "attack")) && (r.pass ?? "real_model") === p.id)).map((p) => ({ ...p, title: p.id === "real_model" && ranLlm ? `Real model (${harness!.model})` : p.title })),
    results,
  });

  const outDir = join(REDTEAM_ROOT, "out");
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `run-${ranAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(jsonPath, JSON.stringify({ ...run, traces }, null, 2) + "\n");
  // Only a full run regenerates redteam/RESULTS.md; a partial (--only) run writes out/RESULTS.partial.md.
  const full = ALL_SECTIONS.every((x) => sections.has(x)) && !noLlm && !onlyIds;
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
