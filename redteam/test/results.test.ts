import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeRun } from "../src/fake-sample";
import { renderResults, writeResults } from "../src/results";
import { RunFile } from "../src/types";

describe("results generator", () => {
  it("is deterministic: the same input renders the same bytes, and result order does not matter", () => {
    const run = fakeRun();
    const once = renderResults(run);
    const twice = renderResults(run);
    const reordered = renderResults({ ...run, results: [...run.results].reverse() });
    expect(twice).toBe(once);
    expect(reordered).toBe(once);
  });

  it("the sample run is marked FAKE in both its file flag and its rendered banner", () => {
    const run = fakeRun();
    expect(run.fake).toBe(true);
    expect(run.results.every((r) => "sample" in r && r.sample === true)).toBe(true);
    const md = renderResults(run);
    expect(md).toContain("FAKE SAMPLE DATA");
  });

  it("renders the attack table, chaos section and planted section", () => {
    const md = renderResults(fakeRun());
    expect(md).toContain("| Category | Attacks | Baseline breaches | Napkin breaches |");
    expect(md).toContain("## Chaos cases");
    expect(md).toContain("## Planted errors");
  });

  it("writes fake runs only to out/RESULTS.sample.md, never to RESULTS.md", () => {
    const root = mkdtempSync(join(tmpdir(), "rt-results-"));
    const target = writeResults(fakeRun(), root);
    expect(target.endsWith(join("out", "RESULTS.sample.md"))).toBe(true);
    expect(existsSync(join(root, "RESULTS.md"))).toBe(false);
    expect(readFileSync(target, "utf8")).toContain("FAKE SAMPLE DATA");
  });

  it("refuses a real run that still carries sample records", () => {
    const root = mkdtempSync(join(tmpdir(), "rt-results-"));
    const run = RunFile.parse({ ...fakeRun(), fake: false });
    expect(() => writeResults(run, root)).toThrow(/sample records/);
    expect(existsSync(join(root, "RESULTS.md"))).toBe(false);
  });

  it("refuses a fake run that carries a record not marked as sample", () => {
    const root = mkdtempSync(join(tmpdir(), "rt-results-"));
    const base = fakeRun();
    const [first, ...rest] = base.results;
    const unmarked = { ...first!, sample: undefined } as (typeof base.results)[number];
    expect(() => writeResults({ ...base, results: [unmarked, ...rest] }, root)).toThrow(/not marked sample/);
  });
});
