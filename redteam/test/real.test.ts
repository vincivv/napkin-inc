// Unit tests for the real runner's pure parts, with fakes (no database, no network):
// SATS snapshot parsing, row classification, chaos skip/evaluation, the reference auditor, the webhook
// signature round trip through the brain's verifier, and the real-mode refusal of FAKE rows.

import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAttacks, loadChaos, loadPlanted } from "../src/load";
import { renderResults, writeResults } from "../src/results";
import { scorePlanted } from "../src/score";
import { fakeRun } from "../src/fake-sample";
import { RunFile, type Attack, type ChaosCase, type PlatformSnapshot, type RunResult } from "../src/types";
import { decodeRows, decodeValue, snapshotFromTables, SNAPSHOT_TABLES, normalizeBusinessRows, type RawTables } from "../src/real/snapshot";
import { classifyAttack, HARNESS_MISSING, notRunRow, PHONE_NOT_DRIVEN, turnsFor } from "../src/real/classify";
import { chaosSkipReason, evaluateChaos, NEEDS_STRIPE } from "../src/real/chaos-eval";
import { auditBooks, policiesFromConfig } from "../src/real/auditor";
import { unsupportedSetup } from "../src/real/inspector";
import { assertScratchDb } from "../src/real/db";
import { signatureFor, stripeEventFor, stripeSignature } from "../src/real/stripe-events";
import { verifyStripeEvent } from "../src/real/brain";
import type { SqlResult } from "../src/real/db";
import fixture from "../../fixtures/maya/configuration.json";

// ---------- SATS-JSON helpers (shapes as returned by SpacetimeDB 2.13 POST /v1/database/:db/sql) ----------
const STR = { String: [] };
const U64 = { U64: [] };
const I64 = { I64: [] };
const U32 = { U32: [] };
const BOOL = { Bool: [] };
const ID = { Product: { elements: [{ name: { some: "__identity__" }, algebraic_type: { U256: [] } }] } };
const TS = { Product: { elements: [{ name: { some: "__timestamp_micros_since_unix_epoch__" }, algebraic_type: { I64: [] } }] } };
const OPT = (t: unknown) => ({ Sum: { variants: [{ name: { some: "some" }, algebraic_type: t }, { name: { some: "none" }, algebraic_type: { Product: { elements: [] } } }] } });
const PROD = (els: [string, unknown][]) => ({ Product: { elements: els.map(([n, t]) => ({ name: { some: n }, algebraic_type: t })) } });
const ARR = (t: unknown) => ({ Array: t });
const FV = PROD([["name", STR], ["value", STR]]);
const res = (cols: [string, unknown][], rows: unknown[][]): SqlResult => ({ schema: { elements: cols.map(([n, t]) => ({ name: { some: n }, algebraic_type: t })) }, rows });

const SYS = "0xc200aa";
const SHOP = "0xc200bb";

function tables(over: Partial<Record<(typeof SNAPSHOT_TABLES)[number], SqlResult>> = {}): RawTables {
  const base: Record<string, SqlResult> = {
    business: res([["id", STR], ["name", STR], ["active_config_id", U64], ["enforce", BOOL], ["created_at", TS]], [
      ["maya-cookies", "Maya's Cookies", 1, true, [1792861454731822]],
      ["maya-cookies-baseline", "Maya's Cookies (baseline)", 2, false, [1792861454831472]],
    ]),
    config_version: res([["id", U64], ["business_id", STR], ["version", U32], ["json", STR], ["status", STR], ["activated_by", OPT(ID)]], [
      [1, "maya-cookies", 1, JSON.stringify({ policies: { maxDiscount: "0.20" }, catalogs: [] }), "active", [0, [SYS]]],
      [2, "maya-cookies-baseline", 1, "{}", "active", [1, []]],
    ]),
    actor: res([["identity", ID], ["business_id", STR], ["role", STR], ["name", STR], ["granted_at", TS]], [
      [[SYS], "*", "system", "system", [1]],
      [[SHOP], "maya-cookies", "shopkeeper", "AI Shopkeeper", [2]],
    ]),
    customer_order: res([["id", STR], ["business_id", STR], ["status", STR], ["sale_document_id", U64], ["total_cents", I64], ["paid_cents", I64], ["refunded_cents", I64], ["customer_name", STR], ["paid_at", OPT(TS)]], [
      ["MC-T1", "maya-cookies", "paid", 7, 1500, 1500, 0, "Ana", [0, [1792861454999999]]],
      ["MC-T2", "maya-cookies-baseline", "pending_payment", 9, 300, 0, 0, "Bo", [1, []]],
    ]),
    document: res(
      [["id", U64], ["business_id", STR], ["doc_type", STR], ["status", STR], ["period", STR], ["external_ref", STR], ["fields", ARR(FV)], ["lines", ARR(PROD([["values", ARR(FV)]]))], ["total_cents", I64], ["created_by", ID], ["created_by_role", STR], ["approved_by", OPT(ID)], ["approved_by_role", STR], ["reversal_of", U64], ["reversed_by", U64]],
      [
        [7, "maya-cookies", "sale", "posted", "2026-10", "MC-T1", [["orderId", "MC-T1"], ["discountRate", "0"]], [[[["productId", "cookie_box6"], ["qty", "1"]]]], 1500, [SHOP], "shopkeeper", [0, [SYS]], "system", 0, 0],
        [8, "maya-cookies", "refund", "draft", "2026-10", "MC-T1", [["orderId", "MC-T1"]], [], 500, [SHOP], "support", [1, []], "", 0, 0],
      ],
    ),
    journal_line: res([["id", U64], ["business_id", STR], ["document_id", U64], ["account_code", STR], ["period", STR], ["debit_cents", I64], ["credit_cents", I64]], [
      [2, "maya-cookies", 7, "4000", "2026-10", 0, 1500],
      [1, "maya-cookies", 7, "1200", "2026-10", 1500, 0],
    ]),
    register_balance: res([["key", STR], ["business_id", STR], ["register_id", STR], ["dims_key", STR], ["qty", I64], ["amount_cents", I64]], [["maya-cookies|stock|item=choc_chip_cookie", "maya-cookies", "stock", "item=choc_chip_cookie", 42, 3360]]),
    period: res([["key", STR], ["business_id", STR], ["month", STR], ["status", STR], ["closed_by", OPT(ID)]], [["maya-cookies|2026-10", "maya-cookies", "2026-10", "open", [1, []]]]),
    processor_event: res([["event_id", STR], ["business_id", STR], ["kind", STR], ["order_id", STR], ["amount_cents", I64], ["document_id", U64]], [["evt_1", "maya-cookies", "payment_succeeded", "MC-T1", 1500, 10]]),
    outbox: res([["id", U64], ["business_id", STR], ["kind", STR], ["payload_json", STR], ["idempotency_key", STR], ["status", STR], ["attempts", U32]], [[3, "maya-cookies", "stripe_refund", "{}", "refund:8", "pending", 0]]),
    inbox_item: res([["id", U64], ["business_id", STR], ["from_role", STR], ["question", STR], ["document_ref", STR], ["status", STR]], [[1, "maya-cookies", "system", "Payment for unknown order MC-X", "MC-X", "open"]]),
    owner_statement: res([["id", U64], ["business_id", STR], ["channel", STR], ["status", STR], ["diff_json", STR]], []),
    decision_record: res([["id", U64], ["business_id", STR], ["actor_id", STR], ["action", STR], ["outcome", STR], ["rule_ids", ARR(STR)]], [[1, "maya-cookies", "shopkeeper", "quote", "refused", ["R-DISCOUNT-CAP"]]]),
    precedent: res([["id", U64], ["business_id", STR], ["agent_role", STR], ["rule", STR]], []),
  };
  const all = { ...base, ...over };
  const out = {} as RawTables;
  for (const t of SNAPSHOT_TABLES) {
    const rows = decodeRows(all[t]!);
    out[t] = t === "business" ? normalizeBusinessRows(rows) : rows;
  }
  return out;
}

describe("Inspector snapshot parsing (SATS-JSON -> PlatformSnapshot)", () => {
  it("decodes identities, timestamps, options and nested product arrays", () => {
    expect(decodeValue(ID, [SYS])).toBe(SYS);
    expect(decodeValue(TS, [42])).toBe(42);
    expect(decodeValue(OPT(ID), [0, [SYS]])).toBe(SYS);
    expect(decodeValue(OPT(ID), [1, []])).toBeNull();
    expect(decodeValue(ARR(FV), [["a", "1"], ["b", "2"]])).toEqual([{ name: "a", value: "1" }, { name: "b", value: "2" }]);
  });

  it("builds one business's snapshot and leaves the other business out", () => {
    const snap = snapshotFromTables("maya-cookies", tables(), [{ kind: "charge", orderId: "MC-T1", processorRef: "sim_pi_MC-T1", amountCents: 1500 }]);
    expect(snap.activeConfigId).toBe("1");
    expect(snap.activeConfig).toEqual({ policies: { maxDiscount: "0.20" }, catalogs: [] });
    expect(snap.orders.map((o) => o.id)).toEqual(["MC-T1"]);
    expect(snap.actors).toEqual([{ identity: SHOP, role: "shopkeeper", name: "AI Shopkeeper" }]); // the "*" system actor is not the business's
    const sale = snap.documents.find((d) => d.id === "7")!;
    expect(sale.fields).toEqual({ orderId: "MC-T1", discountRate: "0" });
    expect(sale.lines).toEqual([{ productId: "cookie_box6", qty: "1" }]);
    expect(sale.createdBy).toBe(SHOP);
    expect(sale.approvedBy).toBe(SYS);
    expect(snap.documents.find((d) => d.id === "8")!.approvedBy).toBeNull();
    expect(snap.journal.map((l) => l.accountCode)).toEqual(["1200", "4000"]); // sorted by journal line id
    expect(snap.registerBalances[0]).toEqual({ registerId: "stock", dimsKey: "item=choc_chip_cookie", qty: 42, amountCents: 3360 });
    expect(snap.processorEvents[0]).toEqual({ eventId: "evt_1", kind: "payment_succeeded", orderId: "MC-T1", amountCents: 1500, documentId: "10" });
    expect(snap.outbox[0]!.idempotencyKey).toBe("refund:8");
    expect(snap.inbox[0]!.documentRef).toBe("MC-X");
    expect(snap.decisions[0]!.ruleIds).toEqual(["R-DISCOUNT-CAP"]);
    expect(snap.configVersions).toEqual([{ id: "1", version: 1, status: "active" }]);
    expect(snap.processorTruth).toHaveLength(1);
  });

  it("fails loudly for an unknown business", () => {
    expect(() => snapshotFromTables("nope", tables(), [])).toThrow(/not found/);
  });

  it("only ever touches the scratch database", () => {
    expect(() => assertScratchDb("napkin")).toThrow(/refusing/);
    expect(() => assertScratchDb("napkin-l")).not.toThrow();
  });
});

describe("CLI row classification", () => {
  const attacks = loadAttacks();
  const byId = (id: string) => attacks.find((a) => a.id === id)!;

  it("webhook-channel platform attacks run for real without a harness", () => {
    expect(classifyAttack(byId("FP-02"), { harnessAvailable: false, setupProblems: [] })).toEqual({ route: "platform" });
  });

  it("agent attacks are not run when the harness is not merged, and never counted", () => {
    const r = classifyAttack(byId("FA-01"), { harnessAvailable: false, setupProblems: [] });
    expect(r).toEqual({ route: "not_run", status: "not_run", reason: HARNESS_MISSING });
    expect(classifyAttack(byId("FA-01"), { harnessAvailable: true, setupProblems: [] })).toEqual({ route: "agent" });
  });

  it("an unbuildable setup is not run, with the reason, even when the harness exists", () => {
    const rf01 = byId("RF-01"); // paid 50 h ago: outside the refund window, cannot be backdated
    const problems = unsupportedSetup(rf01);
    expect(problems.join()).toMatch(/50 h ago/);
    const r = classifyAttack(rf01, { harnessAvailable: true, setupProblems: problems });
    expect(r.route).toBe("not_run");
    expect(r.route === "not_run" && r.reason).toMatch(/setup unsupported/);
    const noHarness = classifyAttack(rf01, { harnessAvailable: false, setupProblems: problems });
    expect(noHarness.route === "not_run" && noHarness.reason).toMatch(/^not run: agent harness not merged; also setup unsupported/);
  });

  it("web_page attacks carry the page text in the turn that names its URL; other attacks are unchanged", () => {
    const wp = byId("WP-01");
    const t = turnsFor(wp);
    expect(t).toHaveLength(wp.turns.length);
    expect(t[0]).toContain(wp.setup!.webPage!.content);
    expect(t[1]).toBe(wp.turns[1]);
    expect(turnsFor(byId("FA-01"))).toEqual(byId("FA-01").turns);
  });

  it("refuses planted customer names the platform would refuse, and accepts recent sales", () => {
    expect(unsupportedSetup(byId("PI-01")).join()).toMatch(/customerName is 157 characters/);
    expect(unsupportedSetup(byId("RF-02"))).toEqual([]);
  });

  it("every attack lands in exactly one route", () => {
    for (const a of attacks) {
      const r = classifyAttack(a, { harnessAvailable: false, setupProblems: unsupportedSetup(a) });
      if (a.channel === "webhook") expect(r.route).toBe("platform");
      else expect(r.route).toBe("not_run");
      const withHarness = classifyAttack(a, { harnessAvailable: true, setupProblems: unsupportedSetup(a) });
      if (a.channel === "phone") expect(withHarness).toEqual({ route: "not_run", status: "not_run", reason: PHONE_NOT_DRIVEN });
    }
  });
});

describe("chaos: what needs Stripe, and checking expected state", () => {
  const cases = loadChaos();
  const byId = (id: string) => cases.find((c) => c.id === id)!;

  it("skips exactly the cases on the Stripe checkout-session path", () => {
    const skipped = cases.filter((c) => chaosSkipReason(c)).map((c) => c.id).sort();
    expect(skipped).toEqual(["CH-04", "CH-05", "CH-08"]);
    expect(chaosSkipReason(byId("CH-05"))).toMatch(new RegExp(`^${NEEDS_STRIPE}`));
  });

  const snapOf = (over: Partial<PlatformSnapshot>): PlatformSnapshot =>
    ({ businessId: "b", activeConfigId: "1", activeConfig: {}, actors: [], orders: [], documents: [], journal: [], registerBalances: [], periods: [], processorEvents: [], outbox: [], inbox: [], ownerStatements: [], decisions: [], processorTruth: [], ...over }) as PlatformSnapshot;
  const doc = (id: string, docType: string, orderId: string, status = "posted") => ({ id, docType, status, period: "2026-10", externalRef: orderId, fields: { orderId }, lines: [], totalCents: 1500, createdBy: "x", createdByRole: "system", approvedBy: "x", approvedByRole: "system", reversalOf: "0", reversedBy: "0" }) as PlatformSnapshot["documents"][number];
  const line = (documentId: string, accountCode: string, debitCents: number, creditCents: number) => ({ documentId, accountCode, period: "2026-10", debitCents, creditCents });

  it("CH-01 passes on the correct end state and fails on a double posting", () => {
    const c = byId("CH-01");
    const good = snapOf({
      orders: [{ id: "MC-CH01A", status: "paid", totalCents: 1500, paidCents: 1500, refundedCents: 0, customerName: "C", saleDocumentId: "1" }],
      documents: [doc("1", "sale", "MC-CH01A"), doc("2", "payment_received", "MC-CH01A")],
      journal: [line("2", "1010", 1500, 0), line("2", "1200", 0, 1500)],
      processorEvents: [{ eventId: "evt_ch01_pay", kind: "payment_succeeded", orderId: "MC-CH01A", amountCents: 1500, documentId: "2" }],
      processorTruth: [{ kind: "charge", orderId: "MC-CH01A", processorRef: "pi_ch01", amountCents: 1500 }],
    });
    expect(evaluateChaos(c, good)).toEqual([]);
    const doubled = snapOf({
      ...good,
      documents: [...good.documents, doc("3", "payment_received", "MC-CH01A")],
      journal: [...good.journal, line("3", "1010", 1500, 0), line("3", "1200", 0, 1500)],
    });
    const f = evaluateChaos(c, doubled);
    expect(f.some((x) => /2 payment_received/.test(x))).toBe(true);
    expect(f.some((x) => /Stripe clearing \(1010\) is 3000/.test(x))).toBe(true);
  });

  it("flags an unbalanced document, a missing inbox item and a wrong outbox status", () => {
    const c: ChaosCase = { ...byId("CH-03"), expected: { journalBalanced: true, inboxOpenedFor: ["MC-Z"], outbox: { kind: "stripe_refund", count: 1, status: "done" } } };
    const f = evaluateChaos(c, snapOf({ journal: [line("9", "1010", 100, 0)], outbox: [{ id: "1", kind: "stripe_refund", payloadJson: "{}", idempotencyKey: "refund:1", status: "claimed", attempts: 1 }] }));
    expect(f.join("\n")).toMatch(/journal unbalanced/);
    expect(f.join("\n")).toMatch(/no inbox item for MC-Z/);
    expect(f.join("\n")).toMatch(/is claimed, expected done/);
  });
});

describe("reference auditor", () => {
  const policies = policiesFromConfig(fixture as never);

  it("finds every planted error in both sets", () => {
    for (const { set } of loadPlanted()) {
      const s = scorePlanted(set.answerKey, auditBooks(set, policies));
      expect(s.recall).toBe(1);
      expect(s.missed).toEqual([]);
    }
  });

  it("never reads the answer key: same findings with the key removed", () => {
    for (const { set } of loadPlanted()) {
      expect(auditBooks({ ...set, answerKey: [{ id: "PE-Z-01", kind: "other", entries: ["X-000"], description: "decoy entry", invariantIds: [] }] }, policies)).toEqual(auditBooks(set, policies));
    }
  });

  it("respects the configuration's approval rules (machine documents may self-approve)", () => {
    const setA = loadPlanted()[0]!.set;
    const self = auditBooks(setA, policies).filter((f) => f.kind === "self_approved");
    expect(self).toEqual([]); // system/system payments and fees are allowed by the fixture
  });
});

describe("webhook signatures (verified by the brain's own verifier)", () => {
  const secret = "whsec_test_unit_only";
  const raw = JSON.stringify(stripeEventFor({ eventId: "evt_u1", kind: "payment_succeeded", orderId: "MC-U1", amountCents: 1500, processorRef: "pi_u1" }, "maya-cookies"));

  it("a locally signed event verifies and keeps its shape", () => {
    const ev = verifyStripeEvent(raw, stripeSignature(raw, secret), secret);
    expect(ev.id).toBe("evt_u1");
    expect(ev.type).toBe("checkout.session.completed");
  });

  it("missing, wrong-secret and stale signatures are rejected", () => {
    for (const v of ["missing", "wrong_secret", "stale_timestamp"] as const) {
      expect(() => verifyStripeEvent(raw, signatureFor(v, raw, secret), secret)).toThrow();
    }
  });
});

describe("RESULTS.md in real mode", () => {
  const realRun = (results: RunResult[]): RunFile =>
    RunFile.parse({ schema: "napkin-redteam-run/1", fake: false, label: "unit", model: "none", ranAt: "2026-10-24T00:00:00.000Z", attackSetHash: "x", gitCommit: "abc1234", results });

  it("refuses to render or write a real run that carries any FAKE (sample) row", () => {
    const fakeRow = fakeRun().results[0]!;
    const run = realRun([notRunRow("chaos", "CH-05", "crash", "napkin", "skipped", "skipped: needs Stripe test key"), fakeRow]);
    expect(() => renderResults(run)).toThrow(/sample records/);
    const root = mkdtempSync(join(tmpdir(), "rt-real-"));
    expect(() => writeResults(run, root)).toThrow(/sample records/);
    expect(existsSync(join(root, "RESULTS.md"))).toBe(false);
  });

  it("separates measured, skipped and not-run rows and never labels them FAKE", () => {
    const attack = loadAttacks().find((a) => a.id === "FP-02") as Attack;
    const md = renderResults(
      realRun([
        { kind: "chaos", caseId: "CH-01", chaosKind: "duplicate_webhook", mode: "napkin", passed: true, failures: [], invariantIds: [7] },
        notRunRow("chaos", "CH-05", "crash", "napkin", "skipped", "skipped: needs Stripe test key"),
        notRunRow("chaos", "CH-05", "crash", "baseline", "skipped", "skipped: needs Stripe test key"),
        notRunRow("attack", "FA-01", "fake_authority_discount", "napkin", "not_run", HARNESS_MISSING),
        { kind: "attack", attackId: attack.id, category: attack.category, mode: "napkin", breached: false, breachCodes: [], outcomes: [], measures: { money_lost_cents: 0, policy_changed: false, below_floor_sale: 0, unauthorized_refund: 0, duplicate_posting: 0, data_leak: 0 }, observed: "refuse", expected: "refuse", behaviorOk: true, invariantIds: [2, 7] },
      ]),
    );
    expect(md).not.toContain("FAKE SAMPLE DATA");
    expect(md).toContain("**Real run.**");
    expect(md).toContain("Git commit: abc1234");
    expect(md).toContain("## Skipped (cannot run in this environment)");
    expect(md).toContain("| chaos | CH-05 | crash | baseline, napkin | skipped: needs Stripe test key |");
    expect(md).toContain("## Not run (pending)");
    expect(md).toContain(`| attack | FA-01 | fake_authority_discount | napkin | ${HARNESS_MISSING} |`);
    expect(md).toContain("| attack | 1 | 0 | 1 |"); // coverage: 1 measured, 0 skipped, 1 not run
    // the not-run attack is not in the measured category table
    expect(md).not.toMatch(/\| fake_authority_discount \| 1 \|/);
  });
});
