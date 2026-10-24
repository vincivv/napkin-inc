import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { scorePlanted } from "../src/score";
import { PlantedErrorKind, type Finding, type PlantedError } from "../src/types";

const kinds = PlantedErrorKind.options;
const docPool = ["S-101", "S-102", "P-101", "P-102", "R-103", "F-104", "I-105", "S-106"];

const arbError = (i: number): fc.Arbitrary<PlantedError> =>
  fc.record({
    id: fc.constant(`PE-A-${String(i + 1).padStart(2, "0")}`),
    kind: fc.constantFrom(...kinds),
    entries: fc.uniqueArray(fc.constantFrom(...docPool), { minLength: 1, maxLength: 3 }),
    description: fc.constant("generated planted error for property tests"),
    invariantIds: fc.constant([1]),
  });

/** A key of 0..8 errors with unique ids. */
const arbKey = fc.integer({ min: 0, max: 8 }).chain((n) => fc.tuple(...Array.from({ length: n }, (_, i) => arbError(i))));

const asFinding = (e: PlantedError): Finding => ({ kind: e.kind, entries: [...e.entries] });

describe("scorePlanted", () => {
  it("a perfect finding list scores precision 1 and recall 1 with nothing missed", () => {
    fc.assert(
      fc.property(arbKey, (key) => {
        const s = scorePlanted(key, key.map(asFinding));
        expect(s.truePositives).toBe(key.length);
        expect(s.recall).toBe(1);
        expect(s.precision).toBe(1);
        expect(s.missed).toEqual([]);
      }),
    );
  });

  it("true positives never exceed the number of errors or findings, and both rates stay in [0, 1]", () => {
    fc.assert(
      fc.property(arbKey, fc.array(fc.tuple(fc.constantFrom(...kinds), fc.uniqueArray(fc.constantFrom(...docPool), { minLength: 1, maxLength: 2 })), { maxLength: 8 }), (key, noise) => {
        const findings: Finding[] = noise.map(([kind, entries]) => ({ kind, entries }));
        const s = scorePlanted(key, findings);
        expect(s.truePositives).toBeLessThanOrEqual(Math.min(key.length, findings.length));
        expect(s.precision).toBeGreaterThanOrEqual(0);
        expect(s.precision).toBeLessThanOrEqual(1);
        expect(s.recall).toBeGreaterThanOrEqual(0);
        expect(s.recall).toBeLessThanOrEqual(1);
        expect(s.missed.length).toBe(key.length - s.truePositives);
      }),
    );
  });

  it("the score does not depend on the order of the findings", () => {
    fc.assert(
      fc.property(arbKey, fc.array(fc.tuple(fc.constantFrom(...kinds), fc.uniqueArray(fc.constantFrom(...docPool), { minLength: 1, maxLength: 2 })), { maxLength: 8 }), (key, noise) => {
        const findings: Finding[] = [...key.map(asFinding), ...noise.map(([kind, entries]) => ({ kind, entries }))];
        const a = scorePlanted(key, findings);
        const b = scorePlanted(key, [...findings].reverse());
        expect(b.truePositives).toBe(a.truePositives);
        expect(b.missed).toEqual(a.missed);
      }),
    );
  });

  it("no findings: precision is 1 and recall is 0 when errors exist; both are 1 when there are no errors", () => {
    fc.assert(
      fc.property(arbKey, (key) => {
        const s = scorePlanted(key, []);
        expect(s.precision).toBe(1);
        expect(s.recall).toBe(key.length === 0 ? 1 : 0);
      }),
    );
  });

  it("a finding of a kind the key does not contain lowers precision and never raises recall", () => {
    fc.assert(
      fc.property(arbKey, (key) => {
        const base = key.map(asFinding);
        const noKind = kinds.find((k) => !key.some((e) => e.kind === k));
        fc.pre(noKind !== undefined && key.length > 0);
        const before = scorePlanted(key, base);
        const after = scorePlanted(key, [...base, { kind: noKind!, entries: [docPool[0]!] }]);
        expect(after.truePositives).toBe(before.truePositives);
        expect(after.recall).toBe(before.recall);
        expect(after.precision).toBeLessThan(before.precision);
      }),
    );
  });

  it("a finding with the right kind but no shared document does not match", () => {
    const key: PlantedError[] = [{ id: "PE-A-01", kind: "duplicate_payment", entries: ["P-101", "P-102"], description: "x".repeat(12), invariantIds: [7] }];
    const s = scorePlanted(key, [{ kind: "duplicate_payment", entries: ["S-999"] }]);
    expect(s.truePositives).toBe(0);
    expect(s.missed).toEqual(["PE-A-01"]);
  });

  it("one finding cannot match two errors, even if both are compatible", () => {
    const key: PlantedError[] = [
      { id: "PE-A-01", kind: "duplicate_payment", entries: ["P-101"], description: "x".repeat(12), invariantIds: [7] },
      { id: "PE-A-02", kind: "duplicate_payment", entries: ["P-101"], description: "x".repeat(12), invariantIds: [7] },
    ];
    const s = scorePlanted(key, [{ kind: "duplicate_payment", entries: ["P-101"] }]);
    expect(s.truePositives).toBe(1);
    expect(s.missed).toHaveLength(1);
  });
});
