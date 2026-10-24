import { describe, expect, it } from "vitest";
import { loadAttacks, loadChaos, loadPlanted } from "../src/load";
import { PlantedErrorKind } from "../src/types";

describe("red-team data files", () => {
  it("every attack, chaos case and planted set validates against the zod contracts", () => {
    // loaders throw on the first invalid file, naming the file and the zod issues
    expect(() => loadAttacks()).not.toThrow();
    expect(() => loadChaos()).not.toThrow();
    expect(() => loadPlanted()).not.toThrow();
  });

  it("attack ids are unique", () => {
    const ids = loadAttacks().map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("there are at least 50 attacks across at least 8 categories", () => {
    const attacks = loadAttacks();
    const categories = new Set(attacks.map((a) => a.category));
    expect(attacks.length).toBeGreaterThanOrEqual(50);
    expect(categories.size).toBeGreaterThanOrEqual(8);
  });

  it("every attack states an exact safe behaviour and at least one forbidden outcome", () => {
    for (const a of loadAttacks()) {
      expect(a.expected.safeBehavior.length).toBeGreaterThanOrEqual(20);
      expect(a.expected.forbiddenOutcomes.length).toBeGreaterThan(0);
    }
  });

  it("chaos case ids are unique and cover the required kinds", () => {
    const cases = loadChaos();
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
    const kinds = new Set(cases.map((c) => c.kind));
    for (const k of ["duplicate_webhook", "concurrent_duplicate_webhook", "amount_mismatch", "crash", "timeout", "out_of_order"]) {
      expect(kinds.has(k as never), `missing chaos kind ${k}`).toBe(true);
    }
  });

  it("planted sets: 2 or more sets with 8 to 12 planted errors in total, and unique error ids", () => {
    const sets = loadPlanted().map((p) => p.set);
    expect(sets.length).toBeGreaterThanOrEqual(2);
    const total = sets.reduce((s, x) => s + x.answerKey.length, 0);
    expect(total).toBeGreaterThanOrEqual(8);
    expect(total).toBeLessThanOrEqual(12);
    const ids = sets.flatMap((s) => s.answerKey.map((e) => e.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("planted answer keys point only at documents that exist in their set", () => {
    for (const { set } of loadPlanted()) {
      const docIds = new Set(set.documents.map((d) => d.id));
      for (const err of set.answerKey) {
        for (const e of err.entries) expect(docIds.has(e), `${err.id} names missing document ${e}`).toBe(true);
      }
    }
  });

  it("planted books: every document balances except the ones the answer key marks as unbalanced", () => {
    for (const { set } of loadPlanted()) {
      const unbalanced = new Set(set.answerKey.filter((e) => e.kind === "unbalanced_entry").flatMap((e) => e.entries));
      for (const d of set.documents) {
        const debits = d.journal.reduce((s, l) => s + l.debitCents, 0);
        const credits = d.journal.reduce((s, l) => s + l.creditCents, 0);
        if (unbalanced.has(d.id)) expect(debits).not.toBe(credits);
        else expect(debits, `${d.id} unbalanced`).toBe(credits);
      }
    }
  });

  it("answer-key kinds are all valid planted error kinds", () => {
    const valid = new Set(PlantedErrorKind.options as string[]);
    for (const { set } of loadPlanted()) for (const e of set.answerKey) expect(valid.has(e.kind)).toBe(true);
  });
});
