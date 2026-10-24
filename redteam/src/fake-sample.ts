// FAKE sample run, for testing the results generator only. Every record is marked sample: true and the
// file is marked fake: true, so results.ts writes it to redteam/out/RESULTS.sample.md, never RESULTS.md.
//
//   tsx src/fake-sample.ts   -> redteam/examples/sample-run.FAKE.json
//
// Numbers are derived from a hash of each id, so the file is deterministic. They are invented.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadAttacks, loadChaos, loadPlanted, REDTEAM_ROOT } from "./load";
import { attackSetHash } from "./run";
import { scorePlanted } from "./score";
import { type Finding, type Mode, type RunFile, type RunResult } from "./types";

const h = (s: string) => parseInt(createHash("sha256").update(s).digest("hex").slice(0, 8), 16);

export function fakeRun(): RunFile {
  const attacks = loadAttacks();
  const results: RunResult[] = [];
  const modes: Mode[] = ["baseline", "napkin"];

  for (const a of attacks) {
    for (const m of modes) {
      const x = h(`${a.id}:${m}`);
      const breached = m === "baseline" ? x % 3 !== 0 : x % 11 === 0;
      const cents = breached ? 500 + (x % 4000) : 0;
      results.push({
        kind: "attack",
        attackId: a.id,
        category: a.category,
        mode: m,
        breached,
        breachCodes: breached ? ["sale_below_floor"] : [],
        outcomes: breached ? [{ code: "sale_below_floor", cents, detail: "FAKE sample outcome", refs: [] }] : [],
        measures: {
          money_lost_cents: cents,
          policy_changed: false,
          below_floor_sale: breached ? 1 : 0,
          unauthorized_refund: 0,
          duplicate_posting: 0,
          data_leak: 0,
        },
        observed: breached ? "breach" : a.expected.napkin === "escalate" ? "escalate" : "refuse",
        expected: a.expected.napkin,
        behaviorOk: !breached,
        invariantIds: a.invariantIds,
        sample: true,
      });
    }
  }

  for (const c of loadChaos()) {
    for (const m of modes) {
      const x = h(`${c.id}:${m}`);
      const passed = m === "napkin" ? true : x % 4 !== 0;
      results.push({
        kind: "chaos",
        caseId: c.id,
        chaosKind: c.kind,
        mode: m,
        passed,
        failures: passed ? [] : ["FAKE: expectation not met"],
        invariantIds: c.invariantIds,
        sample: true,
      });
    }
  }

  for (const { set } of loadPlanted()) {
    const errors = set.answerKey.length;
    // Napkin: the reference auditor finds everything. Baseline: the bookkeeper misses the last two and adds one false finding.
    const key = set.answerKey;
    const napkinFindings: Finding[] = key.map((e) => ({ kind: e.kind, entries: e.entries }));
    const baseFindings: Finding[] = [...key.slice(0, Math.max(0, errors - 2)).map((e) => ({ kind: e.kind, entries: e.entries })), { kind: "other", entries: ["S-999"], note: "FAKE false positive" }];
    for (const [mode, findings, auditor] of [
      ["baseline", baseFindings, "bookkeeper_agent"],
      ["napkin", napkinFindings, "reference_auditor"],
    ] as const) {
      const s = scorePlanted(key, findings);
      results.push({
        kind: "planted",
        setId: set.id,
        mode,
        auditor,
        errors: s.errors,
        findings: s.findings,
        truePositives: s.truePositives,
        precision: s.precision,
        recall: s.recall,
        missed: s.missed,
        sample: true,
      });
    }
  }

  return {
    schema: "napkin-redteam-run/1",
    fake: true,
    label: "FAKE sample (generator test only)",
    model: "none (fake)",
    ranAt: "1970-01-01T00:00:00.000Z",
    attackSetHash: attackSetHash(attacks),
    results,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = join(REDTEAM_ROOT, "examples");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "sample-run.FAKE.json");
  writeFileSync(out, JSON.stringify(fakeRun(), null, 2) + "\n");
  console.log(out);
}
