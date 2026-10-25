// Pure functions that turn platform rows (or the preview fixture) into what the storefront renders.
// Nothing here decides money: prices are shown as published by the active configuration, and the
// charged total always comes from the platform.
import { decimalToCents } from "./money";

export type FieldValue = { name: string; value: string };

export type Theme = {
  primary: string;
  accent: string;
  background: string;
  text: string;
  emoji: string;
  font: string;
};

export type StoreInfo = {
  businessId: string;
  name: string;
  headline: string;
  tagline: string;
  oneLiner: string;
  pickupLocation: string;
  hours: string;
  fulfillment: string;
  currency: string;
  couponsAllowed: boolean;
  /** sales tax as a fraction ("0.0825"); "0" when the shop charges none */
  taxRate: string;
  theme: Theme;
};

export type Product = {
  id: string;
  name: string;
  kind: string; // "variant" | "addon" | ...
  isAddon: boolean;
  priceText: string;
  priceCents: bigint | null;
  description: string;
  stockItem: string; // "" = not stock-tracked
  stockUnits: bigint; // stock units consumed per 1 qty
  stockItemName: string;
};

export type StockMap = ReadonlyMap<string, bigint>; // stockItem -> qty on hand

export const DEFAULT_THEME: Theme = {
  primary: "#3b3a36",
  accent: "#d9c9a8",
  background: "#fbf8f2",
  text: "#1f1e1b",
  emoji: "🧻",
  font: "",
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Parse the active Configuration JSON. The platform validated it on submission; we still read defensively. */
export function parseConfig(json: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A display fact, or "" while it is still a placeholder ("TBD", "placeholder"): never show a guess to customers. */
const fact = (v: unknown) => {
  const s = str(v).trim();
  return /\bTBD\b|placeholder/i.test(s) ? "" : s;
};

const HEX = /^#[0-9a-fA-F]{3,8}$/;
const color = (v: unknown, fallback: string) => {
  const s = str(v);
  return HEX.test(s) ? s : fallback;
};

export function storeInfoFrom(config: Record<string, unknown> | null, businessId: string, businessName: string): StoreInfo {
  const c = obj(config);
  const biz = obj(c.business);
  const sf = obj(c.storefront);
  const th = obj(sf.theme);
  const pol = obj(c.policies);
  const name = str(biz.name) || businessName || businessId;
  return {
    businessId,
    name,
    headline: str(sf.headline) || name,
    tagline: str(sf.tagline),
    oneLiner: str(biz.oneLiner),
    pickupLocation: fact(biz.pickupLocation),
    hours: fact(biz.hours),
    fulfillment: str(pol.fulfillment),
    currency: str(pol.currency) || "USD",
    couponsAllowed: pol.couponsAllowed === true,
    taxRate: /^\d+(\.\d+)?$/.test(str(pol.taxRate)) ? str(pol.taxRate) : "0",
    theme: {
      primary: color(th.primary, DEFAULT_THEME.primary),
      accent: color(th.accent, DEFAULT_THEME.accent),
      background: color(th.background, DEFAULT_THEME.background),
      text: color(th.text, DEFAULT_THEME.text),
      emoji: str(th.emoji) || DEFAULT_THEME.emoji,
      font: str(th.font),
    },
  };
}

type CatalogEntry = { id: string; data: Record<string, string> };

function configCatalog(config: Record<string, unknown> | null, id: string): CatalogEntry[] {
  const cats = Array.isArray(obj(config).catalogs) ? (obj(config).catalogs as unknown[]) : [];
  const cat = cats.map(obj).find((c) => c.id === id);
  const entries = Array.isArray(cat?.entries) ? (cat.entries as unknown[]) : [];
  return entries.map(obj).map((e) => {
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj(e.data))) data[k] = String(v);
    return { id: str(e.id), data };
  });
}

function toBigInt(text: string | undefined): bigint {
  if (!text || !/^\d+$/.test(text.trim())) return 0n;
  return BigInt(text.trim());
}

export type CatalogRow = { catalog: string; entryId: string; data: readonly FieldValue[]; active: boolean; configId: bigint; id: bigint };

/**
 * Products from the LIVE catalog_item rows (catalog "products"), ordered as in the configuration.
 * Descriptions fall back to the configuration entry; stock item names come from the "stock_items" catalog.
 */
export function productsFrom(rows: readonly CatalogRow[], config: Record<string, unknown> | null, activeConfigId: bigint): Product[] {
  const configProducts = configCatalog(config, "products");
  const stockNames = new Map(configCatalog(config, "stock_items").map((e) => [e.id, e.data.name ?? e.id]));
  const order = new Map(configProducts.map((e, i) => [e.id, i]));
  const live = rows.filter(
    (r) => r.catalog === "products" && r.active && (activeConfigId === 0n || r.configId === activeConfigId),
  );
  const out = live.map((r): Product => {
    const d: Record<string, string> = {};
    for (const fv of r.data) d[fv.name] = fv.value;
    const cfg = configProducts.find((e) => e.id === r.entryId)?.data ?? {};
    const kind = d.kind ?? cfg.kind ?? "";
    const stockItem = d.stockItem ?? "";
    return {
      id: r.entryId,
      name: d.name || cfg.name || r.entryId,
      kind,
      isAddon: kind === "addon",
      priceText: d.price ?? "",
      priceCents: decimalToCents(d.price),
      description: d.description || cfg.description || "",
      stockItem,
      stockUnits: toBigInt(d.stockUnits),
      stockItemName: stockItem ? (stockNames.get(stockItem) ?? stockItem) : "",
    };
  });
  out.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  return out;
}

export type BalanceRow = { registerId: string; dimsKey: string; qty: bigint };

/** register_balance rows of the "stock" register -> stockItem -> qty. dimsKey is "item=<stockItem>". */
export function stockFrom(rows: readonly BalanceRow[]): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const r of rows) {
    if (r.registerId !== "stock") continue;
    const match = /^item=(.+)$/.exec(r.dimsKey);
    if (match?.[1]) m.set(match[1], r.qty);
  }
  return m;
}

/** Whether a product's stock is tracked at all (add-ons are not). */
export const tracksStock = (p: Product) => p.stockItem !== "" && p.stockUnits > 0n;

/** floor(stockQty / stockUnits), or null when the product is not stock-tracked. */
export function available(p: Product, stock: StockMap): bigint | null {
  if (!tracksStock(p)) return null;
  const qty = stock.get(p.stockItem) ?? 0n;
  return qty <= 0n ? 0n : qty / p.stockUnits;
}

export type Cart = Record<string, number>; // productId -> qty

/**
 * Most of `p` the shopper can hold in the cart, given what else in the cart draws on the same stock item.
 * A UX convenience only: the platform re-checks stock when the order is created.
 */
export function maxQty(p: Product, stock: StockMap, cart: Cart, products: readonly Product[], hardCap = 99): number {
  if (!tracksStock(p)) return hardCap;
  const onHand = stock.get(p.stockItem) ?? 0n;
  let used = 0n;
  for (const other of products) {
    if (other.id === p.id || other.stockItem !== p.stockItem) continue;
    used += BigInt(cart[other.id] ?? 0) * other.stockUnits;
  }
  const left = onHand - used;
  if (left <= 0n) return 0;
  const n = left / p.stockUnits;
  return n > BigInt(hardCap) ? hardCap : Number(n);
}

/** Display-only estimate of the cart subtotal. The charged total is computed by the platform. */
export function estimateCents(cart: Cart, products: readonly Product[]): bigint | null {
  let sum = 0n;
  for (const [id, qty] of Object.entries(cart)) {
    if (qty <= 0) continue;
    const p = products.find((x) => x.id === id);
    if (!p || p.priceCents === null) return null;
    sum += p.priceCents * BigInt(qty);
  }
  return sum;
}

/** Tax the platform will add, per line and rounded to the cent like the sale document's own rule (before any discount). */
export function estimateTaxCents(cart: Cart, products: readonly Product[], taxRate: string): bigint {
  const rate = Number(taxRate);
  if (!(rate > 0)) return 0n;
  let tax = 0n;
  for (const [id, qty] of Object.entries(cart)) {
    const p = products.find((x) => x.id === id);
    if (qty > 0 && p?.priceCents != null) tax += BigInt(Math.round(Number(p.priceCents * BigInt(qty)) * rate));
  }
  return tax;
}

export const cartCount = (cart: Cart) => Object.values(cart).reduce((a, b) => a + (b > 0 ? b : 0), 0);
