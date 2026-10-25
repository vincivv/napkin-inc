// Stock is counted in the item itself ("how many Beef burritos do you have?"), so an item sold in one size
// named like the item uses exactly one of itself per sale. That is a definition, not a business fact: the
// interview never asks it, and any stockUnits stored for such a size (an owner who read "units per sale" as
// "how many I have" once answered 20) is ignored by the compiler and dropped from the spec.

import type { BusinessSpec } from "@napkin/schema";

type Offering = BusinessSpec["offerings"][number];
type Variant = Offering["variants"][number];

const sameName = (a: unknown, b: unknown) => String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/** True when the item has a single size named like the item: one sale uses one of itself. */
export function isOneSize(o: Offering, v: Variant): boolean {
  return o.variants.length === 1 && sameName(v.name.value, o.name.value);
}

/** Units of the item's stock one sale of `v` uses: 1 for a one-size item, else the stated stockUnits. */
export function unitsPerSale(o: Offering, v: Variant): string | undefined {
  return isOneSize(o, v) ? "1" : v.stockUnits?.value;
}
