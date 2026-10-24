"use client";

import { StoreGate } from "./StoreShell";
import { AddonRow, ProductCard } from "./Products";
import { Squiggle, StatusScreen } from "./ui";
import type { StoreInfo } from "@/lib/model";

export function StoreHome() {
  return (
    <StoreGate>
      {({ info, products, stock, source }) => {
        const mains = products.filter((p) => !p.isAddon);
        const addons = products.filter((p) => p.isAddon);
        return (
          <>
            <Hero info={info} live={source === "live"} />
            <section className="mx-auto max-w-3xl px-4" aria-label="Menu">
              {products.length === 0 ? (
                <StatusScreen emoji={info.theme.emoji} title="Menu coming soon">
                  <p>Nothing on the menu yet. This page updates live.</p>
                </StatusScreen>
              ) : (
                <>
                  <div className="grid gap-5 sm:grid-cols-2">
                    {mains.map((p) => (
                      <ProductCard key={p.id} product={p} products={products} stock={stock} emoji={info.theme.emoji} currency={info.currency} />
                    ))}
                  </div>
                  {addons.length > 0 ? (
                    <div className="mt-8">
                      <h2 className="mb-3 px-1 font-display text-xl font-semibold text-brand">Extras</h2>
                      <div className="space-y-3">
                        {addons.map((p) => (
                          <AddonRow key={p.id} product={p} currency={info.currency} />
                        ))}
                      </div>
                    </div>
                  ) : null}
                </>
              )}
              <PickupCard info={info} />
            </section>
          </>
        );
      }}
    </StoreGate>
  );
}

function Hero({ info, live }: { info: StoreInfo; live: boolean }) {
  return (
    <section className="mx-auto max-w-3xl px-5 pb-8 pt-8 text-center sm:pt-12">
      <div className="relative mx-auto mb-5 grid h-28 w-28 place-items-center">
        <div className="absolute inset-0 rotate-6 rounded-[2.2rem] bg-accent" aria-hidden />
        <div className="absolute inset-0 -rotate-3 rounded-[2.2rem] border-2 border-brand/15 bg-card" aria-hidden />
        <span className="wobble relative text-6xl" aria-hidden>
          {info.theme.emoji}
        </span>
      </div>
      <h1 className="font-display text-[2.9rem] font-black leading-[0.95] tracking-tight text-brand sm:text-6xl">{info.headline}</h1>
      <Squiggle className="mx-auto mt-2 h-3 w-40" />
      {info.tagline ? <p className="mx-auto mt-4 max-w-md text-lg leading-snug text-ink/80">{info.tagline}</p> : null}
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2 text-sm">
        {info.fulfillment === "pickup" ? (
          <span className="rounded-full bg-brand px-3 py-1 font-semibold text-on-brand">Pickup only</span>
        ) : null}
        {live ? (
          <span className="inline-flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1 font-medium text-brand">
            <span className="live-dot" aria-hidden /> Live stock
          </span>
        ) : (
          <span className="rounded-full border border-dashed border-line px-3 py-1 font-medium text-muted">Preview stock</span>
        )}
      </div>
    </section>
  );
}

export function PickupCard({ info }: { info: StoreInfo }) {
  if (!info.pickupLocation && !info.hours) return null;
  return (
    <div className="mt-8 rounded-3xl border border-line bg-card p-5">
      <h2 className="font-display text-xl font-semibold text-brand">Pickup</h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[0.95rem]">
        {info.pickupLocation ? (
          <>
            <dt className="text-muted">Where</dt>
            <dd className="font-medium">{info.pickupLocation}</dd>
          </>
        ) : null}
        {info.hours ? (
          <>
            <dt className="text-muted">When</dt>
            <dd className="font-medium">{info.hours}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}
