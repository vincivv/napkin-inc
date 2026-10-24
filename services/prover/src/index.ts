export {
  encode,
  encodeValue,
  encodeNum,
  encodeBool,
  round2Term,
  round2NV,
  realVal,
  rationalOf,
  evalNV,
  toReal,
  constNV,
  intNV,
  realNV,
  type EncodeScope,
  type ScopeValue,
  type NV,
  type ZTerm,
} from "./encode";
export { proveBalance } from "./balance";
export { proveDiscountStacking } from "./discount";
export { flowCheck } from "./flow";
export { synthesizePostingRule, type SynthesisRequest, type SynthesisResult, type SynthExample, type SynthCandidate, type VocabType } from "./synth";
export { proveConfiguration, type ConfigurationProofOptions } from "./report";
export { getZ3, shutdown, solverName } from "./z3";
export { buildSymbolicDoc, inferCatalogBindings, entryCombos, DEFAULT_BOUNDS, type Bounds, type CatalogBinding } from "./symbolic";
export type { ProofResult, ProofDetail, ProverDetail, ProveOptions } from "./types";
