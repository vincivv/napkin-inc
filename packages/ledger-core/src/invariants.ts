// Pure invariant predicates. The platform reducers call these inside the transaction and throw on
// violation (rollback); the red-team harness and property tests call them on whole ledgers.

import type { JournalLine, Movement } from "./posting";

export interface InvariantViolation {
  invariant: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  code: string;
  message: string;
}

/** Invariant 1: sum debits == sum credits. */
export function checkBalanced(journal: Pick<JournalLine, "debitCents" | "creditCents">[]): InvariantViolation | null {
  let d = 0n;
  let c = 0n;
  for (const j of journal) {
    if (j.debitCents < 0n || j.creditCents < 0n) return { invariant: 1, code: "negative_line", message: "journal line with a negative side" };
    d += j.debitCents;
    c += j.creditCents;
  }
  return d === c ? null : { invariant: 1, code: "unbalanced", message: `debits ${d} != credits ${c}` };
}

export type BalanceKey = string; // `${register}|${sorted dims}`

export function balanceKey(register: string, dims: Record<string, string>): BalanceKey {
  return register + "|" + Object.keys(dims).sort().map((k) => `${k}=${dims[k]}`).join(",");
}

export interface RegisterBalance {
  qty: bigint;
  amountCents: bigint;
}

/** Apply movements to balances (returns a new map). */
export function applyMovements(balances: ReadonlyMap<BalanceKey, RegisterBalance>, movements: Pick<Movement, "register" | "dims" | "kind" | "qty" | "amountCents">[]): Map<BalanceKey, RegisterBalance> {
  const out = new Map(balances);
  for (const m of movements) {
    const k = balanceKey(m.register, m.dims);
    const b = out.get(k) ?? { qty: 0n, amountCents: 0n };
    const s = m.kind === "in" ? 1n : -1n;
    out.set(k, { qty: b.qty + s * m.qty, amountCents: b.amountCents + s * m.amountCents });
  }
  return out;
}

/** Invariant 3: no balance register goes negative unless backorders are allowed for it. */
export function checkStockNonNegative(balances: ReadonlyMap<BalanceKey, RegisterBalance>, allowNegative: (register: string) => boolean): InvariantViolation | null {
  for (const [k, b] of balances) {
    const register = k.slice(0, k.indexOf("|"));
    if (b.qty < 0n && !allowNegative(register)) {
      return { invariant: 3, code: "negative_stock", message: `${k} would go to ${b.qty}` };
    }
  }
  return null;
}

/** Invariant 5: the creator of a document cannot approve (post) it. */
export function checkSegregation(createdBy: string, approvedBy: string, cannotApproveOwn: boolean): InvariantViolation | null {
  if (cannotApproveOwn && createdBy === approvedBy) {
    return { invariant: 5, code: "self_approval", message: "the creator of a document cannot approve it" };
  }
  return null;
}

/** Invariant 8: nothing posts into a closed period. */
export function checkPeriodOpen(period: string, closed: ReadonlySet<string>): InvariantViolation | null {
  return closed.has(period) ? { invariant: 8, code: "period_closed", message: `period ${period} is closed` } : null;
}

export function periodOf(timestampMicros: bigint, timeZoneOffsetMinutes = 0): string {
  const ms = Number(timestampMicros / 1000n) + timeZoneOffsetMinutes * 60_000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface TrialBalanceRow {
  account: string;
  debitCents: bigint;
  creditCents: bigint;
  balanceCents: bigint; // debit - credit
}

export function trialBalance(journal: Pick<JournalLine, "account" | "debitCents" | "creditCents">[]): TrialBalanceRow[] {
  const m = new Map<string, TrialBalanceRow>();
  for (const j of journal) {
    const r = m.get(j.account) ?? { account: j.account, debitCents: 0n, creditCents: 0n, balanceCents: 0n };
    r.debitCents += j.debitCents;
    r.creditCents += j.creditCents;
    r.balanceCents = r.debitCents - r.creditCents;
    m.set(j.account, r);
  }
  return [...m.values()].sort((a, b) => a.account.localeCompare(b.account));
}
