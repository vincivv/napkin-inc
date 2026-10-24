// Flow check: structural properties of the chart of accounts and registers (no solver needed).
//   1. every account / register a posting rule references exists, and rule sides fit the target
//   2. every document type with account rules has at least one debit and one credit rule
//   3. pass-through accounts (receivables, clearing, suspense, in-transit) that are debited
//      somewhere are also credited somewhere, so money that lands there can leave
//   4. every register that may not go negative has an "in" source
// Other one-way accounts (e.g. payables never debited) are reported as notes, not failures.

import type { Configuration } from "@napkin/schema";
import type { ProofResult, ProveOptions, ProverDetail } from "./types";

const PASS_THROUGH = /receivable|clearing|suspense|in[- ]transit|undeposited/i;

export function flowCheck(cfg: Configuration, opts: Pick<ProveOptions, "log"> = {}): ProofResult {
  const t0 = performance.now();
  const details: ProverDetail[] = [];
  const accounts = new Map(cfg.chartOfAccounts.map((a) => [a.code, a]));
  const registers = new Map(cfg.registers.map((r) => [r.id, r]));
  const debited = new Map<string, string[]>();
  const credited = new Map<string, string[]>();
  const sourcesIn = new Map<string, string[]>();
  const push = (m: Map<string, string[]>, k: string, v: string) => m.set(k, [...(m.get(k) ?? []), v]);

  // 1. references and sides
  const refProblems: string[] = [];
  for (const d of cfg.documents) {
    for (const r of d.postingRules) {
      if (r.target.kind === "account") {
        if (!accounts.has(r.target.code)) refProblems.push(`${d.id}: rule ${r.id} posts to account ${r.target.code}, which is not in the chart of accounts`);
        if (r.side === "debit") push(debited, r.target.code, `${d.id}/${r.id}`);
        else if (r.side === "credit") push(credited, r.target.code, `${d.id}/${r.id}`);
        else refProblems.push(`${d.id}: rule ${r.id} posts to an account with side "${r.side}" (must be debit or credit)`);
      } else {
        if (!registers.has(r.target.id)) refProblems.push(`${d.id}: rule ${r.id} moves register ${r.target.id}, which is not defined`);
        if (r.side === "in") push(sourcesIn, r.target.id, `${d.id}/${r.id}`);
        else if (r.side !== "out") refProblems.push(`${d.id}: rule ${r.id} moves a register with side "${r.side}" (must be in or out)`);
        const reg = registers.get(r.target.id);
        if (reg) for (const dim of Object.keys(r.target.dims ?? {})) if (!reg.dimensions.includes(dim)) refProblems.push(`${d.id}: rule ${r.id} uses dimension "${dim}" not declared on register ${reg.id}`);
      }
    }
  }
  details.push(
    refProblems.length
      ? { subject: "flow/references", status: "failed", message: refProblems.join("; "), suggestedFix: "Add the missing accounts/registers to the configuration, or point the rules at existing ones." }
      : { subject: "flow/references", status: "proved", message: `all ${cfg.documents.reduce((n, d) => n + d.postingRules.length, 0)} posting rules reference existing accounts and registers with valid sides.` },
  );

  // 2. every doc with account rules has a debit and a credit
  for (const d of cfg.documents) {
    const acct = d.postingRules.filter((r) => r.target.kind === "account");
    if (!acct.length) continue;
    const hasD = acct.some((r) => r.side === "debit");
    const hasC = acct.some((r) => r.side === "credit");
    if (!hasD || !hasC)
      details.push({
        subject: `flow/${d.id}`,
        status: "failed",
        message: `${d.id} has account rules but no ${hasD ? "credit" : "debit"} rule, so it can never balance.`,
        suggestedFix: `Add a ${hasD ? "credit" : "debit"} rule to ${d.id}.`,
      });
  }
  if (!details.some((x) => x.subject.startsWith("flow/") && x.subject !== "flow/references" && x.status === "failed"))
    details.push({ subject: "flow/double_entry", status: "proved", message: "every document type that posts to accounts has at least one debit and one credit rule." });

  // 3. pass-through accounts must be emptied somewhere
  const stuck: string[] = [];
  const notes: string[] = [];
  for (const a of cfg.chartOfAccounts) {
    const d = debited.get(a.code);
    const c = credited.get(a.code);
    if (d && !c && PASS_THROUGH.test(a.name)) stuck.push(`${a.code} ${a.name} is debited by ${d.join(", ")} but never credited`);
    else if (c && !d && PASS_THROUGH.test(a.name)) stuck.push(`${a.code} ${a.name} is credited by ${c.join(", ")} but never debited`);
    else if (c && !d && a.type === "liability") notes.push(`${a.code} ${a.name} is credited but never debited (no document settles it yet)`);
    else if (d && !c && a.type === "asset" && !PASS_THROUGH.test(a.name)) notes.push(`${a.code} ${a.name} is debited but never credited`);
  }
  details.push(
    stuck.length
      ? { subject: "flow/pass_through", status: "failed", message: stuck.join("; "), suggestedFix: "Add the document that clears the account (e.g. a payment that credits receivables, or a payout that credits clearing)." }
      : { subject: "flow/pass_through", status: "proved", message: "every receivable/clearing account that is debited is also credited somewhere." },
  );

  // 4. non-negative registers need an inflow
  const dry = cfg.registers.filter((r) => !r.allowNegative && !sourcesIn.has(r.id));
  details.push(
    dry.length
      ? { subject: "flow/registers", status: "failed", message: dry.map((r) => `register ${r.id} may not go negative but nothing moves stock in`).join("; "), suggestedFix: "Add an \"in\" rule (stock receipt or opening balance) for these registers." }
      : { subject: "flow/registers", status: "proved", message: `every non-negative register has an "in" source (${cfg.registers.filter((r) => !r.allowNegative).map((r) => `${r.id}: ${sourcesIn.get(r.id)!.join(", ")}`).join("; ") || "none"}).` },
  );

  for (const n of notes) opts.log?.push(`flow note: ${n}`);
  const failed = details.some((d) => d.status === "failed");
  opts.log?.push(`flow check: ${failed ? "FAILED" : "clean"}${notes.length ? ` (${notes.length} note${notes.length > 1 ? "s" : ""})` : ""}`);
  return { status: failed ? "failed" : "proved", durationMs: Math.round(performance.now() - t0), details };
}
