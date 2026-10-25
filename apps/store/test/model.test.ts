import fc from "fast-check";
import { describe, expect, it } from "vitest";
import fixture from "../../../fixtures/maya/configuration.json";
import { decimalToCents, formatCents, formatCentsShort } from "../lib/money";
import {
  available,
  estimateCents,
  maxQty,
  productsFrom,
  stockFrom,
  storeInfoFrom,
  type Cart,
  type CatalogRow,
  type Product,
} from "../lib/model";

const config = fixture as unknown as Record<string, unknown>;

function rowsFromFixture(configId = 7n): CatalogRow[] {
  const cats = (fixture as { catalogs: { id: string; entries: { id: string; data: Record<string, string> }[] }[] }).catalogs;
  return cats.flatMap((c, ci) =>
    c.entries.map((e, i) => ({
      id: BigInt(ci * 100 + i),
      catalog: c.id,
      entryId: e.id,
      data: Object.entries(e.data).map(([name, value]) => ({ name, value })),
      active: true,
      configId,
    })),
  );
}

const products = productsFrom(rowsFromFixture(), config, 7n);
const byId = (id: string) => products.find((p) => p.id === id) as Product;

describe("money", () => {
  it("parses exact decimals to cents and formats without floats", () => {
    expect(decimalToCents("3.00")).toBe(300n);
    expect(decimalToCents("15")).toBe(1500n);
    expect(decimalToCents("0.005")).toBeNull();
    expect(decimalToCents("abc")).toBeNull();
    expect(formatCents(1500n)).toBe("$15.00");
    expect(formatCents(123456789n)).toBe("$1,234,567.89");
    expect(formatCentsShort(100n)).toBe("$1");
    expect(formatCentsShort(150n)).toBe("$1.50");
  });
});

describe("catalog", () => {
  it("reads products from live catalog rows in configuration order", () => {
    expect(products.map((p) => p.id)).toEqual(["cookie_single", "cookie_box6", "sea_salt"]);
    expect(byId("cookie_box6").priceCents).toBe(1500n);
    expect(byId("cookie_box6").stockUnits).toBe(6n);
    expect(byId("sea_salt").isAddon).toBe(true);
    expect(byId("cookie_single").stockItemName).toBe("Chocolate chip cookie (baked)");
  });

  it("ignores inactive rows, other catalogs and rows from other config versions", () => {
    const rows = rowsFromFixture();
    rows[0] = { ...rows[0]!, active: false };
    rows.push({ ...rows[1]!, id: 999n, configId: 6n });
    const ps = productsFrom(rows, config, 7n);
    expect(ps.map((p) => p.id)).toEqual(["cookie_box6", "sea_salt"]);
  });

  it("takes theme and pickup text from the configuration, hiding placeholders", () => {
    const info = storeInfoFrom(config, "maya-cookies", "x");
    expect(info.theme.primary).toBe("#6b3410");
    expect(info.theme.font).toBe("Fraunces");
    // the fixture's location is "TBD (placeholder)": never shown to customers as if it were a fact
    expect(info.pickupLocation).toBe("");
    const real = { ...config, business: { ...(config.business as object), pickupLocation: "Mission Dolores Park, north gate" } };
    expect(storeInfoFrom(real, "maya-cookies", "x").pickupLocation).toBe("Mission Dolores Park, north gate");
    expect(info.fulfillment).toBe("pickup");
  });

  it("parses stock balances by dimsKey", () => {
    const s = stockFrom([
      { registerId: "stock", dimsKey: "item=choc_chip_cookie", qty: 13n },
      { registerId: "sales", dimsKey: "product=cookie_single", qty: 4n },
    ]);
    expect(s.get("choc_chip_cookie")).toBe(13n);
    expect(s.size).toBe(1);
  });
});

describe("stock display", () => {
  it("is floor(stockQty / stockUnits); add-ons are untracked", () => {
    const stock = new Map([["choc_chip_cookie", 13n]]);
    expect(available(byId("cookie_single"), stock)).toBe(13n);
    expect(available(byId("cookie_box6"), stock)).toBe(2n);
    expect(available(byId("sea_salt"), stock)).toBeNull();
    expect(available(byId("cookie_box6"), new Map([["choc_chip_cookie", 5n]]))).toBe(0n);
    expect(available(byId("cookie_single"), new Map())).toBe(0n);
  });

  it("property: filling the cart up to maxQty never needs more stock than is on hand", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 40 }), (onHand, singles) => {
        const stock = new Map([["choc_chip_cookie", BigInt(onHand)]]);
        const s = byId("cookie_single");
        const box = byId("cookie_box6");
        const cart: Cart = { [s.id]: Math.min(singles, maxQty(s, stock, {}, products)) };
        cart[box.id] = maxQty(box, stock, cart, products);
        const units = BigInt(cart[s.id] ?? 0) * s.stockUnits + BigInt(cart[box.id] ?? 0) * box.stockUnits;
        expect(units <= BigInt(onHand)).toBe(true);
        // and the box cap is tight: one more box would not fit
        expect(units + box.stockUnits > BigInt(onHand)).toBe(true);
      }),
    );
  });

  it("estimate is the exact integer sum of qty * price (display only)", () => {
    expect(estimateCents({ cookie_box6: 2, sea_salt: 1 }, products)).toBe(3100n);
    expect(estimateCents({ nope: 1 }, products)).toBeNull();
  });
});
