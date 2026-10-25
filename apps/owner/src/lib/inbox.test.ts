import { describe, expect, it } from "vitest";
import { FALLBACK_HEADLINE, groupKey, humanize, isBooksReview, parseQuestion, similarityKey, splitDocRefs } from "./inbox";

const weekly =
  "Weekly review found oddities. (1) Sales [doc 6] and [doc 9] each deducted 20 stock units for 1 burrito (stockUnits=20). (2) Cash account 1000 is at -$920.00 after [doc 13] and rent $900 [doc 15]. Please confirm or advise.";

describe("parseQuestion", () => {
  it("splits inline (1) (2) points and drops the sign-off", () => {
    const p = parseQuestion(weekly);
    expect(p.headline).toBe("Weekly review found oddities.");
    expect(p.points).toHaveLength(2);
    expect(p.points[0]).toMatch(/^Sales \[doc 6\]/);
    expect(p.points[1]).toBe("Cash account 1000 is at -$920.00 after [doc 13] and rent $900 [doc 15].");
  });

  it("splits newline 1. 2. points", () => {
    const p = parseQuestion("Two things:\n1. Rent looks doubled.\n2. Stripe fees missing\n   for March.\nPlease advise.");
    expect(p.headline).toBe("Two things");
    expect(p.points).toEqual(["Rent looks doubled.", "Stripe fees missing for March."]);
  });

  it("falls back when there is no intro", () => {
    expect(parseQuestion("(1) a (2) b").headline).toBe(FALLBACK_HEADLINE);
  });

  it("keeps a short plain question as the headline", () => {
    const p = parseQuestion("Refund or offer a free cookie next time?");
    expect(p).toEqual({ headline: "Refund or offer a free cookie next time?", points: [], body: "" });
  });

  it("does not treat a lone (1) or out-of-order numbers as a list", () => {
    expect(parseQuestion("Use option (1) please?").points).toEqual([]);
    expect(parseQuestion("See (2) and (3).").points).toEqual([]);
  });
});

describe("humanize", () => {
  const names = (c: string) => ({ "1000": "Cash", "1200": "Accounts receivable" })[c];
  it("names accounts and stock units", () => {
    expect(humanize("Cash account 1000 is low", names)).toBe("Cash is low");
    expect(humanize("moved to account 1200", names)).toBe("moved to Accounts receivable");
    expect(humanize("a account 1200", names)).toBe("a Accounts receivable");
    expect(humanize("account 9999 is odd", names)).toBe("account 9999 is odd");
    expect(humanize("for 1 burrito (stockUnits=20).", names)).toBe("for 1 burrito (uses 20 per sale).");
  });
});

describe("splitDocRefs", () => {
  it("finds single and grouped refs", () => {
    expect(splitDocRefs("Sales [doc 6] and [docs 9, 10]")).toEqual([{ text: "Sales " }, { doc: "6" }, { text: " and " }, { doc: "9" }, { text: " and " }, { doc: "10" }]);
  });
});

describe("similarityKey", () => {
  it("matches the same review with different numbers", () => {
    const other = weekly.replace("-$920.00", "-$1,020.00").replace("[doc 13]", "[doc 21]");
    expect(similarityKey("bookkeeper", other)).toBe(similarityKey("bookkeeper", weekly));
    expect(similarityKey("shopkeeper", weekly)).not.toBe(similarityKey("bookkeeper", weekly));
  });
});

describe("automatic review format", () => {
  it("one numbered point plus a What to do line", () => {
    const q = parseQuestion("My automatic check of the books found one thing that needs your attention.\n1. Cash is at -$105.00: [doc 3] paid $105.00 out of it.\nWhat to do: open each document named above and reply here when done.");
    expect(q.headline).toBe("My automatic check of the books found one thing that needs your attention.");
    expect(q.points).toEqual(["Cash is at -$105.00: [doc 3] paid $105.00 out of it."]);
    expect(q.todo).toBe("open each document named above and reply here when done.");
  });
});


describe("books reviews", () => {
  const auto = "My automatic check of the books found one thing that needs your attention.\n1. Cash is at -$920.00: [doc 15] paid $900.00 out of it.";
  const autoCtx = JSON.stringify({ tool: "escalate", source: "bookkeeper_review" });

  it("spots the automatic check by its tag and any bookkeeper list of two or more issues", () => {
    expect(isBooksReview("bookkeeper", auto, autoCtx)).toBe(true);
    expect(isBooksReview("bookkeeper", weekly, "{}")).toBe(true);
    expect(isBooksReview("bookkeeper", "Should I refund order 12?", "{}")).toBe(false);
    expect(isBooksReview("shopkeeper", weekly, "{}")).toBe(false);
    expect(isBooksReview("bookkeeper", "Should I refund order 12?", "not json")).toBe(false);
  });

  it("gives differently worded reviews one group, and leaves other questions apart", () => {
    expect(groupKey("bookkeeper", auto, autoCtx)).toBe(groupKey("bookkeeper", weekly, "{}"));
    expect(groupKey("bookkeeper", "Should I refund order 12?", "{}")).not.toBe(groupKey("bookkeeper", weekly, "{}"));
  });
});
