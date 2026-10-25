import { describe, expect, it } from "vitest";
import type { BookDoc, BookSet } from "../src/agents/books";
import { buildSystemPrompt } from "../src/agents/prompt";
import { BookkeeperReview, reviewConfigFromEnv, ReviewScheduler, type ReviewOutcome } from "../src/agents/review";
import type { StaffRole } from "../src/agents/types";
import { cfg, FakeBackend, FakeGuardPort } from "./agents.fakes";

const BIZ = "maya-cookies";

const doc = (o: Partial<BookDoc> & { id: string }): BookDoc => ({
  docType: "sale",
  status: "posted",
  period: "2026-10",
  createdBy: "storefront",
  approvedBy: "system",
  externalRef: "",
  fields: {},
  lines: [],
  journal: [],
  movements: [],
  reversalOf: null,
  note: "",
  ...o,
});

const stockIn = (qty: number) => ({ register: "stock", dims: { item: "choc_chip_cookie" }, kind: "in" as const, qty, amountCents: 0 });
const stockOut = (qty: number) => ({ register: "stock", dims: { item: "choc_chip_cookie" }, kind: "out" as const, qty, amountCents: 0 });

const CLEAN: BookSet = {
  label: "test books",
  periods: [{ month: "2026-10", status: "open" }],
  processorStatement: [],
  statementSource: "test",
  documents: [
    doc({ id: "11", docType: "opening_balance", postedAt: "2026-10-01T00:00:00Z", journal: [{ account: "1300", debitCents: 960, creditCents: 0 }, { account: "3000", debitCents: 0, creditCents: 960 }], movements: [stockIn(12)] }),
    doc({ id: "12", postedAt: "2026-10-02T00:00:00Z", journal: [{ account: "1200", debitCents: 1500, creditCents: 0 }, { account: "4000", debitCents: 0, creditCents: 1500 }], movements: [stockOut(6)] }),
  ],
};

/** two problems: stock below zero after doc 13, and doc 14 does not balance */
const BROKEN: BookSet = {
  ...CLEAN,
  documents: [
    ...CLEAN.documents,
    doc({ id: "13", postedAt: "2026-10-03T00:00:00Z", journal: [{ account: "1200", debitCents: 3000, creditCents: 0 }, { account: "4000", debitCents: 0, creditCents: 3000 }], movements: [stockOut(12)] }),
    doc({ id: "14", postedAt: "2026-10-04T00:00:00Z", journal: [{ account: "1000", debitCents: 4000, creditCents: 0 }, { account: "4000", debitCents: 0, creditCents: 3800 }] }),
  ],
};

/** FakeBackend that keeps inbox items (with their contextJson) and can list the open ones */
class InboxBackend extends FakeBackend {
  items: { question: string; contextJson: string }[] = [];
  override async openInbox(role: StaffRole, b: string, i: { question: string; documentRef: string; contextJson: string }) {
    await super.openInbox(role, b, i);
    this.items.push({ question: i.question, contextJson: i.contextJson });
  }
  async openInboxItems() {
    return this.items;
  }
}

function setup(books: BookSet, backend: FakeBackend = new FakeBackend()) {
  const guardPort = new FakeGuardPort();
  backend.books_ = books;
  return { guardPort, backend, review: new BookkeeperReview({ guardPort, backend }) };
}
const inbox = (b: FakeBackend) => b.mutations.filter((m) => m.kind === "inbox") as { kind: "inbox"; role: StaffRole; question: string }[];

describe("automatic bookkeeper review", () => {
  it("findings open ONE owner inbox item through the guarded escalate, worded for the owner", async () => {
    const { guardPort, backend, review } = setup(BROKEN);
    const r = await review.review(BIZ);
    expect(r.status).toBe("reported");

    const items = inbox(backend);
    expect(items).toHaveLength(1);
    expect(items[0]!.role).toBe("bookkeeper");
    const lines = items[0]!.question.split("\n");
    expect(lines[0]).toMatch(/^My automatic check of the books found 2 things that need your attention\.$/);
    expect(lines[1]).toMatch(/^1\. \[doc 14\] \(a sale\) does not add up: its two sides are \$40\.00 and \$38\.00/);
    expect(lines[2]).toMatch(/^2\. Chocolate chip cookie \(baked\) stock is below zero: the books show -6 left after \[doc 13\]/);
    expect(lines[2]).toContain("each Box of 6 sale takes 6 from it");
    expect(lines.at(-1)).toMatch(/^What to do: /);
    // no account numbers, no field names
    expect(items[0]!.question).not.toMatch(/\b(1000|1010|1200|1300|4000)\b|account \d|stockUnits|stockItem|choc_chip_cookie/);

    // the guard ran and wrote exactly one DecisionRecord for it, as the bookkeeper
    expect(guardPort.decisions).toHaveLength(1);
    expect(guardPort.decisions[0]).toMatchObject({ asRole: "bookkeeper", d: { businessId: BIZ, action: "escalate", outcome: "allowed", documentRef: "14" } });
    expect(guardPort.decisions[0]!.d.evidenceRefs).toContain("provenance:agent");
  });

  it("the same findings a second time open nothing (and write no new DecisionRecord)", async () => {
    const { guardPort, backend, review } = setup(BROKEN);
    expect((await review.review(BIZ)).status).toBe("reported");
    const again = await review.review(BIZ);
    expect(again.status).toBe("duplicate");
    expect(inbox(backend)).toHaveLength(1);
    expect(guardPort.decisions).toHaveLength(1);
  });

  it("after a restart (no memory), an open inbox item with the same findings still counts as reported", async () => {
    const backend = new InboxBackend();
    const first = setup(BROKEN, backend);
    expect((await first.review.review(BIZ)).status).toBe("reported");
    const restarted = new BookkeeperReview({ guardPort: first.guardPort, backend });
    expect((await restarted.review(BIZ)).status).toBe("duplicate");
    expect(inbox(backend)).toHaveLength(1);
  });

  it("new findings on top of reported ones open a new item", async () => {
    const { backend, review } = setup(BROKEN);
    await review.review(BIZ);
    backend.books_ = { ...BROKEN, documents: [...BROKEN.documents, doc({ id: "15", postedAt: "2026-10-05T00:00:00Z", journal: [{ account: "1000", debitCents: 100, creditCents: 0 }] })] };
    expect((await review.review(BIZ)).status).toBe("reported");
    expect(inbox(backend)).toHaveLength(2);
    expect(inbox(backend)[1]!.question).toContain("[doc 15]");
  });

  it("no findings opens nothing and writes no DecisionRecord", async () => {
    const { guardPort, backend, review } = setup(CLEAN);
    expect(await review.review(BIZ)).toEqual({ status: "clean" });
    expect(inbox(backend)).toHaveLength(0);
    expect(guardPort.decisions).toHaveLength(0);
  });

  it("skips a business without an active configuration or bookkeeper identity", async () => {
    const a = setup(BROKEN);
    a.guardPort.config = undefined;
    expect((await a.review.review(BIZ)).status).toBe("skipped");
    const b = setup(BROKEN);
    b.backend.identity = () => undefined as unknown as string;
    expect((await b.review.review(BIZ)).status).toBe("skipped");
    expect(inbox(a.backend).length + inbox(b.backend).length).toBe(0);
  });
});

describe("review scheduling", () => {
  it("is off under vitest unless turned on; env sets the interval, delay and debounce", () => {
    expect(reviewConfigFromEnv({ VITEST: "true" }).enabled).toBe(false);
    const c = reviewConfigFromEnv({ VITEST: "true", BOOKKEEPER_REVIEW: "on", BOOKKEEPER_REVIEW_INTERVAL_HOURS: "1", BOOKKEEPER_REVIEW_INITIAL_DELAY_SECONDS: "5", BOOKKEEPER_REVIEW_DEBOUNCE_SECONDS: "60" });
    expect(c).toMatchObject({ enabled: true, intervalMs: 3_600_000, initialDelayMs: 5000, debounceMs: 60_000 });
    expect(reviewConfigFromEnv({}).enabled).toBe(true);
    expect(reviewConfigFromEnv({ BOOKKEEPER_REVIEW: "off" }).enabled).toBe(false);
    expect(reviewConfigFromEnv({ BOOKKEEPER_REVIEW_INTERVAL_HOURS: "soon" }).intervalMs).toBe(6 * 3_600_000);
  });

  it("reviews a business once it has been quiet for the debounce after new documents; errors are logged, not thrown", async () => {
    let now = 0;
    let sig = "2:12";
    const runs: string[] = [];
    const s = new ReviewScheduler(
      {
        review: async (id): Promise<ReviewOutcome> => {
          runs.push(id);
          if (id === "bad") throw new Error("platform down");
          return { status: "clean" };
        },
        businesses: () => ["maya-cookies", "bad"],
        signature: () => sig,
        now: () => now,
      },
      { enabled: true, intervalMs: 0, initialDelayMs: 0, debounceMs: 120_000, pollMs: 30_000 },
    );
    await s.poll(); // first sight: nothing
    expect(runs).toEqual([]);
    sig = "3:13";
    now = 10_000;
    await s.poll(); // change seen
    now = 60_000;
    sig = "4:14";
    await s.poll(); // another change restarts the quiet time
    now = 150_000;
    await s.poll();
    expect(runs).toEqual([]);
    now = 180_000;
    await expect(s.poll()).resolves.toBeUndefined();
    expect(runs).toEqual(["maya-cookies", "bad"]);
    now = 400_000;
    await s.poll(); // nothing new: no further review
    expect(runs).toHaveLength(2);
  });
});

describe("bookkeeper prompt", () => {
  it("names the accounts and tells the bookkeeper how to write to the owner", () => {
    const p = buildSystemPrompt(cfg, "bookkeeper", []);
    expect(p).toContain("- 1000: Cash (bank)");
    expect(p).toMatch(/ONE escalate call per answer/);
    expect(p).toMatch(/numbered points/);
    expect(buildSystemPrompt(cfg, "shopkeeper", [])).not.toContain("Writing to the owner");
  });
});

describe("automatic review: cash below zero", () => {
  it("reports Cash below zero once, naming the documents that paid out of it", async () => {
    const { reviewFindings } = await import("../src/agents/review");
    const books: BookSet = {
      ...CLEAN,
      documents: [
        ...CLEAN.documents,
        doc({ id: "15", docType: "expense", postedAt: "2026-10-05T00:00:00Z", journal: [{ account: "6000", debitCents: 90000, creditCents: 0 }, { account: "1000", debitCents: 0, creditCents: 90000 }] }),
      ],
    };
    const fs = reviewFindings(books, cfg).filter((f) => f.key === "cash:negative");
    expect(fs).toHaveLength(1);
    expect(fs[0]!.docs).toEqual(["15"]);
    expect(fs[0]!.text).toMatch(/-\$900\.00/);
    expect(fs[0]!.text).not.toMatch(/1000/);
    expect(reviewFindings(CLEAN, cfg).some((f) => f.key === "cash:negative")).toBe(false);
  });
});

