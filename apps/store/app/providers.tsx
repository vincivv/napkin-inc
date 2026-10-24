"use client";

import { useMemo, type ReactNode } from "react";
import { SpacetimeDBProvider } from "spacetimedb/react";
import { DbConnection } from "@napkin/stdb-bindings";
import { SPACETIMEDB_DB, SPACETIMEDB_URI } from "@/lib/env";

/** One anonymous SpacetimeDB connection for the whole app (all storefront tables are public). */
export function Providers({ children }: { children: ReactNode }) {
  const connectionBuilder = useMemo(
    () => DbConnection.builder().withUri(SPACETIMEDB_URI).withDatabaseName(SPACETIMEDB_DB),
    [],
  );
  return <SpacetimeDBProvider connectionBuilder={connectionBuilder}>{children}</SpacetimeDBProvider>;
}
