import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fc from "fast-check";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { PolicyCheckError, post, UnbalancedPostingError, type DocumentDef, type DocumentInput } from "@napkin/ledger-core";
import { checkConfigurationSemantics, parseConfiguration } from "@napkin/schema";
import maya from "../../../fixtures/maya/configuration.json";
import { AccountStore, businessGate, GATED_PATHS } from "../src/accounts";
import { compile, StubProver } from "../src/compiler";
import { docDef, dryRun, expenseInput, postingContext } from "../src/compiler/dryrun";
import * as T from "../src/compiler/templates/item_seller";
import { cleanDate, cleanMoney, cleanReceipt } from "../src/expenses/receipt";
import { expenseRoutes, ReceiptStore } from "../src/expenses/routes";
import { LlmUnavailable, type Llm, type ToolRequest } from "../src/llm";
import { mayaTestSpec, TEST_ROLE_LIMITS } from "./fixtures/maya-spec.TEST";

const fixture = parseConfiguration(maya);
const ctx = postingContext(fixture);
const expense = docDef(fixture, "expense") as DocumentDef;
const CATEGORY_CODES: string[] = T.EXPENSE_CATEGORIES.map((c) => c.code);
const PAID_FROM: string[] = T.EXPENSE_PAID_FROM.map((p) => p.code);

const lines = (doc: DocumentInput) => post(expense, doc, ctx).journal.map((j) => ({ account: j.account, dr: j.debitCents, cr: j.creditCents }));

describe("expense document type (template + fixture)", () => {
  it("is in the template and the fixture, owner-only, posts on create, and passes semantics", () => {
    const d = T.documents().find((x) => x.id === "expense")!;
    expect(d.approval).toMatchObject({ creatorRoles: ["owner"], approverRoles: ["owner"], postOn: "create", cannotApproveOwn: false });
    expect(fixture.documents.find((x) => x.id === "expense")).toEqual(d);
    for (const c of T.EXPENSE_CATEGORIES) expect(fixture.chartOfAccounts).toContainEqual({ code: c.code, name: c.name, type: "expense" });
    // no AI staff role can create expenses (the platform also lets only creatorRoles + owner create)
    for (const role of ["system", "storefront", "shopkeeper", "support", "bookkeeper"]) expect(d.approval.creatorRoles).not.toContain(role);
    expect(checkConfigurationSemantics(fixture)).toEqual([]);
  });

  it("expense account codes do not collide with the existing chart", () => {
    const codes = fixture.chartOfAccounts.map((a) => a.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of CATEGORY_CODES) expect(c.startsWith("6")).toBe(true);
  });

  it.each(T.EXPENSE_CATEGORIES.flatMap((c) => PAID_FROM.map((p) => [c.category, c.code, p] as const)))("%s (%s) paid from %s posts balanced: debit the category, credit the paying side", (_cat, code, paidFrom) => {
    const r = post(expense, expenseInput(code, "1234.56", paidFrom), ctx);
    expect(r.totalDebitCents).toBe(123456n);
    expect(r.totalCreditCents).toBe(123456n);
    expect(lines(expenseInput(code, "1234.56", paidFrom))).toEqual([
      { account: code, dr: 123456n, cr: 0n },
      { account: paidFrom, dr: 0n, cr: 123456n },
    ]);
    expect(r.computed.doc["total"]!.toCents()).toBe(123456n);
  });

  it("a receipt split across categories posts each line to its own account, one credit for the total", () => {
    const doc: DocumentInput = {
      fields: { vendor: "Costco", date: "2026-10-20", paidFrom: "1000", receiptRef: "" },
      lines: [
        { account: "6100", amount: "40.10", description: "flour" },
        { account: "6300", amount: "19.99", description: "propane" },
        { account: "6100", amount: "0.01", description: "bag" },
      ],
    };
    expect(lines(doc)).toEqual([
      { account: "6100", dr: 4010n, cr: 0n },
      { account: "6100", dr: 1n, cr: 0n },
      { account: "6300", dr: 1999n, cr: 0n },
      { account: "1000", dr: 0n, cr: 6010n },
    ]);
  });

  it("refuses every non-expense account (revenue, cash, tax, equity, COGS...) and never books into it", () => {
    const foreign = fixture.chartOfAccounts.map((a) => a.code).filter((c) => !CATEGORY_CODES.includes(c));
    expect(foreign).toEqual(expect.arrayContaining(["1000", "1010", "1200", "1300", "2000", "2100", "3000", "4000", "4100", "4200", "5000", "5100"]));
    for (const code of [...foreign, "6001", "0", "-6000", "6000.5", "7000"]) {
      expect(() => post(expense, expenseInput(code, "10.00", "1000"), ctx), code).toThrow(PolicyCheckError);
      expect(() => post(expense, expenseInput(code, "10.00", "1000"), ctx), code).toThrow(/expense_account/);
      // even with the checks off (red-team baseline) no debit rule matches, so the posting cannot balance
      expect(() => post(expense, expenseInput(code, "10.00", "1000"), ctx, { skipChecks: true }), code).toThrow(UnbalancedPostingError);
    }
  });

  it("refuses a paying side other than cash (1000) or payables (2000)", () => {
    for (const paidFrom of ["1010", "1200", "3000", "4000", "2100", "6000", "0"]) {
      expect(() => post(expense, expenseInput("6000", "10.00", paidFrom), ctx), paidFrom).toThrow(/paid_from/);
      expect(() => post(expense, expenseInput("6000", "10.00", paidFrom), ctx, { skipChecks: true }), paidFrom).toThrow(UnbalancedPostingError);
    }
  });

  it("refuses zero, negative and empty expenses", () => {
    expect(() => post(expense, expenseInput("6000", "0", "1000"), ctx)).toThrow(/amount_positive/);
    expect(() => post(expense, expenseInput("6000", "-5.00", "1000"), ctx)).toThrow(/amount_positive/);
    expect(() => post(expense, { fields: { vendor: "", date: "2026-10-20", paidFrom: "1000", receiptRef: "" }, lines: [] }, ctx)).toThrow(/total_positive/);
  });

  it("property: any valid expense balances and touches only its categories and its paying side", () => {
    const line = fc.record({ account: fc.constantFrom(...CATEGORY_CODES), cents: fc.integer({ min: 1, max: 100_000_000 }) });
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), fc.constantFrom(...PAID_FROM), (ls, paidFrom) => {
        const doc: DocumentInput = {
          fields: { vendor: "v", date: "2026-10-20", paidFrom, receiptRef: "" },
          lines: ls.map((l) => ({ account: l.account, amount: (BigInt(l.cents) / 100n).toString() + "." + String(l.cents % 100).padStart(2, "0"), description: "" })),
        };
        const r = post(expense, doc, ctx);
        const total = ls.reduce((a, l) => a + BigInt(l.cents), 0n);
        expect(r.totalDebitCents).toBe(total);
        expect(r.totalCreditCents).toBe(total);
        for (const j of r.journal) expect([...ls.map((l) => l.account), paidFrom]).toContain(j.account);
      }),
      { numRuns: 200 },
    );
  });

  it("the compiler emits it and the dry run posts one expense per category and paying side", async () => {
    const r = await compile(mayaTestSpec(), { businessId: "maya-cookies", version: 2, prover: new StubProver(), roleLimits: TEST_ROLE_LIMITS });
    expect(r.config.documents.map((d) => d.id)).toContain("expense");
    const subjects = r.dryRun.cases.filter((c) => c.subject.startsWith("expense/"));
    expect(subjects).toHaveLength(CATEGORY_CODES.length * PAID_FROM.length);
    expect(subjects.every((c) => c.ok && !c.refused && c.debitCents === 100n && c.creditCents === 100n)).toBe(true);
    // a configuration from before expenses existed still dry-runs (no expense cases)
    const old = { ...fixture, documents: fixture.documents.filter((d) => d.id !== "expense") };
    const dr = dryRun(old);
    expect(dr.ok).toBe(true);
    expect(dr.cases.some((c) => c.subject.startsWith("expense/"))).toBe(false);
  });
});

// ---------- receipt reading (brain) ----------

class FakeLlm implements Llm {
  calls: ToolRequest[] = [];
  constructor(private readonly handler: (r: ToolRequest, n: number) => unknown) {}
  async tool(r: ToolRequest) {
    this.calls.push(r);
    return this.handler(r, this.calls.length);
  }
  async text() {
    return "";
  }
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4ec0000000049454e44ae426082", "hex");

function harness(llm: Llm | undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "napkin-expenses-"));
  const accounts = new AccountStore(dir);
  const receipts = new ReceiptStore(dir);
  const app = new Hono();
  const gate = businessGate(accounts);
  for (const p of GATED_PATHS) app.use(p, gate);
  let n = 0;
  app.route("/", expenseRoutes({ llm, receipts, newId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` }));
  const owner = accounts.create("sam@example.com", "correct horse", { id: "sams-tacos", name: "Sam's Tacos" });
  const other = accounts.create("eve@example.com", "correct horse", { id: "eves-pies", name: "Eve's Pies" });
  const token = (a: typeof owner) => accounts.newSession(a.id);
  const upload = async (businessId: string, tok: string | undefined, file: File | undefined = new File([PNG], "r.png", { type: "image/png" })) => {
    const fd = new FormData();
    fd.set("businessId", businessId);
    if (file) fd.set("image", file);
    const res = await app.request("/expenses/receipt", { method: "POST", body: fd, headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  return { app, dir, receipts, owner, other, token, upload };
}

describe("receipt value cleaning (exact decimals, never floats)", () => {
  it("cleanMoney keeps exact decimal text and refuses anything ambiguous", () => {
    expect(cleanMoney("42.17")).toBe("42.17");
    expect(cleanMoney("$1,234.5")).toBe("1234.50");
    expect(cleanMoney("7")).toBe("7.00");
    expect(cleanMoney("0.1")).toBe("0.10");
    expect(cleanMoney("12.345")).toBeUndefined(); // fractional cents
    expect(cleanMoney("1.234,56")).toBeUndefined(); // European format: ask the owner
    expect(cleanMoney("about 40")).toBeUndefined();
    expect(cleanMoney("-3.00")).toBeUndefined();
    expect(cleanMoney("-3.00", true)).toBe("-3.00");
    expect(cleanMoney("1e3")).toBeUndefined();
  });
  it("cleanDate accepts only real calendar dates", () => {
    expect(cleanDate("2026-10-20")).toBe("2026-10-20");
    expect(cleanDate("2026-02-30")).toBeUndefined();
    expect(cleanDate("10/20/2026")).toBeUndefined();
  });
  it("cleanReceipt drops invalid values instead of guessing, and checks items against the total exactly", () => {
    const r = cleanReceipt({ vendor: " Costco ", date: "2026-13-01", total: "60.10", tax: "0.01", category: "groceries", items: [{ description: "flour", amount: "40.10" }, { description: "propane", amount: "19.99" }], confidence: 3 });
    expect(r).toMatchObject({ vendor: "Costco", date: "", total: "60.10", tax: "0.01", category: "", confidence: 1, itemsMatchTotal: true });
    expect(r.dropped.join(" ")).toMatch(/date.*calendar date/);
    expect(r.dropped.join(" ")).toMatch(/category "groceries"/);
    const mismatch = cleanReceipt({ total: "10.00", items: [{ description: "a", amount: "3.00" }], confidence: 0.5 });
    expect(mismatch.itemsMatchTotal).toBe(false);
    expect(cleanReceipt({ total: "0", confidence: 0.5 }).total).toBe("");
    expect(cleanReceipt({ confidence: 0 })).toMatchObject({ vendor: "", date: "", total: "", category: "", items: [], itemsMatchTotal: null });
  });
});

describe("POST /expenses/receipt", () => {
  it("only the signed-in owner of that business may call it", async () => {
    const h = harness(new FakeLlm(() => ({ confidence: 0.9 })));
    expect((await h.upload("sams-tacos", undefined)).status).toBe(401);
    const wrong = await h.upload("sams-tacos", h.token(h.other));
    expect(wrong.status).toBe(403);
    expect((await h.upload("sams-tacos", h.token(h.owner))).status).toBe(200);
    // and GET of a stored receipt is gated the same way
    const get = (biz: string, tok?: string) => h.app.request(`/expenses/receipt?businessId=${biz}&ref=00000000-0000-4000-8000-000000000001.png`, { headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    expect((await get("sams-tacos")).status).toBe(401);
    expect((await get("sams-tacos", h.token(h.other))).status).toBe(403);
    expect((await get("eves-pies", h.token(h.other))).status).toBe(404); // Eve's own business has no such receipt
    const ok = await get("sams-tacos", h.token(h.owner));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await ok.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("reads the receipt with the vision model and returns cleaned pre-fill values; the image is stored under receipts/<businessId>", async () => {
    const llm = new FakeLlm(() => ({
      vendor: "PG&E",
      date: "2026-10-01",
      total: "$1,212.40",
      category: "utilities",
      items: [{ description: "electric", amount: "1,212.40" }],
      notes: "",
      confidence: 0.92,
    }));
    const h = harness(llm);
    const r = await h.upload("sams-tacos", h.token(h.owner));
    expect(r.status).toBe(200);
    expect(r.body.receiptRef).toBe("00000000-0000-4000-8000-000000000001.png");
    expect(r.body.read).toMatchObject({ vendor: "PG&E", date: "2026-10-01", total: "1212.40", category: "utilities", account: "6300", confidence: 0.92, itemsMatchTotal: true, dropped: [] });
    expect(r.body.readError).toBeUndefined();
    expect(fs.existsSync(path.join(h.dir, "receipts", "sams-tacos", r.body.receiptRef))).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(llm.calls[0]!.content[0]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(llm.calls[0]!.model).toBe("claude-opus-5-5");
  });

  it("leaves unreadable values empty (never guessed) and retries once on invalid output", async () => {
    const llm = new FakeLlm((_r, n) => (n === 1 ? { vendor: 7 } : { vendor: "Corner Store", total: "illegible", confidence: 0.3, notes: "total is smudged" }));
    const h = harness(llm);
    const r = await h.upload("sams-tacos", h.token(h.owner));
    expect(r.status).toBe(200);
    expect(llm.calls).toHaveLength(2);
    expect(r.body.read).toMatchObject({ vendor: "Corner Store", total: "", date: "", category: "", notes: "total is smudged" });
    expect(r.body.read.dropped[0]).toMatch(/total "illegible"/);
  });

  it("keeps the receipt and asks the owner to type the values when reading fails or no API key is set", async () => {
    const failing = harness(new FakeLlm(() => {
      throw new LlmUnavailable("model declined");
    }));
    const a = await failing.upload("sams-tacos", failing.token(failing.owner));
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ read: null, receiptRef: expect.stringMatching(/\.png$/) });
    expect(a.body.readError).toMatch(/couldn't read/);
    const noKey = harness(undefined);
    const b = await noKey.upload("sams-tacos", noKey.token(noKey.owner));
    expect(b.status).toBe(200);
    expect(b.body.read).toBeNull();
    expect(b.body.readError).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("validates the upload", async () => {
    const h = harness(new FakeLlm(() => ({ confidence: 1 })));
    const tok = h.token(h.owner);
    expect((await h.upload("sams-tacos", tok, null as unknown as undefined)).status).toBe(400);
    expect((await h.upload("sams-tacos", tok, new File(["x"], "r.pdf", { type: "application/pdf" }))).status).toBe(415);
    expect((await h.upload("sams-tacos", tok, new File([Buffer.alloc(5 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }))).status).toBe(413);
    const bad = await h.app.request("/expenses/receipt?businessId=sams-tacos&ref=../../accounts.json", { headers: { authorization: `Bearer ${tok}` } });
    expect(bad.status).toBe(400);
  });
});
