import { describe, expect, it } from "vitest";
import { checkConfigurationSemantics, ContractError, parseConfiguration, parseDecisionRecord, usableForMoney, Fact, Decimal, type Configuration } from "../src";
import maya from "../../../fixtures/maya/configuration.json";

describe("Configuration contract", () => {
  it("Maya's hand-written configuration is valid in shape and semantics", () => {
    const cfg = parseConfiguration(maya);
    expect(checkConfigurationSemantics(cfg)).toEqual([]);
  });

  it("rejects float money", () => {
    const bad = structuredClone(maya) as Record<string, any>;
    bad.policies.marginFloor = 0.3;
    expect(() => parseConfiguration(bad)).toThrow(ContractError);
  });

  it("finds unknown accounts, undeclared names and bad syntax", () => {
    const cfg = structuredClone(parseConfiguration(maya)) as Configuration;
    const sale = cfg.documents.find((d) => d.id === "sale")!;
    sale.postingRules[0]!.target = { kind: "account", code: "9999" };
    sale.postingRules[1]!.amountExpr = "line.mystery * 2";
    sale.checks[0]!.assert = "line.qty >=";
    const msgs = checkConfigurationSemantics(cfg).map((i) => i.message).join("\n");
    expect(msgs).toMatch(/unknown account 9999/);
    expect(msgs).toMatch(/undeclared line.mystery/);
    expect(msgs).toMatch(/does not parse/);
  });
});

describe("Fact provenance", () => {
  const F = Fact(Decimal);
  it("inferred facts never drive money decisions, even if marked confirmed by mistake", () => {
    const f = F.parse({ value: "0.80", provenance: "inferred", confidence: 0.9, source: { kind: "photo", ref: "napkin.jpg" }, confirmed: true });
    expect(usableForMoney(f)).toBe(false);
  });
  it("owner-confirmed facts can", () => {
    const f = F.parse({ value: "0.80", provenance: "owner_said", confidence: 1, source: { kind: "voice", ref: "rec1" }, confirmed: true });
    expect(usableForMoney(f)).toBe(true);
  });
  it("rejects confidence outside 0..1", () => {
    expect(F.safeParse({ value: "1", provenance: "paper", confidence: 1.2, source: { kind: "photo", ref: "x" }, confirmed: false }).success).toBe(false);
  });
});

describe("DecisionRecord", () => {
  it("validates", () => {
    expect(
      parseDecisionRecord({ id: "d1", actor: { kind: "agent", id: "shopkeeper" }, action: "apply_discount", documentRef: null, ruleIds: ["margin_floor"], evidenceRefs: [], inputsHash: "abc", outcome: "refused", reason: "25% exceeds max 20%", wouldChangeIf: "owner raises maxDiscount", timestamp: new Date().toISOString() }).outcome,
    ).toBe("refused");
  });
});
