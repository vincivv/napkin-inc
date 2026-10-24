"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { readConfig, makeNames, type ConfigView, type Names } from "@/lib/config";
import type { Actions, Session, Snapshot } from "./types";
import { BUSINESS_KEY, DEFAULT_BUSINESS, PREVIEW_KEY, safeGet, safeSet } from "./env";

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
  setBusiness(slug: string): void;
}

const Ctx = createContext<DataValue | undefined>(undefined);

export function useData(): DataValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useData must be used inside <DataProvider>");
  return v;
}

/** Shared by the live and preview sources: derives config, names and the owner flag. */
export function DataValueProvider(props: { snapshot: Snapshot; session: Session; actions: Actions; preview?: PreviewControls; setBusiness(slug: string): void; children: ReactNode }) {
  const { snapshot, session, actions, preview, setBusiness, children } = props;
  const activeRow = useMemo(() => {
    const id = snapshot.business?.activeConfigId ?? 0n;
    return snapshot.configVersions.find((c) => c.id === id) ?? snapshot.configVersions.find((c) => c.status === "active");
  }, [snapshot.business, snapshot.configVersions]);
  const config = useMemo(() => readConfig(activeRow), [activeRow]);
  const names = useMemo(() => makeNames(config?.config), [config]);
  const value = useMemo<DataValue>(
    () => ({ snapshot, session, actions, preview, config, names, isOwner: session.role === "owner", setBusiness }),
    [snapshot, session, actions, preview, config, names, setBusiness],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

type Mode = "boot" | "live" | "preview";

export function DataProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<Mode>("boot");
  const [business, setBusinessState] = useState(DEFAULT_BUSINESS);
  const [Source, setSource] = useState<null | { Live?: typeof import("./live").LiveSource; Preview?: typeof import("./preview-source").PreviewSource }>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    const p = url.searchParams.get("preview");
    if (p === "fixture") safeSet("session", PREVIEW_KEY, "fixture");
    if (p === "off") safeSet("session", PREVIEW_KEY, null);
    const isPreview = safeGet("session", PREVIEW_KEY) === "fixture";
    const b = url.searchParams.get("business") || safeGet("local", BUSINESS_KEY);
    if (b && /^[a-z0-9-]+$/.test(b)) setBusinessState(b);
    if (isPreview) {
      void import("./preview-source").then((m) => {
        setSource({ Preview: m.PreviewSource });
        setMode("preview");
      });
    } else {
      void import("./live").then((m) => {
        setSource({ Live: m.LiveSource });
        setMode("live");
      });
    }
  }, []);

  const setBusiness = useMemo(
    () => (slug: string) => {
      safeSet("local", BUSINESS_KEY, slug);
      setBusinessState(slug);
    },
    [],
  );

  if (mode === "boot" || !Source) return <BootScreen />;
  if (mode === "preview" && Source.Preview) {
    const P = Source.Preview;
    return <P setBusiness={setBusiness}>{children}</P>;
  }
  const L = Source.Live!;
  return (
    <L businessId={business} setBusiness={setBusiness}>
      {children}
    </L>
  );
}

function BootScreen() {
  return (
    <div className="flex h-dvh items-center justify-center bg-canvas text-muted">
      <div className="flex items-center gap-3 text-sm">
        <span className="size-2 animate-pulse rounded-full bg-accent" />
        Opening the books…
      </div>
    </div>
  );
}
