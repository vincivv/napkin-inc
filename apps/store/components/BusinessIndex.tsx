"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSpacetimeDB, useTable } from "spacetimedb/react";
import { tables } from "@napkin/stdb-bindings";
import { StorefrontDesign } from "@napkin/schema/storefront-design";
import { BRAIN_URL, OWNER_URL } from "@/lib/env";
import { ArrowIcon, Footer, Photo } from "./ui";

/** The shop directory: open shops only (live configuration, guards on). The red-team baseline is hidden. */
export function BusinessIndex() {
  const conn = useSpacetimeDB();
  const [rows, ready] = useTable(tables.business);
  const shops = [...rows].filter((b) => b.activeConfigId > 0n && b.enforce).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="brand min-h-dvh" data-style="editorial">
      <header className="border-b border-line">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 md:px-8">
          <span className="ds-display text-xl">Napkin Inc.</span>
          <a href={OWNER_URL} className="btn btn-primary !min-h-10 !px-4 text-sm">
            Start your business
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 md:px-8">
        <section className="py-14 md:py-20">
          <p className="eyebrow text-muted">Shop directory</p>
          <h1 className="ds-display mt-3 max-w-3xl text-5xl leading-[1.02] md:text-7xl">
            Shops drawn on a napkin, <span className="ds-accent-word">running for real.</span>
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">Every shop here was set up from a photo of a napkin. Live stock, real card checkout in Stripe test mode, and books that balance.</p>
        </section>
        {!ready ? (
          <p className="text-muted">{conn.connectionError ? "Can't reach the platform right now." : "Loading shops…"}</p>
        ) : shops.length === 0 ? (
          <div className="rounded-tile border border-dashed border-line-strong p-10 text-center text-muted">No shops are open yet.</div>
        ) : (
          <div className="grid gap-x-6 gap-y-12 sm:grid-cols-2 lg:grid-cols-3">
            {shops.map((b) => (
              <ShopCard key={b.id} id={b.id} name={b.name} />
            ))}
          </div>
        )}
      </main>
      <div className="mt-20 border-t border-line">
        <Footer />
      </div>
    </div>
  );
}

function ShopCard({ id, name }: { id: string; name: string }) {
  const [design, setDesign] = useState<StorefrontDesign | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`${BRAIN_URL}/storefront/${encodeURIComponent(id)}/design`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const parsed = StorefrontDesign.safeParse(j);
        if (live && parsed.success) setDesign(parsed.data);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  const image = design?.hero.image ?? Object.values(design?.productImages ?? {})[0] ?? null;
  return (
    <Link href={`/${id}`} className="group block">
      <div className="relative aspect-[4/3] overflow-hidden rounded-tile bg-surface" style={design ? { backgroundColor: design.palette.surface } : undefined}>
        {image ? (
          <Photo image={image} alt={name} className="photo-zoom absolute inset-0" />
        ) : (
          <div className="tile-pattern absolute inset-0 grid place-items-center">
            <span className="ds-display px-6 text-center text-3xl">{name}</span>
          </div>
        )}
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="ds-display truncate text-2xl">{name}</p>
          {design?.hero.subtitle ? <p className="mt-0.5 line-clamp-1 text-sm text-muted">{design.hero.subtitle}</p> : null}
        </div>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line-strong transition group-hover:bg-ink group-hover:text-paper">
          <ArrowIcon />
        </span>
      </div>
    </Link>
  );
}
