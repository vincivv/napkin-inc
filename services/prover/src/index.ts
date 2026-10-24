export { encode, encodeNum, encodeBool, round2Term, realVal, rationalOf, type EncodeScope, type ZTerm } from "./encode";
export { proveBalance } from "./balance";
export { getZ3, shutdown, solverName } from "./z3";
export { buildSymbolicDoc, inferCatalogBindings, DEFAULT_BOUNDS, type Bounds, type CatalogBinding } from "./symbolic";
export type { ProofResult, ProofDetail, ProverDetail, ProveOptions } from "./types";
