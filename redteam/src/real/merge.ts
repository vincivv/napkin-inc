// Merge real run files into one report:  tsx src/real/merge.ts <run.json> <run.json> ... [--out RESULTS.md]
//
// Used when the passes ran separately (e.g. the real-model pass on one commit, the compromised-model pass, chaos
// and the reference auditor on a later one). Rules:
//   - every input must be a real run (fake: false); sample rows are refused as everywhere else
//   - a not-run row is dropped when another input measured the same item (same subject, id, pass/auditor, mode)
//   - two measured rows for the same item are an error (one measurement per item)
//   - each file's model, date, commit, environment and notes are kept, labelled by file
// Writes redteam/RESULTS.md (or --out).

import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { writeResults, renderResults } from "../results";
import { RunFile, type RunResult } from "../types";
import { PASS_META } from "./run-real";

function itemKey(r: RunResult): string {
  switch (r.kind) {
    case "attack":
      return `attack|${r.pass ?? "real_model"}|${r.attackId}|${r.mode}`;
    case "chaos":
      return `chaos|${r.caseId}|${r.mode}`;
    case "planted":
      return `planted|${r.setId}|${r.auditor}|${r.mode}`;
    case "not_run":
      return r.subject === "attack" ? `attack|${r.pass ?? "real_model"}|${r.id}|${r.mode}` : r.subject === "planted" ? `planted|${r.id}|${r.category}|${r.mode}` : `chaos|${r.id}|${r.mode}`;
  }
}

export function mergeRuns(files: { name: string; run: RunFile }[]): RunFile {
  const measured = new Map<string, string>();
  for (const { name, run } of files) {
    if (run.fake) throw new Error(`${name} is a FAKE sample run; refusing to merge it into a real report`);
    for (const r of run.results) {
      if (r.kind === "not_run") continue;
      const k = itemKey(r);
      if (measured.has(k)) throw new Error(`${k} is measured in both ${measured.get(k)} and ${name}`);
      measured.set(k, name);
    }
  }
  const results = files.flatMap(({ run }) => run.results.filter((r) => r.kind !== "not_run" || !measured.has(itemKey(r))));
  const per = (f: (run: RunFile) => string | undefined) => files.map(({ name, run }) => `${f(run) ?? "unknown"} (${name})`).join("; ");
  const realFile = files.find(({ run }) => run.results.some((r) => r.kind === "attack" && (r.pass ?? "real_model") === "real_model"));
  const realModel = realFile?.run.model.split(/[ ;(]/)[0];
  const passIds = new Set(results.flatMap((r) => (r.kind === "attack" || (r.kind === "not_run" && r.subject === "attack") ? [r.pass ?? "real_model"] : [])));
  return RunFile.parse({
    schema: "napkin-redteam-run/1",
    fake: false,
    label: `merged report of ${files.length} real runs: ${files.map((f) => `${f.name} (${f.run.label})`).join("; ")}`,
    model: per((r) => r.model),
    ranAt: per((r) => r.ranAt),
    attackSetHash: per((r) => r.attackSetHash),
    gitCommit: per((r) => r.gitCommit),
    environment: [...new Set(files.flatMap(({ run }) => run.environment ?? []))],
    notes: files.flatMap(({ name, run }) => (run.notes ?? []).map((n) => `${name}: ${n}`)),
    passes: PASS_META.filter((p) => passIds.has(p.id)).map((p) => (p.id === "real_model" && realModel ? { ...p, title: `Real model (${realModel})` } : p)),
    results,
  });
}

function main(argv: string[]): void {
  const outIdx = argv.indexOf("--out");
  const out = outIdx >= 0 ? argv[outIdx + 1] : undefined;
  const inputs = argv.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1));
  if (inputs.length < 1) throw new Error("usage: tsx src/real/merge.ts <run.json> ... [--out file.md]");
  const merged = mergeRuns(inputs.map((p) => ({ name: basename(p), run: RunFile.parse(JSON.parse(readFileSync(p, "utf8"))) })));
  if (out) {
    writeFileSync(out, renderResults(merged));
    console.log(`wrote ${out}`);
  } else {
    console.log(`wrote ${writeResults(merged)}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
