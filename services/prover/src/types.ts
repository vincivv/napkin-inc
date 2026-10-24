import type { PostingRule as LcPostingRule } from "@napkin/ledger-core";
import type { ProofReport } from "@napkin/schema";
import type { Bounds, CatalogBinding } from "./symbolic";

export type ProofResult = ProofReport["balanceProof"];
export type ProofDetail = ProofResult["details"][number];

/** A detail with extra machine-readable fields (dropped by the zod ProofReport parse, harmless). */
export type ProverDetail = ProofDetail & {
  /** the posting rule the prover suggests adding, when it verified that the rule fixes the proof */
  suggestedRule?: LcPostingRule;
  /** debits - credits in dollars (exact), for balance failures */
  imbalance?: string;
  /** number of document lines in the counterexample */
  lines?: number;
  /** "free" = line values unconstrained; "bound" = line values taken from the catalog */
  mode?: "free" | "bound";
};

export interface ProveOptions {
  bounds?: Partial<Bounds>;
  /** per Z3 check() call; a timeout is reported as a failure, never as proved */
  timeoutMs?: number;
  /** override the inferred line-field <- catalog-field bindings */
  bindings?: CatalogBinding[];
  /** try to synthesize and verify a fix for failures (default true) */
  suggestFixes?: boolean;
  /** override numeric policies (used to verify suggested fixes) */
  policyOverrides?: Record<string, import("@napkin/ledger-core").Rational>;
  /** collect log lines */
  log?: string[];
}

export const DEFAULT_TIMEOUT_MS = 10_000;
/** free-mode (unbound line values) queries are an optimisation for documents with lines */
export const FREE_TIMEOUT_MS = 1_500;
