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
import { INVARIANTS, RunFile, type Pass, type RunResult, type AttackRunResult, type ChaosRunResult, type NotRunResult, type PlantedRunResult } from "./types";

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
function isNotRun(r: RunResult): r is NotRunResult {
  return r.kind === "not_run";
}

/** Skipped / not-run rows, one line per (subject, id, reason) with the modes joined. */
function notRunTable(rows: NotRunResult[]): string {
  const groups = new Map<string, { r: NotRunResult; modes: string[] }>();
  for (const r of rows) {
    const k = `${r.subject}\u0000${r.pass ?? ""}\u0000${r.id}\u0000${r.category}\u0000${r.reason}`;
    const g = groups.get(k) ?? { r, modes: [] };
    g.modes.push(r.mode);
    groups.set(k, g);
  }
  const order = { attack: 0, chaos: 1, planted: 2 } as const;
  const lines = [...groups.values()]
    .sort((a, b) => order[a.r.subject] - order[b.r.subject] || sortStr(a.r.id, b.r.id) || sortStr(a.r.category, b.r.category) || sortStr(a.r.reason, b.r.reason))
    .map(({ r, modes }) => [r.subject === "attack" && r.pass === "compromised_model" ? "attack (compromised model)" : r.subject, r.id, r.category, [...modes].sort(sortStr).join(", "), r.reason.replace(/\|/g, "/")]);
  return table(["Subject", "Id", "Category", "Modes", "Reason"], lines);
}

function table(headers: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line)].join("\n");
}

const PASS_ORDER: Pass[] = ["real_model", "compromised_model"];

/** Category table and (real runs) the per-row table for one set of attack rows. */
function attackTables(attacks: AttackRunResult[], fake: boolean, h: string): string[] {
  const lines: string[] = [];
  const categories = [...new Set(attacks.map((r) => r.category))].sort(sortStr);
  lines.push(fake ? `${h} Attacks by category` : `${h} Attacks by category (measured rows only)`, "");
  const sum = (rs: AttackRunResult[]) => rs.reduce((s, r) => s + r.measures.money_lost_cents, 0);
  const catRows = categories.map((cat) => {
    const rs = attacks.filter((r) => r.category === cat);
    const base = rs.filter((r) => r.mode === "baseline");
    const nap = rs.filter((r) => r.mode === "napkin");
    const invs = [...new Set(rs.flatMap((r) => r.invariantIds))].sort((a, b) => a - b);
    return [cat, String(new Set(rs.map((r) => r.attackId)).size), String(base.filter((r) => r.breached).length), String(nap.filter((r) => r.breached).length), money(sum(base)), money(sum(nap)), invs.map((i) => `#${i}`).join(", ") || "none (data_leak only)"];
  });
  const totalBase = attacks.filter((r) => r.mode === "baseline");
  const totalNap = attacks.filter((r) => r.mode === "napkin");
  catRows.push(["**total**", String(new Set(attacks.map((r) => r.attackId)).size), String(totalBase.filter((r) => r.breached).length), String(totalNap.filter((r) => r.breached).length), money(sum(totalBase)), money(sum(totalNap)), ""]);
  lines.push(table(["Category", "Attacks", "Baseline breaches", "Napkin breaches", "Money lost (baseline)", "Money lost (Napkin)", "Invariants covered"], catRows), "");
  if (attacks.length > 0 && !fake) {
    lines.push(`${h}# Measured attack rows`, "");
    const rows = [...attacks]
      .sort((a, b) => sortStr(a.attackId, b.attackId) || sortStr(a.mode, b.mode))
      .map((r) => [r.attackId, r.category, r.mode, r.breached ? "**BREACH**" : "held", r.breachCodes.join(", ") || "none", r.observed, r.expected, r.behaviorOk ? "yes" : "no", money(r.measures.money_lost_cents)]);
    lines.push(table(["Attack", "Category", "Mode", "Result", "Breach codes", "Observed", "Expected (Napkin)", "Behaviour OK", "Money lost"], rows), "");
  }
  return lines;
}

export function renderResults(run: RunFile): string {
  assertRunRoutable(run); // a real report never renders a FAKE (sample) row
  const lines: string[] = [];
  lines.push("# Napkin Inc. red-team results", "");
  if (run.fake) {
    lines.push(
      "> **FAKE SAMPLE DATA.** Generated only to test the report generator. These numbers are not a measurement of any agent.",
      "",
    );
  } else {
    lines.push(
      "> **Real run.** Every number below was measured on a running system. Rows that did not run are listed under",
      '> "Skipped" and "Not run" with their reasons and are never counted as a pass or a breach. No FAKE sample row is included.',
      "",
    );
  }
  lines.push(
    `- Run label: ${run.label}`,
    `- Model: ${run.model}`,
    `- Ran at: ${run.ranAt}`,
    ...(run.gitCommit ? [`- Git commit: ${run.gitCommit}`] : []),
    `- Attack set hash: ${run.attackSetHash}`,
    `- Schema: ${run.schema}`,
    ...(run.environment ?? []).map((e) => `- ${e}`),
    "",
  );

  const notRun = run.results.filter(isNotRun);
  const measured = run.results.filter((r) => !isNotRun(r));
  const attacks = run.results.filter(isAttack);
  const passOf = (r: { pass?: Pass }): Pass => r.pass ?? "real_model";
  const passIds = PASS_ORDER.filter((p) => attacks.some((r) => passOf(r) === p) || notRun.some((r) => r.subject === "attack" && passOf(r) === p));
  const multiPass = passIds.length > 1 || passIds.some((p) => p !== "real_model");
  const passLabel = (p: Pass) => (p === "real_model" ? "real model" : "compromised model, scripted");
  if (!run.fake || notRun.length > 0) {
    const count = (label: string, m: number, rows: NotRunResult[]) => [label, String(m), String(rows.filter((r) => r.status === "skipped").length), String(rows.filter((r) => r.status === "not_run").length)];
    const rows: string[][] = [];
    if (multiPass) {
      for (const p of passIds) rows.push(count(`attack (${passLabel(p)})`, attacks.filter((r) => passOf(r) === p).length, notRun.filter((r) => r.subject === "attack" && passOf(r) === p)));
    } else {
      rows.push(count("attack", attacks.length, notRun.filter((r) => r.subject === "attack")));
    }
    rows.push(count("chaos", measured.filter((r) => r.kind === "chaos").length, notRun.filter((r) => r.subject === "chaos")));
    rows.push(count("planted", measured.filter((r) => r.kind === "planted").length, notRun.filter((r) => r.subject === "planted")));
    lines.push("## Coverage (rows = item x mode)", "");
    lines.push(table(["Subject", "Measured", "Skipped", "Not run"], rows), "");
  }

  if (multiPass) {
    for (const p of passIds) {
      const meta = run.passes?.find((x) => x.id === p);
      lines.push(`## ${meta?.title ?? (p === "real_model" ? "Real model" : "Compromised model (scripted, worst case)")}`, "");
      for (const d of meta?.description ?? []) lines.push(`> ${d}`);
      if (meta?.description.length) lines.push("");
      lines.push(...attackTables(attacks.filter((r) => passOf(r) === p), run.fake, "###"));
    }
  } else {
    lines.push(...attackTables(attacks, run.fake, "##"));
  }
  if (attacks.length > 0) {
    lines.push(
      "Invariants (docs/INVARIANTS.md): " + Object.entries(INVARIANTS).map(([n, v]) => `#${n} ${v.title}`).join(" "),
      "",
      "Customer-data disclosure is not a numbered invariant; it is measured as `data_leak` (`leaked_canary`).",
      "",
    );
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

  // ---- skipped / not run ----
  const skipped = notRun.filter((r) => r.status === "skipped");
  const pending = notRun.filter((r) => r.status === "not_run");
  if (skipped.length > 0) {
    lines.push("## Skipped (cannot run in this environment)", "", notRunTable(skipped), "");
  }
  if (pending.length > 0) {
    lines.push("## Not run (pending)", "", notRunTable(pending), "");
  }

  if ((run.notes ?? []).length > 0) {
    lines.push("## Notes", "", ...[...(run.notes ?? [])].map((n) => `- ${n}`), "");
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
