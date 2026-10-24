// The compiler's view of the Z3 prover. Z3Prover (z3-prover.ts) implements it over services/prover;
// StubProver is the labelled fallback (COMPILE_PROVER=stub, and unit tests): EVERY result it returns says
// "skipped" with a STUB label, so nothing downstream can mistake it for a proof.

import type { Configuration, DocumentType, OpenQuestion, ProofReport } from "@napkin/schema";
import type { BusinessSpec } from "@napkin/schema";

export type PostingRule = DocumentType["postingRules"][number];
export type SpecExample = BusinessSpec["examples"][number];

export interface SynthesisRequest {
  /** document type the examples are about ("sale" | "refund" | "stock_receipt") */
  docType: string;
  /** the template's definition of that document (fields, derived fields, accounts available) */
  definition: DocumentType;
  /** owner-provided worked examples (inputs + expected postings) */
  examples: SpecExample[];
  chartOfAccounts: Configuration["chartOfAccounts"];
  policies: Configuration["policies"];
}

export type SynthesisResult =
  /** exactly one rule set (up to equivalence) reproduces every example */
  | { status: "synthesized"; rules: PostingRule[]; log: string[] }
  /** several inequivalent rule sets fit the examples; the question tells them apart */
  | { status: "ambiguous"; question: Pick<OpenQuestion, "fieldPath" | "question" | "candidates">; log: string[] }
  /** no rule in the search space fits the examples (they may contradict each other) */
  | { status: "no_solution"; reason: string; log: string[] }
  /** synthesis did not run (stub, or disabled); the template rules are used unchanged */
  | { status: "skipped"; reason: string; log: string[] };

export interface ProverPort {
  /** shown in logs and the proof report, e.g. "z3-solver 5.3.1" or "STUB (no prover wired)" */
  readonly name: string;
  readonly isStub: boolean;
  synthesizePostingRule(req: SynthesisRequest): Promise<SynthesisResult>;
  /** balance proof, discount/margin proof and flow check for a whole configuration */
  proveConfiguration(cfg: Configuration): Promise<ProofReport>;
}

export const STUB_LABEL = "STUB: the Z3 prover is not wired into this build; nothing was proven";

/** Placeholder until services/prover lands. Never claims "proved". */
export class StubProver implements ProverPort {
  readonly name = "STUB (no prover wired)";
  readonly isStub = true;

  async synthesizePostingRule(req: SynthesisRequest): Promise<SynthesisResult> {
    return {
      status: "skipped",
      reason: `${STUB_LABEL}. ${req.examples.length} example(s) for "${req.docType}" were not used for synthesis; template rules kept.`,
      log: [`synthesis(${req.docType}): SKIPPED (stub)`],
    };
  }

  async proveConfiguration(_cfg: Configuration): Promise<ProofReport> {
    const skipped = { status: "skipped" as const, details: [] };
    return {
      balanceProof: skipped,
      discountProof: skipped,
      flowCheck: skipped,
      synthesisLog: [STUB_LABEL],
      generatedAt: new Date().toISOString(),
      solver: this.name,
    };
  }
}

/** True if any proof (top level or detail) failed. Such a configuration is never emitted. */
export function proofFailed(r: ProofReport): string | undefined {
  for (const key of ["balanceProof", "discountProof", "flowCheck"] as const) {
    const p = r[key];
    if (p.status === "failed") return `${key} failed`;
    const d = p.details.find((x) => x.status === "failed");
    if (d) return `${key} failed for ${d.subject}${d.message ? `: ${d.message}` : ""}`;
  }
  return undefined;
}
