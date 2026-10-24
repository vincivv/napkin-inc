// Exact rational arithmetic on bigint. All money logic runs on this: no floats, ever.
// Dollars are rationals in the DSL; the ledger stores integer cents.

export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  private constructor(num: bigint, den: bigint) {
    this.num = num;
    this.den = den;
  }

  static of(num: bigint | number, den: bigint | number = 1n): Rational {
    let n = BigInt(num);
    let d = BigInt(den);
    if (d === 0n) throw new RangeError("Rational: division by zero");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n < 0n ? -n : n, d);
    return new Rational(n / g, d / g);
  }

  static readonly ZERO = Rational.of(0n);
  static readonly ONE = Rational.of(1n);

  /** Parse an exact decimal ("3", "0.2", "-1.25", "15.00") or a fraction ("1/3"). */
  static parse(text: string): Rational {
    const s = text.trim();
    const frac = /^(-?\d+)\s*\/\s*(\d+)$/.exec(s);
    if (frac) return Rational.of(BigInt(frac[1]!), BigInt(frac[2]!));
    const dec = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
    if (!dec) throw new SyntaxError(`Rational.parse: not a decimal: "${text}"`);
    const sign = dec[1] === "-" ? -1n : 1n;
    const whole = BigInt(dec[2]!);
    const fracDigits = dec[3] ?? "";
    const scale = 10n ** BigInt(fracDigits.length);
    const n = whole * scale + (fracDigits ? BigInt(fracDigits) : 0n);
    return Rational.of(sign * n, scale);
  }

  /** Exact conversion from a JS number that is a safe integer, or a decimal literal via its string form. */
  static from(v: number | bigint | string | Rational): Rational {
    if (v instanceof Rational) return v;
    if (typeof v === "bigint") return Rational.of(v);
    if (typeof v === "string") return Rational.parse(v);
    if (Number.isSafeInteger(v)) return Rational.of(BigInt(v));
    if (!Number.isFinite(v)) throw new RangeError(`Rational.from: not finite: ${v}`);
    // Non-integers go through their shortest round-trip decimal string, which is what a human typed.
    return Rational.parse(numberToPlainDecimal(v));
  }

  static fromCents(cents: number | bigint): Rational {
    return Rational.of(BigInt(cents), 100n);
  }

  add(o: Rational): Rational {
    return Rational.of(this.num * o.den + o.num * this.den, this.den * o.den);
  }
  sub(o: Rational): Rational {
    return Rational.of(this.num * o.den - o.num * this.den, this.den * o.den);
  }
  mul(o: Rational): Rational {
    return Rational.of(this.num * o.num, this.den * o.den);
  }
  div(o: Rational): Rational {
    if (o.num === 0n) throw new RangeError("Rational: division by zero");
    return Rational.of(this.num * o.den, this.den * o.num);
  }
  neg(): Rational {
    return Rational.of(-this.num, this.den);
  }

  cmp(o: Rational): -1 | 0 | 1 {
    const l = this.num * o.den;
    const r = o.num * this.den;
    return l < r ? -1 : l > r ? 1 : 0;
  }
  eq(o: Rational): boolean {
    return this.num === o.num && this.den === o.den;
  }
  lt(o: Rational): boolean {
    return this.cmp(o) < 0;
  }
  le(o: Rational): boolean {
    return this.cmp(o) <= 0;
  }
  gt(o: Rational): boolean {
    return this.cmp(o) > 0;
  }
  ge(o: Rational): boolean {
    return this.cmp(o) >= 0;
  }
  isZero(): boolean {
    return this.num === 0n;
  }
  isInteger(): boolean {
    return this.den === 1n;
  }

  /** floor(x) */
  floor(): bigint {
    const q = this.num / this.den; // truncates toward zero
    return this.num < 0n && q * this.den !== this.num ? q - 1n : q;
  }

  /**
   * round2: round to cents, half toward +infinity: floor(x*100 + 1/2) / 100.
   * This exact definition is mirrored in the Z3 encoding (services/prover); keep them identical.
   */
  round2(): Rational {
    const scaled = this.mul(Rational.of(100n)).add(Rational.of(1n, 2n));
    return Rational.of(scaled.floor(), 100n);
  }

  /** Exact cents. Throws if this amount is not a whole number of cents (a rule forgot round2). */
  toCents(): bigint {
    const c = this.mul(Rational.of(100n));
    if (!c.isInteger()) {
      throw new FractionalCentsError(this);
    }
    return c.num;
  }

  toCentsNumber(): number {
    const c = this.toCents();
    const n = Number(c);
    if (!Number.isSafeInteger(n)) throw new RangeError("cents out of safe integer range");
    return n;
  }

  /** Decimal string with up to `digits` fraction digits (exact if it terminates, else truncated with "…"). */
  toDecimal(digits = 6): string {
    const sign = this.num < 0n ? "-" : "";
    const n = this.num < 0n ? -this.num : this.num;
    const whole = n / this.den;
    let rem = n % this.den;
    let frac = "";
    for (let i = 0; i < digits && rem !== 0n; i++) {
      rem *= 10n;
      frac += (rem / this.den).toString();
      rem %= this.den;
    }
    return sign + whole.toString() + (frac ? "." + frac : "") + (rem !== 0n ? "…" : "");
  }

  toJSON(): string {
    return this.den === 1n ? this.num.toString() : `${this.num}/${this.den}`;
  }

  toString(): string {
    return this.toDecimal();
  }
}

export class FractionalCentsError extends Error {
  constructor(readonly value: Rational) {
    super(`amount ${value.toDecimal(8)} is not a whole number of cents; wrap the rule in round2(...)`);
    this.name = "FractionalCentsError";
  }
}

function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function numberToPlainDecimal(v: number): string {
  const s = String(v);
  if (!/e/i.test(s)) return s;
  // Expand exponent notation exactly from the shortest repr.
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) throw new RangeError(`cannot convert ${v}`);
  const digits = m[2]! + (m[3] ?? "");
  const exp = Number(m[4]) - (m[3]?.length ?? 0);
  if (exp >= 0) return m[1] + digits + "0".repeat(exp);
  const pad = digits.padStart(-exp + 1, "0");
  return m[1] + pad.slice(0, pad.length + exp) + "." + pad.slice(pad.length + exp);
}
