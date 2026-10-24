// TEST DATA ONLY. A BusinessSpec shaped like Maya's Cookies so the compiler can be checked against the
// hand-written fixture. The costs, stock, tax rate and refund limits below are the fixture's PLACEHOLDERS
// (see fixtures/maya/configuration.json `_unconfirmed`), marked "confirmed" here only so the compiler
// will run in tests. They are NOT Maya's real numbers and must never be shown as owner-confirmed facts.

import { parseBusinessSpec, type BusinessSpec } from "@napkin/schema";

const SRC = { kind: "chat" as const, ref: "TEST-FIXTURE", quote: "TEST placeholder, not an owner statement" };
/** A fact the TEST pretends the owner confirmed. */
export const ok = <T>(value: T) => ({ value, provenance: "owner_said" as const, confidence: 1, source: SRC, confirmed: true });
/** A fact read by the vision model and not yet confirmed. */
export const guess = <T>(value: T) => ({ value, provenance: "inferred" as const, confidence: 0.6, source: { kind: "photo" as const, ref: "TEST-napkin.jpg" }, confirmed: false });

export function mayaTestSpec(): BusinessSpec {
  return parseBusinessSpec({
    business: {
      name: ok("Maya's Cookies"),
      oneLiner: ok("Fresh chocolate chip cookies, pickup only."),
      community: ok("student side-hustlers selling through Instagram messages and Venmo"),
      location: ok("TBD (placeholder)"),
      hours: ok("TBD (placeholder)"),
      timezone: ok("America/Los_Angeles"),
    },
    pattern: "item_seller",
    offerings: [
      {
        id: "choc_chip_cookie",
        name: ok("Chocolate chip cookie (baked)"),
        variants: [
          { id: "cookie_single", name: ok("Chocolate chip cookie"), price: ok("3.00"), cost: ok("0.80"), stockUnits: ok("1") },
          { id: "cookie_box6", name: ok("Box of 6"), price: ok("15.00"), cost: ok("4.80"), stockUnits: ok("6") },
        ],
        addOns: [{ id: "sea_salt", name: ok("Sea-salt topping"), price: ok("1.00"), cost: ok("0.20") }],
        stockTracked: ok(true),
        initialStock: ok(48),
      },
    ],
    policies: {
      currency: ok("USD"),
      taxRate: ok("0"),
      marginFloorPct: ok("30"),
      refundWindowHours: ok("24"),
      refundMethod: ok("original_payment"),
      maxDiscountPct: ok("20"),
      couponsAllowed: ok(true),
      paymentMethods: ok(["card"]),
    },
    operations: { fulfillment: ok("pickup"), pickupLocation: ok("TBD (placeholder)"), suppliers: [] },
    examples: [],
    openQuestions: [],
  });
}

/** TEST refund limits matching the fixture's hand-written roles. */
export const TEST_ROLE_LIMITS = { maxRefundCents: { support: 1500, bookkeeper: 1500 } };
