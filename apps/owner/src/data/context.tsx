"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readConfig, makeNames, type ConfigView, type Names } from "@/lib/config";
import type { Actions, Session, Snapshot } from "./types";
import { PREVIEW_KEY, safeSet } from "./env";

export interface PreviewControls {
  simulateSale(): void;
  signIn(): void;
  signOut(): void;
  exit(): void;
}

export interface DataValue {
  snapshot: Snapshot;
  session: Session;
  actions: Actions;
  preview: PreviewControls | undefined;
  config: ConfigView | undefined;
  names: Names;
  isOwner: boolean;
}

const Ctx = createContext<DataValue | undefined>(undefined);

export function useData(): DataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData must be used inside <DataProvider>");
  return v;
}

/** Shared by the live and preview sources: derives config, names and the owner flag. */
export function DataValueProvider(props: { snapshot: Snapshot; session: Session; actions: Actions; preview?: PreviewControls; children: ReactNode }) {
  const { snapshot, session, actions, preview, children } = props;
  const activeRow = useMemo(() => {
    const id = snapshot.business?.activeConfigId ?? 0n;
    return snapshot.configVersions.find((c) => c.id === id) ?? snapshot.configVersions.find((c) => c.status === "active");
  }, [snapshot.business, snapshot.configVersions]);
  const config = useMemo(() => readConfig(activeRow), [activeRow]);
  const names = useMemo(() => makeNames(config?.config), [config]);
  const value = useMemo<DataValue>(
    () => ({ snapshot, session, actions, preview, config, names, isOwner: session.role === "owner" }),
    [snapshot, session, actions, preview, config, names],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Live data for ONE business: the signed-in account's own. There is no business switcher, and no
 * fixture preview (it showed one business's demo data to every visitor).
 */
export function DataProvider({ businessId, accountId, children }: { businessId: string; accountId: string; children: ReactNode }) {
  const [Live, setLive] = useState<typeof import("./live").LiveSource | null>(null);
  useEffect(() => {
    safeSet("session", PREVIEW_KEY, null); // clear a preview flag left by an older build
    void import("./live").then((m) => setLive(() => m.LiveSource));
  }, []);
  if (!Live) return <BootScreen />;
  return (
    <Live businessId={businessId} accountId={accountId}>
      {children}
    </Live>
  );
}

export function BootScreen({ label = "Opening the books…" }: { label?: string }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-canvas text-muted">
      <div className="flex items-center gap-3 text-sm">
        <span className="size-2 animate-pulse rounded-full bg-accent" />
        {label}
      </div>
    </div>
  );
}
