"use client";

import { useMemo } from "react";
import { useData } from "@/data/context";
import type { DocumentRow } from "@/data/types";
import type { Names } from "./config";

export function useDocMap(): Map<bigint, DocumentRow> {
  const { snapshot } = useData();
  return useMemo(() => new Map(snapshot.documents.map((d) => [d.id, d])), [snapshot.documents]);
}

/** The business's time zone; the browser's when it is unset or not a real zone id (a bad one would crash every clock). */
export function useTz(): string {
  const { config } = useData();
  const tz = config?.config?.business.timezone;
  if (tz) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return tz;
    } catch {
      /* fall through */
    }
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function docLabel(d: DocumentRow | undefined, names: Names): string {
  if (!d) return "unknown document";
  return `${names.docType(d.docType)} #${d.number}`;
}

/** Newest first by a micros timestamp, then id. */
export function newestFirst<T>(rows: readonly T[], ts: (r: T) => bigint, id?: (r: T) => bigint | string): T[] {
  return rows.slice().sort((a, b) => {
    const x = ts(b) - ts(a);
    if (x !== 0n) return x > 0n ? 1 : -1;
    if (!id) return 0;
    const ia = id(a);
    const ib = id(b);
    return ia < ib ? 1 : ia > ib ? -1 : 0;
  });
}

/** Parse a "documentRef" like "document:12", "order:MC-1", "inbox:3" into an app link. */
export function refHref(ref: string): { href: string; label: string } | null {
  const m = /^(document|order|inbox|doc)[:#](.+)$/.exec(ref.trim());
  if (!m) return null;
  const [, kind, id] = m;
  if (kind === "document" || kind === "doc") return /^\d+$/.test(id!) ? { href: `/documents/${id}`, label: `document ${id}` } : null;
  if (kind === "order") return { href: `/orders/${encodeURIComponent(id!)}`, label: `order ${id}` };
  return { href: "/inbox", label: `inbox #${id}` };
}
