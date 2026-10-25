// Impact scoring for the question engine. DETERMINISTIC and documented: the LLM never chooses what to ask.
//
//   impactScore(path, fact) = moneyImpact(path) * (1 - confidence)
//
// moneyImpact says how much a wrong value at this path can hurt the owner's money. Fixed table:
//   1.0  prices, costs, tax rate, margin floor, max discount, refund window     (every sale or refund depends on them)
//   0.8  refund method, coupons allowed
//   0.5  stock levels, stock tracking                                          (overselling; medium)
//   0.5  currency, payment methods        (structural, but the compiler requires them confirmed like money)
//   0.3  fulfillment                                                           (structural, rarely wrong)
//   0.1  hours, location, timezone, suppliers, variant names, anything unlisted (low)
//   0.02 business name, one-liner, community, product names, descriptions       (~0: cosmetic)
// A path is "money relevant" when its moneyImpact >= 0.5. The compiler needs every money-relevant fact to be
// usableForMoney (confirmed and not inferred) before it will compile (see moneyReady in ./engine).

import { normalizePath } from "../spec/paths";

export const MONEY_RELEVANT_AT = 0.5;

export const MONEY_IMPACT: Readonly<Record<string, number>> = {
  "offerings.*.variants.*.price": 1,
  "offerings.*.variants.*.cost": 1,
  "offerings.*.addOns.*.price": 1,
  "offerings.*.addOns.*.cost": 1,
  "policies.taxRate": 1,
  "policies.marginFloorPct": 1,
  "policies.maxDiscountPct": 1,
  "policies.refundWindowHours": 1,
  "policies.refundMethod": 0.8,
  "policies.couponsAllowed": 0.8,
  "offerings.*.initialStock": 0.5,
  "offerings.*.variants.*.stockUnits": 0.5,
  "offerings.*.stockTracked": 0.5,
  "policies.currency": 0.5,
  "policies.paymentMethods": 0.5,
  "operations.fulfillment": 0.3,
  "business.hours": 0.1,
  "business.location": 0.1,
  "business.timezone": 0.1,
  "operations.pickupLocation": 0.1,
  "operations.suppliers.*.name": 0.1,
  "operations.suppliers.*.items": 0.1,
  "offerings.*.variants.*.name": 0.1,
  "offerings.*.addOns.*.name": 0.1,
  "business.name": 0.02,
  "business.oneLiner": 0.02,
  "business.community": 0.02,
  "offerings.*.name": 0.02,
  "offerings.*.description": 0.02,
};
export const DEFAULT_MONEY_IMPACT = 0.1;

export function moneyImpact(fieldPath: string): number {
  return MONEY_IMPACT[normalizePath(fieldPath)] ?? DEFAULT_MONEY_IMPACT;
}
export function isMoneyRelevant(fieldPath: string): boolean {
  return moneyImpact(fieldPath) >= MONEY_RELEVANT_AT;
}
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
/** impactScore = moneyImpact * (1 - confidence); confidence is clamped to [0,1]. */
export function impactScore(fieldPath: string, confidence: number): number {
  const c = Math.min(1, Math.max(0, confidence));
  return round6(moneyImpact(fieldPath) * (1 - c));
}
