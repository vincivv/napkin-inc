// Typed refusals of the compiler. Every refusal that the owner can resolve carries OpenQuestions
// (packages/schema) so the question engine can ask them; the compiler never fills a gap itself.

import type { OpenQuestion } from "@napkin/schema";

export interface FactIssue {
  /** path inside the BusinessSpec, e.g. "offerings[cookie].variants[box6].cost" */
  path: string;
  problem: "inferred" | "unconfirmed" | "missing" | "invalid";
  detail: string;
  value?: unknown;
}

export class CompileRefused extends Error {
  override name = "CompileRefused";
  constructor(
    readonly code: "unconfirmed_money_facts" | "needs_owner_answer" | "invalid_configuration" | "dry_run_failed" | "proof_failed" | "money_changed_after_proof",
    message: string,
    readonly questions: OpenQuestion[] = [],
  ) {
    super(message);
  }
}

/** (a) Money-relevant facts that are inferred, unconfirmed, missing or malformed. No defaults are invented. */
export class UnconfirmedMoneyFacts extends CompileRefused {
  override name = "UnconfirmedMoneyFacts";
  constructor(readonly fields: FactIssue[]) {
    super(
      "unconfirmed_money_facts",
      `refusing to compile: ${fields.length} money-relevant fact(s) are not owner-confirmed: ${fields.map((f) => `${f.path} (${f.problem})`).join(", ")}`,
      fields.map((f) => factQuestion(f)),
    );
  }
}

/** The owner has to decide something (ambiguous synthesis, inconsistent facts, a price below the floor...). */
export class NeedsOwnerAnswer extends CompileRefused {
  override name = "NeedsOwnerAnswer";
  constructor(message: string, questions: OpenQuestion[]) {
    super("needs_owner_answer", message, questions);
  }
}

export function questionId(fieldPath: string, prefix = "q"): string {
  const slug = fieldPath.replace(/[^A-Za-z0-9_.:@-]+/g, "_").replace(/_+/g, "_").slice(0, 100);
  return `${prefix}:${slug}`;
}

function factQuestion(f: FactIssue): OpenQuestion {
  const what =
    f.problem === "missing" ? "is missing" : f.problem === "inferred" ? `was inferred (${JSON.stringify(f.value)}), not stated by you` : f.problem === "unconfirmed" ? `(${JSON.stringify(f.value)}) is not confirmed yet` : `is not valid: ${f.detail}`;
  return {
    id: questionId(f.path, "compile"),
    fieldPath: f.path,
    question: `Before money can move: ${f.path} ${what}. What is the right value?`,
    impactScore: 1,
    moneyRelevant: true,
    status: "open",
  };
}

export function ownerQuestion(fieldPath: string, question: string, candidates?: string[]): OpenQuestion {
  return { id: questionId(fieldPath, "compile"), fieldPath, question, impactScore: 1, moneyRelevant: true, status: "open", ...(candidates?.length ? { candidates } : {}) };
}
