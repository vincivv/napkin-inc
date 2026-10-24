"use client";

import Link from "next/link";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@napkin/stdb-bindings";
import { Footer } from "./ui";

export function BusinessIndex() {
  const conn = useSpacetimeDB();
  const [rows, ready] = useTable(tables.business);
  const shops = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="brand grain min-h-dvh">
      <main className="mx-auto max-w-md px-5 pt-16">
        <p className="text-center text-4xl" aria-hidden>
          🧻
        </p>
        <h1 className="mt-3 text-center font-display text-4xl font-black">Napkin Inc.</h1>
        <p className="mt-2 text-center text-muted">Shops drawn on a napkin, running for real.</p>
        <div className="mt-10 space-y-3">
          {!ready ? (
            <p className="text-center text-sm text-muted">{conn.connectionError ? "Can't reach the platform right now." : "Loading shops…"}</p>
          ) : shops.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-line p-6 text-center text-sm text-muted">
              No shops are open yet.
              <div className="mt-3">
                <Link href="/maya-cookies?preview=fixture" className="font-semibold text-ink underline underline-offset-4">
                  Design preview of Maya&apos;s Cookies (fixture data)
                </Link>
              </div>
            </div>
          ) : (
            shops.map((b) => (
              <Link
                key={b.id}
                href={`/${b.id}`}
                className="card-shadow flex items-center justify-between rounded-2xl border border-line bg-card px-5 py-4 transition active:scale-[0.99]"
              >
                <span>
                  <span className="block font-display text-xl font-semibold">{b.name}</span>
                  <span className="font-mono text-xs text-muted">/{b.id}{b.enforce ? "" : " · red-team baseline (guards off)"}</span>
                </span>
                <span className="text-sm font-semibold text-muted">{b.activeConfigId > 0n ? "Open →" : "Opening soon"}</span>
              </Link>
            ))
          )}
        </div>
      </main>
      <Footer />
    </div>
  );
}
