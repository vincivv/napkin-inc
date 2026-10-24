// Planted-error scorer. Deterministic and side-effect free: given the answer key and a bookkeeper's
// (or the reference auditor's) findings, returns precision and recall.
//
// Matching rule: a finding matches an answer-key error when the kinds are equal AND they name at least
// one common document id in `entries`. Matching is one-to-one (a finding can match only one key error,
// and a key error is matched at most once), computed as a maximum bipartite matching so a greedy order
// cannot under-count.
//
// Edge cases (fixed, documented in README):
//   no findings and no errors  -> precision 1, recall 1
//   findings but no errors     -> precision 0, recall 1
//   errors but no findings     -> precision 1, recall 0   (nothing claimed, nothing wrong, everything missed)

import type { Finding, PlantedError } from "./types.ts";

export interface PlantedScore {
  errors: number;
  findings: number;
  truePositives: number;
  precision: number;
  recall: number;
  /** answer-key ids with no matching finding, in answer-key order */
  missed: string[];
  /** answer-key id -> index into findings */
  matches: Record<string, number>;
}

function compatible(err: Pick<PlantedError, "kind" | "entries">, f: Finding): boolean {
  if (err.kind !== f.kind) return false;
  return f.entries.some((e) => err.entries.includes(e));
}

export function scorePlanted(key: readonly PlantedError[], findings: readonly Finding[]): PlantedScore {
  // Kuhn's augmenting-path maximum matching: left = key errors, right = findings.
  const matchOfFinding = new Array<number>(findings.length).fill(-1);
  const matchOfError = new Array<number>(key.length).fill(-1);

  const tryAugment = (i: number, seen: boolean[]): boolean => {
    for (let j = 0; j < findings.length; j++) {
      if (seen[j]) continue;
      if (!compatible(key[i]!, findings[j]!)) continue;
      seen[j] = true;
      const cur = matchOfFinding[j]!;
      if (cur === -1 || tryAugment(cur, seen)) {
        matchOfFinding[j] = i;
        matchOfError[i] = j;
        return true;
      }
    }
    return false;
  };

  for (let i = 0; i < key.length; i++) tryAugment(i, new Array<boolean>(findings.length).fill(false));

  const truePositives = matchOfError.filter((j) => j !== -1).length;
  const errors = key.length;
  const nFindings = findings.length;

  // no findings: nothing was claimed, so nothing is wrong (precision 1); recall still reflects misses
  const precision = nFindings === 0 ? 1 : truePositives / nFindings;
  const recall = errors === 0 ? 1 : truePositives / errors;

  const missed: string[] = [];
  const matches: Record<string, number> = {};
  key.forEach((err, i) => {
    const j = matchOfError[i]!;
    if (j === -1) missed.push(err.id);
    else matches[err.id] = j;
  });

  return { errors, findings: nFindings, truePositives, precision, recall, missed, matches };
}
