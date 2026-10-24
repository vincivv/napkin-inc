// Re-score a saved real run with the current detectors, without calling the LLM or the platform again.
//
//   pnpm --filter @napkin/redteam rescore [out/run-<ts>.json]
//
// A row whose trace kept its before/after platform snapshots (runs from this version on) is re-measured with
// every current detector. A row with only a transcript gets its transcript-based detectors recomputed
// (leaked_canary); its platform-state outcomes are kept exactly as measured. The run keeps its original date, commit and model;
// a note records the re-score and which rows changed. Writes out/run-<ts>.rescored.json and, for a full
// run, redteam/RESULTS.md.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { loadAttacks, REDTEAM_ROOT } from "../load";
import { canaryOutcomes, measureAttack, scoreAttack } from "../measure";
import { writeResults } from "../results";
import { type Attack, PlatformSnapshot, RunFile, type RunResult, Transcript } from "../types";

export type Rescored = { run: RunFile; changed: string[] };

/** Recompute transcript-based outcomes for every measured attack row that has a saved transcript. */
export function rescoreRun(run: RunFile, traces: Record<string, unknown>, attacks: Attack[], note: string): Rescored {
  const byId = new Map(attacks.map((a) => [a.id, a]));
  const changed: string[] = [];
  const results: RunResult[] = run.results.map((r) => {
    if (r.kind !== "attack") return r;
    const attack = byId.get(r.attackId);
    const key = (r.pass ?? "real_model") === "real_model" ? `attack:${r.attackId}:${r.mode}` : `attack:${r.pass}:${r.attackId}:${r.mode}`;
    const trace = traces[key] as { transcript?: unknown; before?: unknown; after?: unknown } | undefined;
    if (!attack || !trace?.transcript) return r;
    const transcript = Transcript.parse(trace.transcript);
    let next: RunResult;
    if (trace.before && trace.after) {
      next = measureAttack(attack, r.mode, PlatformSnapshot.parse(trace.before), PlatformSnapshot.parse(trace.after), transcript, r.pass ? { pass: r.pass } : {});
    } else {
      const kept = r.outcomes.filter((o) => o.code !== "leaked_canary");
      next = { ...scoreAttack(attack, r.mode, [...kept, ...canaryOutcomes(transcript, attack.setup?.canaries ?? [])], transcript), ...(r.pass ? { pass: r.pass } : {}) };
    }
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
    "rows with saved snapshots were re-measured with every current detector; rows with only a transcript had leaked_canary recomputed and kept their platform-state outcomes.";
  const { run: next, changed } = rescoreRun(run, traces, loadAttacks(), note);
  const out = file.replace(/\.json$/, ".rescored.json");
  writeFileSync(out, JSON.stringify({ ...next, traces }, null, 2) + "\n");
  console.log(`wrote ${out}`);
  for (const c of changed) console.log(`changed ${c}`);
  if (["attacks", "compromised", "chaos", "planted"].every((x) => new RegExp(`\\b${x}\\b`).test(run.label))) console.log(`wrote ${writeResults(next)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
