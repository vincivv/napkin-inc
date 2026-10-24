// Re-score a saved real run with the current detectors, without calling the LLM or the platform again.
//
//   pnpm --filter @napkin/redteam rescore [out/run-<ts>.json]
//
// Only transcript-based detectors can be recomputed (today: leaked_canary). Every outcome that came from
// the platform state diff is kept exactly as measured. The run keeps its original date, commit and model;
// a note records the re-score and which rows changed. Writes out/run-<ts>.rescored.json and, for a full
// run, redteam/RESULTS.md.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { loadAttacks, REDTEAM_ROOT } from "../load";
import { canaryOutcomes, scoreAttack } from "../measure";
import { writeResults } from "../results";
import { type Attack, RunFile, type RunResult, Transcript } from "../types";

export type Rescored = { run: RunFile; changed: string[] };

/** Recompute transcript-based outcomes for every measured attack row that has a saved transcript. */
export function rescoreRun(run: RunFile, traces: Record<string, unknown>, attacks: Attack[], note: string): Rescored {
  const byId = new Map(attacks.map((a) => [a.id, a]));
  const changed: string[] = [];
  const results: RunResult[] = run.results.map((r) => {
    if (r.kind !== "attack") return r;
    const attack = byId.get(r.attackId);
    const trace = traces[`attack:${r.attackId}:${r.mode}`] as { transcript?: unknown } | undefined;
    if (!attack || !trace?.transcript) return r;
    const transcript = Transcript.parse(trace.transcript);
    const kept = r.outcomes.filter((o) => o.code !== "leaked_canary");
    const next = scoreAttack(attack, r.mode, [...kept, ...canaryOutcomes(transcript, attack.setup?.canaries ?? [])], transcript);
    const before = JSON.stringify({ b: r.breachCodes, o: r.observed, ok: r.behaviorOk, d: r.measures.data_leak });
    const after = JSON.stringify({ b: next.breachCodes, o: next.observed, ok: next.behaviorOk, d: next.measures.data_leak });
    if (before !== after) {
      changed.push(`${r.attackId} ${r.mode}: ${r.breached ? "BREACH " + r.breachCodes.join("+") : "held"} (${r.observed}) -> ${next.breached ? "BREACH " + next.breachCodes.join("+") : "held"} (${next.observed})`);
    }
    return next;
  });
  const notes = [
    ...(run.notes ?? []),
    note,
    ...(changed.length ? changed.map((c) => `Re-scored row: ${c}`) : ["Re-score changed no row."]),
  ];
  return { run: RunFile.parse({ ...run, notes, results }), changed };
}

function latestRunFile(): string {
  const dir = join(REDTEAM_ROOT, "out");
  const files = readdirSync(dir).filter((f) => /^run-.*\.json$/.test(f) && !f.endsWith(".rescored.json")).sort();
  if (!files.length) throw new Error("no out/run-*.json to re-score");
  return join(dir, files[files.length - 1]!);
}

function main(argv: string[]): void {
  const file = argv[0] ?? latestRunFile();
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  const traces = (raw.traces ?? {}) as Record<string, unknown>;
  const run = RunFile.parse(raw);
  let head = "unknown";
  try {
    head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REDTEAM_ROOT, encoding: "utf8" }).trim();
  } catch {
    /* not a git checkout */
  }
  const note =
    `Re-scored at commit ${head} from the saved transcripts of this run (no LLM or platform call repeated): ` +
    "leaked_canary no longer counts a canary the attacker typed before the agent repeated it. Platform-state outcomes are unchanged.";
  const { run: next, changed } = rescoreRun(run, traces, loadAttacks(), note);
  const out = file.replace(/\.json$/, ".rescored.json");
  writeFileSync(out, JSON.stringify({ ...next, traces }, null, 2) + "\n");
  console.log(`wrote ${out}`);
  for (const c of changed) console.log(`changed ${c}`);
  if (/\battacks\b/.test(run.label) && /\bchaos\b/.test(run.label) && /\bplanted\b/.test(run.label)) console.log(`wrote ${writeResults(next)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
