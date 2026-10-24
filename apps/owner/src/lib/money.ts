// Money display from integer cents. String math only: no floats anywhere in money paths.

export type Cents = bigint;

function groupThousands(digits: string): string {
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i;
    out += digits[i];
    if (fromEnd > 1 && fromEnd % 3 === 1) out += ",";
  }
  return out;
}

/** 123456n -> "$1,234.56"; -5n -> "-$0.05". */
export function formatCents(cents: Cents, opts: { sign?: boolean; symbol?: boolean } = {}): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const s = abs.toString().padStart(3, "0");
  const whole = s.slice(0, -2);
  const frac = s.slice(-2);
  const sym = opts.symbol === false ? "" : "$";
  const body = `${sym}${groupThousands(whole)}.${frac}`;
  if (neg) return `-${body}`;
  if (opts.sign && abs !== 0n) return `+${body}`;
  return body;
}

/** Exact decimal dollar string ("15.00", "0.8", "3") -> cents. Throws on fractional cents or junk. */
export function parseDollars(text: string): Cents {
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(text.trim());
  if (!m) throw new SyntaxError(`not a dollar amount: "${text}"`);
  const cents = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] === "-" ? -cents : cents;
}

/** Percentage with one decimal from a ratio of bigints, e.g. pct(3n, 8n) -> "37.5%". Exact, rounds half up. */
export function pct(numer: bigint, denom: bigint): string {
  if (denom === 0n) return "—";
  const neg = numer < 0n !== denom < 0n && numer !== 0n;
  const n = numer < 0n ? -numer : numer;
  const d = denom < 0n ? -denom : denom;
  const tenths = (n * 1000n * 2n + d) / (2n * d); // round half up
  const s = tenths.toString().padStart(2, "0");
  return `${neg ? "-" : ""}${s.slice(0, -1)}.${s.slice(-1)}%`;
}

export function sum<T>(rows: readonly T[], f: (r: T) => bigint): bigint {
  let t = 0n;
  for (const r of rows) t += f(r);
  return t;
}

/** Exact decimal rate string ("0.30", "0.2") -> display percentage ("30%", "20%"). */
export function rateToPct(rate: string): string {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(rate.trim());
  if (!m) return rate;
  const frac = (m[2] ?? "").padEnd(2, "0");
  const whole = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2));
  const rest = frac.slice(2).replace(/0+$/, "");
  return `${whole}${rest ? "." + rest : ""}%`;
}
