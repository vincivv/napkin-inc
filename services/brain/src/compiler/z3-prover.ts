// ProverPort over services/prover (Z3, deterministic, no LLM). proveConfiguration is the real proof:
// balance per document type, discount stacking vs the margin floor (and D4 refunds), and the flow check.
//
// Synthesis: services/prover synthesizes one EXPRESSION from scalar examples (vocabulary -> output);
// the spec's worked examples are document-level (free-form inputs -> postings per account), and there is
// no agreed mapping between the two yet. Rather than guess one, this adapter reports synthesis as
// "skipped" and the compiler's deterministic example check (checkSaleExamples) still runs.

import { proveConfiguration } from "@napkin/prover";
import type { Configuration, ProofReport } from "@napkin/schema";
import type { ProverPort, SynthesisRequest, SynthesisResult } from "./prover-port";

export class Z3Prover implements ProverPort {
  readonly isStub = false;
  /** the ProofReport carries the exact solver version (services/prover solverName) */
  readonly name = "z3-solver (services/prover)";

  async synthesizePostingRule(req: SynthesisRequest): Promise<SynthesisResult> {
    return {
      status: "skipped",
      reason: `synthesis for ${req.docType} not run: document-level examples are not mapped to the prover's expression synthesis yet; examples are checked deterministically against the template rules`,
      log: [],
    };
  }

  proveConfiguration(cfg: Configuration): Promise<ProofReport> {
    return proveConfiguration(cfg);
  }
}
