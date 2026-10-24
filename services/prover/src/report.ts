// proveConfiguration: every proof the compiler gates on, as a packages/schema ProofReport.

import type { Configuration, ProofReport } from "@napkin/schema";
import { proveBalance } from "./balance";
import { proveDiscountStacking } from "./discount";
import { flowCheck } from "./flow";
import type { ProofResult, ProveOptions } from "./types";
import { solverName } from "./z3";

export interface ConfigurationProofOptions extends ProveOptions {
  /** lines from synthesis (or the compiler) to carry into the report */
  synthesisLog?: string[];
}

export async function proveConfiguration(cfg: Configuration, opts: ConfigurationProofOptions = {}): Promise<ProofReport> {
  const t0 = performance.now();
  const log: string[] = [...(opts.synthesisLog ?? [])];
  const o: ProveOptions = { ...opts, log };

  const bt0 = performance.now();
  const parts: ProofResult[] = [];
  for (const d of cfg.documents) parts.push(await proveBalance(cfg, d.id, o));
  const balanceProof: ProofResult = {
    status: parts.some((p) => p.status === "failed") ? "failed" : parts.length ? "proved" : "skipped",
    durationMs: Math.round(performance.now() - bt0),
    details: parts.flatMap((p) => p.details.map((d) => ({ ...d, message: d.message ? `${d.message} [${p.durationMs} ms]` : d.message }))),
  };
  const discountProof = await proveDiscountStacking(cfg, o);
  const flow = flowCheck(cfg, o);
  const solver = await solverName();
  log.push(`proofs: balance ${balanceProof.status} (${balanceProof.durationMs} ms), discount ${discountProof.status} (${discountProof.durationMs} ms), flow ${flow.status} (${flow.durationMs} ms); total ${Math.round(performance.now() - t0)} ms on ${solver}`);
  return { balanceProof, discountProof, flowCheck: flow, synthesisLog: log, generatedAt: new Date().toISOString(), solver };
}
