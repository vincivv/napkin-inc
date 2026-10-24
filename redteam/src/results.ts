// RESULTS.md generator. Pure rendering: renderResults(RunFile) is deterministic for a given input
// (no clock, no environment, all ordering sorted). Run it as a CLI:
//
//   tsx src/results.ts <run-file.json>
//
// Output routing (the guard against fake data reaching the real report):
//   fake === true   -> redteam/out/RESULTS.sample.md   (gitignored; never redteam/RESULTS.md)
//   fake === false  -> redteam/RESULTS.md
// A fake run that carries any non-sample record, or a real run that carries sample records, is refused.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REDTEAM_ROOT } from "./load";
import { INVARIANTS, RunFile, type RunResult, type AttackRunResult, type ChaosRunResult, type PlantedRunResult } from "./types";

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const sortStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function isAttack(r: RunResult): r is AttackRunResult {
  return r.kind === "attack";
}
function isChaos(r: RunResult): r is ChaosRunResult {
  return r.kind === "chaos";
}
function isPlanted(r: RunResult): r is PlantedRunResult {
  return r.kind === "planted";
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

export function renderResults(run: RunFile): string {
  const lines: string[] = [];
  lines.push("# Napkin Inc. red-team results", "");
  if (run.fake) {
    lines.push(
      "> **FAKE SAMPLE DATA.** Generated only to test the report generator. These numbers are not a measurement of any agent.",
      "",
    );
  }
  lines.push(
    `- Run label: ${run.label}`,
    `- Model: ${run.model}`,
    `- Ran at: ${run.ranAt}`,
    `- Attack set hash: ${run.attackSetHash}`,
    `- Schema: ${run.schema}`,
    "",
  );

  // ---- attacks by category ----
  const attacks = run.results.filter(isAttack);
  const categories = [...new Set(attacks.map((r) => r.category))].sort(sortStr);
  lines.push("## Attacks by category", "");
  const catRows = categories.map((cat) => {
    const rs = attacks.filter((r) => r.category === cat);
    const ids = new Set(rs.map((r) => r.attackId));
    const base = rs.filter((r) => r.mode === "baseline");
    const nap = rs.filter((r) => r.mode === "napkin");
    const baseBreaches = base.filter((r) => r.breached).length;
    const napBreaches = nap.filter((r) => r.breached).length;
    const baseMoney = base.reduce((s, r) => s + r.measures.money_lost_cents, 0);
    const napMoney = nap.reduce((s, r) => s + r.measures.money_lost_cents, 0);
    const invs = [...new Set(rs.flatMap((r) => r.invariantIds))].sort((a, b) => a - b);
    return [cat, String(ids.size), String(baseBreaches), String(napBreaches), money(baseMoney), money(napMoney), invs.map((i) => `#${i}`).join(", ") || "none"];
  });
  const totalIds = new Set(attacks.map((r) => r.attackId)).size;
  const totalBase = attacks.filter((r) => r.mode === "baseline");
  const totalNap = attacks.filter((r) => r.mode === "napkin");
  catRows.push([
    "**total**",
    String(totalIds),
    String(totalBase.filter((r) => r.breached).length),
    String(totalNap.filter((r) => r.breached).length),
    money(totalBase.reduce((s, r) => s + r.measures.money_lost_cents, 0)),
    money(totalNap.reduce((s, r) => s + r.measures.money_lost_cents, 0)),
    "",
  ]);
  lines.push(
    table(["Category", "Attacks", "Baseline breaches", "Napkin breaches", "Money lost (baseline)", "Money lost (Napkin)", "Invariants covered"], catRows),
    "",
  );
  if (attacks.length > 0) {
    lines.push("Invariants: " + Object.entries(INVARIANTS).map(([n, v]) => `#${n} ${v.title}${v.assumed ? " (assumed)" : ""}`).join("; "), "");
  }

  // ---- chaos ----
  const chaos = run.results.filter(isChaos);
  if (chaos.length > 0) {
    lines.push("## Chaos cases", "");
    const ids = [...new Set(chaos.map((r) => r.caseId))].sort(sortStr);
    const rows = ids.map((id) => {
      const rs = chaos.filter((r) => r.caseId === id);
      const base = rs.find((r) => r.mode === "baseline");
      const nap = rs.find((r) => r.mode === "napkin");
      const verdict = (r?: ChaosRunResult) => (r ? (r.passed ? "pass" : `FAIL (${r.failures.length})`) : "not run");
      const kind = rs[0]?.chaosKind ?? "";
      const invs = [...new Set(rs.flatMap((r) => r.invariantIds))].sort((a, b) => a - b);
      return [id, kind, verdict(base), verdict(nap), invs.map((i) => `#${i}`).join(", ")];
    });
    lines.push(table(["Case", "Kind", "Baseline", "Napkin", "Invariants"], rows), "");
  }

  // ---- planted errors ----
  const planted = run.results.filter(isPlanted);
  if (planted.length > 0) {
    lines.push("## Planted errors (bookkeeping audit)", "");
    const rows = [...planted]
      .sort((a, b) => sortStr(a.setId, b.setId) || sortStr(a.mode, b.mode) || sortStr(a.auditor, b.auditor))
      .map((r) => [
        r.setId,
        r.mode,
        r.auditor,
        String(r.errors),
        String(r.findings),
        String(r.truePositives),
        pct(r.precision),
        pct(r.recall),
        r.missed.length ? r.missed.join(", ") : "none",
      ]);
    lines.push(table(["Set", "Mode", "Auditor", "Errors", "Findings", "True positives", "Precision", "Recall", "Missed"], rows), "");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/** Refuses a mismatch between the run's fake flag and the records it carries. */
export function assertRunRoutable(run: RunFile): void {
  const sampleRecords = run.results.filter((r) => "sample" in r && r.sample === true).length;
  if (run.fake && sampleRecords !== run.results.length) {
    throw new Error("fake run contains records not marked sample; refusing to render");
  }
  if (!run.fake && sampleRecords > 0) {
    throw new Error(`real run contains ${sampleRecords} sample records; refusing to render`);
  }
}

/** Writes the report to the only path allowed for this kind of run. */
export function writeResults(run: RunFile, rootDir: string = REDTEAM_ROOT): string {
  assertRunRoutable(run);
  const target = run.fake ? join(rootDir, "out", "RESULTS.sample.md") : join(rootDir, "RESULTS.md");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderResults(run));
  return target;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error("usage: tsx src/results.ts <run-file.json>");
  const run = RunFile.parse(JSON.parse(readFileSync(file, "utf8")));
  console.log(writeResults(run));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  });
}
