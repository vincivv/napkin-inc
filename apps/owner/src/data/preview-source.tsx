"use client";

// PREVIEW MODE source: serves the in-memory fixture world through the same context as live mode.

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { DataValueProvider, type PreviewControls } from "./context";
import { previewWorld } from "./preview";
import { PREVIEW_KEY, safeSet } from "./env";

export function PreviewSource({ children }: { children: ReactNode }) {
  const world = previewWorld();
  const snapshot = useSyncExternalStore(world.subscribe, world.getSnapshot, world.getSnapshot);
  const session = useMemo(() => world.session(), [world, snapshot.actors]); // role changes with the actor rows
  const controls = useMemo<PreviewControls>(
    () => ({
      simulateSale: world.actions.simulateSale,
      signIn: world.actions.signIn,
      signOut: world.actions.signOut,
      exit: () => {
        safeSet("session", PREVIEW_KEY, null);
        window.location.href = window.location.pathname;
      },
    }),
    [world],
  );
  return (
    <DataValueProvider snapshot={snapshot} session={session} actions={world.actions} preview={controls}>
      {children}
    </DataValueProvider>
  );
}
