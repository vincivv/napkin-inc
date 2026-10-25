// Step (a): the facts check. Every money-relevant fact must be usableForMoney (owner-confirmed and not
// inferred) and well-formed. Non-money facts (names, hours, places) may still be unconfirmed: they are
// compiled but listed in the configuration's _unconfirmed block so every screen can flag them.

import { Rational } from "@napkin/ledger-core";
import { usableForMoney, type BusinessSpec, type Fact } from "@napkin/schema";
import { UnconfirmedMoneyFacts, type FactIssue } from "./errors";
import { isOneSize } from "../spec/stock";

type AnyFact = Fact<unknown>;

export interface MoneyFact {
  path: string;
  fact: AnyFact | undefined;
  /** extra well-formedness check on the value; returns a problem or undefined */
  validate?: (v: unknown) => string | undefined;
}

const isDec = (v: unknown): v is string => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v);

export const wholeCents = (v: unknown): string | undefined => {
  if (!isDec(v)) return "not an exact decimal";
  const r = Rational.parse(v);
  if (r.lt(Rational.ZERO)) return "cannot be negative";
  if (!r.mul(Rational.of(100n)).isInteger()) return "must be a whole number of cents";
  return undefined;
};
const positiveCents = (v: unknown) => wholeCents(v) ?? (Rational.parse(v as string).isZero() ? "must be more than zero" : undefined);
const nonNegDecimal = (v: unknown) => (!isDec(v) ? "not an exact decimal" : Rational.parse(v).lt(Rational.ZERO) ? "cannot be negative" : undefined);
// Rates must land in the platform's (and prover's) rate domain: whole basis points. The compiler never rounds an
// owner's rate to fit; it refuses and asks (e.g. a sales tax of 8.875% cannot be represented today).
const BP_NOTE = "the platform supports rates in whole basis points only (at most 4 decimals as a fraction)";
const fraction01 = (v: unknown) =>
  nonNegDecimal(v) ??
  (Rational.parse(v as string).ge(Rational.ONE) ? "must be below 1 (a fraction, e.g. 0.0875)" : !Rational.parse(v as string).mul(Rational.of(10_000n)).isInteger() ? `has more than 4 decimals; ${BP_NOTE}` : undefined);
const percent = (v: unknown) =>
  nonNegDecimal(v) ??
  (Rational.parse(v as string).gt(Rational.of(100n)) ? "a percentage cannot exceed 100" : !Rational.parse(v as string).mul(Rational.of(100n)).isInteger() ? `has more than 2 decimals; ${BP_NOTE}` : undefined);
const positiveInt = (v: unknown) => (!isDec(v) ? "not an exact decimal" : !Rational.parse(v).isInteger() || Rational.parse(v).lt(Rational.ONE) ? "must be a whole number of at least 1" : undefined);
const nonNegInt = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? undefined : "must be a whole number >= 0");
const bool = (v: unknown) => (typeof v === "boolean" ? undefined : "must be true or false");
const nonEmpty = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? undefined : "must not be empty");

/** Every money-relevant fact of an item_seller spec, with its path and validator. */
export function moneyFacts(spec: BusinessSpec): MoneyFact[] {
  const out: MoneyFact[] = [];
  for (const o of spec.offerings) {
    const base = `offerings[${o.id}]`;
    out.push({ path: `${base}.stockTracked`, fact: o.stockTracked as AnyFact, validate: bool });
    const tracked = o.stockTracked.value === true;
    for (const v of o.variants) {
      out.push({ path: `${base}.variants[${v.id}].price`, fact: v.price as AnyFact, validate: positiveCents });
      out.push({ path: `${base}.variants[${v.id}].cost`, fact: v.cost as AnyFact, validate: wholeCents });
      if (tracked && !isOneSize(o, v)) out.push({ path: `${base}.variants[${v.id}].stockUnits`, fact: v.stockUnits as AnyFact | undefined, validate: positiveInt });
    }
    for (const a of o.addOns) {
      out.push({ path: `${base}.addOns[${a.id}].price`, fact: a.price as AnyFact, validate: positiveCents });
      out.push({ path: `${base}.addOns[${a.id}].cost`, fact: a.cost as AnyFact, validate: wholeCents });
    }
    if (tracked) out.push({ path: `${base}.initialStock`, fact: o.initialStock as AnyFact | undefined, validate: nonNegInt });
  }
  const p = spec.policies;
  out.push(
    { path: "policies.currency", fact: p.currency as AnyFact },
    { path: "policies.taxRate", fact: p.taxRate as AnyFact, validate: fraction01 },
    { path: "policies.marginFloorPct", fact: p.marginFloorPct as AnyFact, validate: percent },
    { path: "policies.refundWindowHours", fact: p.refundWindowHours as AnyFact, validate: nonNegDecimal },
    { path: "policies.refundMethod", fact: p.refundMethod as AnyFact, validate: nonEmpty },
    { path: "policies.maxDiscountPct", fact: p.maxDiscountPct as AnyFact, validate: percent },
    { path: "policies.couponsAllowed", fact: p.couponsAllowed as AnyFact, validate: bool },
    { path: "policies.paymentMethods", fact: p.paymentMethods as AnyFact },
  );
  return out;
}

/** Throws UnconfirmedMoneyFacts listing EVERY offending field (not just the first). */
export function checkMoneyFacts(spec: BusinessSpec): void {
  const issues: FactIssue[] = [];
  for (const m of moneyFacts(spec)) {
    if (!m.fact) {
      issues.push({ path: m.path, problem: "missing", detail: "no value was given" });
      continue;
    }
    if (!usableForMoney(m.fact)) {
      issues.push({ path: m.path, problem: m.fact.provenance === "inferred" ? "inferred" : "unconfirmed", detail: `provenance=${m.fact.provenance}, confirmed=${m.fact.confirmed}`, value: m.fact.value });
      continue;
    }
    const bad = m.validate?.(m.fact.value);
    if (bad) issues.push({ path: m.path, problem: "invalid", detail: bad, value: m.fact.value });
  }
  if (issues.length) throw new UnconfirmedMoneyFacts(issues);
}

/** Non-money facts that are not confirmed, as Configuration paths (for the _unconfirmed block). */
export function unconfirmedDisplayPaths(spec: BusinessSpec): string[] {
  const out: string[] = [];
  const add = (f: AnyFact | undefined, path: string) => {
    if (f && !usableForMoney(f)) out.push(path);
  };
  const b = spec.business;
  add(b.name as AnyFact, "business.name");
  add(b.oneLiner as AnyFact, "business.oneLiner");
  add(b.community as AnyFact, "business.community");
  add(b.hours as AnyFact, "business.hours");
  add(b.timezone as AnyFact, "business.timezone");
  add(spec.operations.pickupLocation as AnyFact, "business.pickupLocation");
  add(spec.operations.fulfillment as AnyFact, "policies.fulfillment");
  for (const o of spec.offerings) {
    if (o.stockTracked.value) add(o.name as AnyFact, `catalogs.stock_items.entries.${o.id}.data.name`);
    for (const v of o.variants) {
      add(v.name as AnyFact, `catalogs.products.entries.${v.id}.data.name`);
      add(o.description as AnyFact | undefined, `catalogs.products.entries.${v.id}.data.description`);
    }
    for (const a of o.addOns) add(a.name as AnyFact, `catalogs.products.entries.${a.id}.data.name`);
  }
  return [...new Set(out)];
}
