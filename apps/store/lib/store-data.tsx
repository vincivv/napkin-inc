"use client";
// Live store data from SpacetimeDB, or (only with ?preview=fixture) from fixtures/maya/configuration.json.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@napkin/stdb-bindings";
import {
  parseConfig,
  productsFrom,
  stockFrom,
  storeInfoFrom,
  type CatalogRow,
  type Product,
  type StockMap,
  type StoreInfo,
} from "./model";

export type StoreState =
  | { status: "loading" }
  | { status: "offline"; error: string }
  | { status: "not_found" }
  | { status: "not_open"; name: string }
  | { status: "ready"; info: StoreInfo; products: Product[]; stock: StockMap; source: "live" | "fixture" };

const StoreContext = createContext<{ slug: string; preview: boolean; state: StoreState } | null>(null);

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useStore must be used inside <StoreDataProvider>");
  return ctx;
}

/** Link inside the current store that keeps preview mode on when it is on. */
export function useStoreHref() {
  const { slug, preview } = useStore();
  return (path = "") => `/${slug}${path}${preview ? `${path.includes("?") ? "&" : "?"}preview=fixture` : ""}`;
}

export function StoreDataProvider({ slug, preview, children }: { slug: string; preview: boolean; children: ReactNode }) {
  return preview ? (
    <FixtureStore slug={slug}>{children}</FixtureStore>
  ) : (
    <LiveStore slug={slug}>{children}</LiveStore>
  );
}

function LiveStore({ slug, children }: { slug: string; children: ReactNode }) {
  const conn = useSpacetimeDB();
  const [businessRows, businessReady] = useTable(tables.business.where((r) => r.id.eq(slug)));
  const business = businessRows[0];
  const activeConfigId = business?.activeConfigId ?? 0n;
  const [configRows, configReady] = useTable(
    tables.configVersion.where((r) => r.id.eq(activeConfigId)),
    { enabled: activeConfigId > 0n },
  );
  const [catalogRows, catalogReady] = useTable(tables.catalogItem.where((r) => r.businessId.eq(slug)));
  const [stockRows, stockReady] = useTable(
    tables.registerBalance.where((r) => r.businessId.eq(slug)).where((r) => r.registerId.eq("stock")),
  );

  const configJson = configRows[0]?.json ?? "";
  const config = useMemo(() => (configJson ? parseConfig(configJson) : null), [configJson]);

  const state = useMemo((): StoreState => {
    if (!businessReady) {
      if (conn.connectionError) return { status: "offline", error: conn.connectionError.message };
      return { status: "loading" };
    }
    if (!business) return { status: "not_found" };
    if (activeConfigId === 0n) return { status: "not_open", name: business.name };
    if (!configReady || !catalogReady || !stockReady) return { status: "loading" };
    if (!config) return { status: "not_open", name: business.name };
    return {
      status: "ready",
      info: storeInfoFrom(config, slug, business.name),
      products: productsFrom(catalogRows as readonly CatalogRow[], config, activeConfigId),
      stock: stockFrom(stockRows),
      source: "live",
    };
  }, [conn.connectionError, businessReady, business, activeConfigId, configReady, catalogReady, stockReady, config, catalogRows, stockRows, slug]);

  return <StoreContext.Provider value={{ slug, preview: false, state }}>{children}</StoreContext.Provider>;
}

function FixtureStore({ slug, children }: { slug: string; children: ReactNode }) {
  const [state, setState] = useState<StoreState>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    void import("../../../fixtures/maya/configuration.json").then((mod) => {
      if (cancelled) return;
      const config = mod.default as unknown as Record<string, unknown>;
      if (config.businessId !== slug) return setState({ status: "not_found" });
      setState(fixtureState(config, slug));
    });
    return () => {
      cancelled = true;
    };
  }, [slug]);
  return <StoreContext.Provider value={{ slug, preview: true, state }}>{children}</StoreContext.Provider>;
}

/** Synthesize the rows the platform would hold after activating the fixture (catalog sync + opening stock). */
function fixtureState(config: Record<string, unknown>, slug: string): StoreState {
  const cats = (config.catalogs as { id: string; entries: { id: string; data: Record<string, string> }[] }[]) ?? [];
  const rows: CatalogRow[] = cats.flatMap((c) =>
    c.entries.map((e, i) => ({
      id: BigInt(i + 1),
      catalog: c.id,
      entryId: e.id,
      data: Object.entries(e.data).map(([name, value]) => ({ name, value: String(value) })),
      active: true,
      configId: 0n,
    })),
  );
  const initial = (config.initialStock as Record<string, number>) ?? {};
  const stock = new Map(Object.entries(initial).map(([k, v]) => [k, BigInt(v)]));
  return {
    status: "ready",
    info: storeInfoFrom(config, slug, String((config.business as { name?: string })?.name ?? slug)),
    products: productsFrom(rows, config, 0n),
    stock,
    source: "fixture",
  };
}
