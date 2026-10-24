import { Rational } from "@napkin/ledger-core";

const terminates = (r: Rational) => {
  let d = r.den;
  while (d % 2n === 0n) d /= 2n;
  while (d % 5n === 0n) d /= 5n;
  return d === 1n;
};

/** Exact string Rational.parse accepts back: "3", "0.125", or "58/375". */
export function exact(r: Rational): string {
  if (r.isInteger()) return r.num.toString();
  return terminates(r) ? r.toDecimal(40) : `${r.num}/${r.den}`;
}

export function money(r: Rational): string {
  const neg = r.num < 0n;
  const a = neg ? r.neg() : r;
  const c = a.mul(Rational.of(100));
  const s = c.isInteger() ? `${c.num / 100n}.${(c.num % 100n).toString().padStart(2, "0")}` : exact(a);
  return `${neg ? "-" : ""}$${s}`;
}

export function rate(r: Rational): string {
  const p = r.mul(Rational.of(100));
  if (terminates(p)) return `${p.toDecimal(10)}%`;
  return `${r.num}/${r.den} (≈${p.toDecimal(2).replace("…", "")}%)`;
}

export function fraction(r: Rational): string {
  return r.isInteger() ? r.num.toString() : `${r.num}/${r.den}`;
}

/** "73/125 (58.4%)" */
export function fractionWithPct(r: Rational): string {
  const p = r.mul(Rational.of(100));
  return `${fraction(r)} (${terminates(p) ? p.toDecimal(10) : "≈" + p.toDecimal(2).replace("…", "")}%)`;
}

export function ceilCents(r: Rational): Rational {
  const c = r.mul(Rational.of(100));
  const f = c.floor();
  return Rational.of(c.isInteger() ? f : f + 1n, 100n);
}
