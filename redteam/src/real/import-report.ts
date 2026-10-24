// Turn a committed RESULTS.md back into run rows, for a pass whose run file was lost.
//
//   tsx src/real/import-report.ts <RESULTS.md> <out.json> --source "<where it came from>"
//
// Why: the first real-model run (claude-sonnet-5-5, commit 2697f73) kept its run file, with the transcripts, only
// in a gitignored folder that was deleted with its worktree. Its measured rows survive only as RESULTS.md tables.
// This transcribes them as they are: attack rows (result, breach codes, observed, expected, behaviour, money),
// the Bookkeeper agent's planted-error rows, and the attack rows that were not run. Nothing is re-measured:
// the rows carry `source`, have no outcomes beyond their breach codes, and were NOT checked by detectors added
// later (the invariant 9 decision-record check, the draft-level refund and sale detectors), so their invariant
// lists are the attack's own, without the #9 that newer agent rows carry.

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadAttacks } from "../load";
import { attackSetHash } from "../run";
import { RunFile, type Mode, type NotRunResult, type RunResult } from "../types";

function tables(md: string, heading: RegExp): string[][][] {
  const out: string[][][] = [];
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!heading.test(lines[i]!)) continue;
    let j = i + 1;
    while (j < lines.length && !lines[j]!.startsWith("|")) j++;
    const rows: string[][] = [];
    for (; j < lines.length && lines[j]!.startsWith("|"); j++) rows.push(lines[j]!.slice(1, -1).split("|").map((c) => c.trim()));
    out.push(rows.slice(2)); // drop header + separator
  }
  return out;
}

const cents = (s: string) => Math.round(Number(s.replace(/[$,]/g, "")) * 100);

export function importReport(md: string, source: string): RunResult[] {
  const attacks = new Map(loadAttacks().map((a) => [a.id, a]));
  const out: RunResult[] = [];
  const [measured] = tables(md, /^#{2,4} Measured attack rows/);
  for (const [id, category, mode, result, codes, observed, expected, ok, money] of measured ?? []) {
    const a = attacks.get(id!);
    if (!a) throw new Error(`unknown attack ${id} in the report`);
    const breachCodes = codes === "none" ? [] : codes!.split(",").map((c) => c.trim());
    out.push({
      kind: "attack",
      attackId: id!,
      category: category!,
      mode: mode as Mode,
      pass: "real_model",
      source,
      breached: result!.includes("BREACH"),
      breachCodes,
      outcomes: breachCodes.map((code) => ({ code, cents: 0, detail: "transcribed from the report (detail not kept)", refs: [] })),
      measures: { money_lost_cents: cents(money!), policy_changed: false, below_floor_sale: 0, unauthorized_refund: 0, duplicate_posting: 0, data_leak: breachCodes.filter((c) => c === "leaked_canary").length },
      observed: observed as never,
      expected: expected as never,
      behaviorOk: ok === "yes",
      invariantIds: a.invariantIds,
    });
  }
  const [planted] = tables(md, /^## Planted errors/);
  for (const [setId, mode, auditor, errors, findings, tp, precision, recall, missed] of planted ?? []) {
    if (auditor !== "bookkeeper_agent") continue; // the reference auditor is re-run, not transcribed
    out.push({ kind: "planted", setId: setId!, mode: mode as Mode, auditor: "bookkeeper_agent", errors: Number(errors), findings: Number(findings), truePositives: Number(tp), precision: Number(precision!.replace("%", "")) / 100, recall: Number(recall!.replace("%", "")) / 100, missed: missed === "none" ? [] : missed!.split(",").map((m) => m.trim()) });
  }
  const [notRun] = tables(md, /^## Not run/);
  for (const [subject, id, category, modes, reason] of notRun ?? []) {
    if (subject !== "attack") continue;
    for (const mode of modes!.split(",").map((m) => m.trim())) {
      const row: NotRunResult = { kind: "not_run", subject: "attack", id: id!, category: category!, mode: mode as Mode, status: "not_run", reason: reason!, pass: "real_model" };
      out.push(row);
    }
  }
  return out;
}

function main(argv: string[]): void {
  const [mdPath, outPath] = argv;
  const source = argv[argv.indexOf("--source") + 1];
  if (!mdPath || !outPath || argv.indexOf("--source") < 0 || !source) throw new Error('usage: tsx src/real/import-report.ts <RESULTS.md> <out.json> --source "<origin>"');
  const md = readFileSync(mdPath, "utf8");
  const field = (name: string) => new RegExp(`^- ${name}: (.*)$`, "m").exec(md)?.[1] ?? "unknown";
  const run = RunFile.parse({
    schema: "napkin-redteam-run/1",
    fake: false,
    label: "real-model pass, transcribed from its report",
    model: field("Model"),
    ranAt: field("Ran at"),
    attackSetHash: field("Attack set hash"),
    gitCommit: field("Git commit"),
    environment: [...md.matchAll(/^- ((?:Platform|Businesses|Payments|Faults): .*)$/gm)].map((m) => m[1]!),
    notes: [
      `Real-model rows transcribed from ${source}. The run file with the transcripts was deleted with its worktree, so these rows could not be re-scored: the invariant 9 decision-record check and the draft-level detectors did not run on them.`,
      `Its attack set hash was ${field("Attack set hash")}; the set has changed since only in invariant labels (now ${attackSetHash(loadAttacks())}).`,
    ],
    results: importReport(md, source),
  });
  writeFileSync(outPath, JSON.stringify(run, null, 2) + "\n");
  console.log(`wrote ${outPath} (${run.results.length} rows)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
