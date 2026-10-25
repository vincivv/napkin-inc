"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import type { StorefrontDesign } from "@/lib/design";
import { available, type Product, type StockMap, type StoreInfo } from "@/lib/model";
import { useStoreHref } from "@/lib/store-data";
import { AddonCard, priceLabel, ProductCard } from "./Products";
import { StoreGate, useStoreDesign } from "./StoreShell";
import { ArrowIcon, Photo, PropIcon, StatusScreen } from "./ui";

export function StoreHome() {
  return (
    <StoreGate>
      {({ info, products, stock, source }) => <Home info={info} products={products} stock={stock} live={source === "live"} />}
    </StoreGate>
  );
}

function Home({ info, products, stock, live }: { info: StoreInfo; products: Product[]; stock: StockMap; live: boolean }) {
  const design = useStoreDesign();
  const mains = products.filter((p) => !p.isAddon);
  const addons = products.filter((p) => p.isAddon);
  return (
    <>
      <Hero info={info} design={design} products={mains} stock={stock} live={live} />
      <ValueProps info={info} />
      <section id="shop" className="mx-auto max-w-7xl scroll-mt-20 px-4 pt-16 md:px-8 md:pt-24" aria-label="Products">
        {products.length === 0 ? (
          <StatusScreen title="Coming soon">
            <p>Nothing on the shelves yet. This page updates live.</p>
          </StatusScreen>
        ) : (
          <>
            <SectionHead
              title={
                <>
                  {design.collection.title} {design.collection.accent ? <span className="ds-accent-word">{design.collection.accent}</span> : null}
                </>
              }
              aside={
                <span className="inline-flex items-center gap-2 text-sm text-muted">
                  {live ? <span className="live-dot text-brand" aria-hidden /> : null}
                  {mains.length} {mains.length === 1 ? "item" : "items"} · {live ? "live stock" : "preview stock"}
                </span>
              }
            />
            <div
              className={`mt-8 grid grid-cols-2 gap-x-4 gap-y-10 md:gap-x-6 ${
                mains.length <= 2 ? "md:max-w-4xl md:grid-cols-2" : mains.length === 3 ? "md:grid-cols-3" : "md:grid-cols-3 lg:grid-cols-4"
              }`}
            >
              {mains.map((p, i) => (
                <ProductCard key={p.id} product={p} products={products} stock={stock} currency={info.currency} index={i} />
              ))}
            </div>
            {addons.length > 0 ? (
              <div className="mt-16 rounded-tile bg-surface p-5 md:p-8">
                <div className="flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <p className="eyebrow text-muted">Extras</p>
                    <h2 className="ds-display mt-1 text-2xl md:text-3xl">Make it yours</h2>
                  </div>
                  <p className="text-sm text-muted">Each extra is its own line in your bag.</p>
                </div>
                <div className="mt-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                  {addons.map((p) => (
                    <AddonCard key={p.id} product={p} currency={info.currency} />
                  ))}
                </div>
              </div>
            ) : null}
          </>
        )}
      </section>
      <VisitBanner info={info} design={design} />
    </>
  );
}

function SectionHead({ title, aside }: { title: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <h2 className="ds-display text-3xl md:text-5xl">{title}</h2>
      {aside}
    </div>
  );
}

// ---------- hero ----------

function Hero({ info, design, products, stock, live }: { info: StoreInfo; design: StorefrontDesign; products: Product[]; stock: StockMap; live: boolean }) {
  const href = useStoreHref();
  const h = design.hero;
  const bold = design.style === "bold";
  const secondary = info.fulfillment === "pickup" ? "Pickup info" : "Visit us";

  if (h.image && h.layout === "fullbleed") {
    return (
      <section className="relative isolate flex min-h-[72vh] overflow-hidden bg-ink md:min-h-[min(82vh,760px)]">
        <Photo image={h.image} alt={info.name} className="absolute inset-0 -z-10" priority />
        <div className="hero-scrim absolute inset-0 -z-10" aria-hidden />
        <div
          className={`mx-auto flex w-full max-w-7xl flex-col px-5 pb-14 pt-24 text-white md:px-8 md:pb-20 ${
            bold ? "items-center justify-center text-center" : "justify-end"
          }`}
        >
          {h.eyebrow ? <p className="eyebrow rise opacity-90">{h.eyebrow}</p> : null}
          <h1
            className={`ds-display rise mt-3 max-w-3xl text-balance ${bold ? "text-6xl sm:text-8xl lg:text-[8.5rem]" : "text-5xl leading-[1.02] sm:text-7xl"}`}
            style={{ animationDelay: "80ms" }}
          >
            {h.title}
          </h1>
          {h.subtitle ? (
            <p className="rise mt-5 max-w-xl text-lg text-white/85 md:text-xl" style={{ animationDelay: "160ms" }}>
              {h.subtitle}
            </p>
          ) : null}
          <div className="rise mt-8 flex flex-wrap gap-3" style={{ animationDelay: "240ms" }}>
            <Link href={href("#shop")} className="btn btn-light min-w-40">
              {h.cta}
            </Link>
            <Link href={href("#visit")} className="btn btn-ghost-light min-w-40">
              {secondary}
            </Link>
          </div>
        </div>
      </section>
    );
  }

  const text = (
    <div className={`flex flex-col justify-center py-12 md:py-20 ${bold ? "" : ""}`}>
      {h.eyebrow ? <p className="eyebrow rise text-muted">{h.eyebrow}</p> : null}
      <h1 className={`ds-display rise mt-3 text-balance ${bold ? "text-6xl sm:text-7xl lg:text-8xl" : "text-5xl leading-[1.02] sm:text-6xl lg:text-7xl"}`} style={{ animationDelay: "80ms" }}>
        {h.title}
      </h1>
      {h.subtitle ? (
        <p className="rise mt-5 max-w-lg text-lg text-muted md:text-xl" style={{ animationDelay: "160ms" }}>
          {h.subtitle}
        </p>
      ) : null}
      <div className="rise mt-8 flex flex-wrap gap-3" style={{ animationDelay: "240ms" }}>
        <Link href={href("#shop")} className="btn btn-primary min-w-40">
          {h.cta}
        </Link>
        <Link href={href("#visit")} className="btn btn-outline min-w-40">
          {secondary}
        </Link>
      </div>
    </div>
  );

  return (
    <section className={bold ? "border-b border-line" : ""}>
      <div className="mx-auto grid max-w-7xl gap-6 px-5 md:grid-cols-[1.05fr_1fr] md:gap-12 md:px-8">
        {text}
        <div className="pb-8 md:py-10">
          {h.image ? (
            <div className="relative h-full min-h-[320px] overflow-hidden rounded-tile">
              <Photo image={h.image} alt={info.name} className="absolute inset-0" priority />
            </div>
          ) : (
            <MenuBoard info={info} products={products} stock={stock} live={live} />
          )}
        </div>
      </div>
    </section>
  );
}

/** Hero art when there is no photo: the live menu itself, set like a printed menu card. */
function MenuBoard({ info, products, stock, live }: { info: StoreInfo; products: Product[]; stock: StockMap; live: boolean }) {
  return (
    <div className="tile-pattern rise flex h-full min-h-[340px] items-center justify-center rounded-tile p-6 md:p-10" style={{ animationDelay: "200ms" }}>
      <div className="w-full max-w-sm rotate-[-1.5deg] rounded-card border border-line-strong bg-paper p-7 shadow-[0_30px_60px_-35px_rgb(0_0_0/0.45)]">
        <p className="eyebrow text-center text-muted">Today at</p>
        <p className="ds-display mt-1 text-center text-3xl">{info.name}</p>
        <div className="mx-auto mt-3 h-0.5 w-10 bg-accent" />
        <ul className="mt-6 space-y-3">
          {products.slice(0, 6).map((p) => {
            const left = available(p, stock);
            return (
              <li key={p.id} className="flex items-baseline gap-2">
                <span className="font-medium">{p.name}</span>
                <span className="flex-1 border-b border-dotted border-line-strong" aria-hidden />
                <span className="tabular-nums">{priceLabel(p, info.currency)}</span>
                {left === 0n ? <span className="text-xs text-muted">sold out</span> : null}
              </li>
            );
          })}
        </ul>
        {live ? (
          <p className="mt-6 flex items-center justify-center gap-2 text-xs text-muted">
            <span className="live-dot text-brand" aria-hidden /> Live from the shop&apos;s books
          </p>
        ) : null}
      </div>
    </div>
  );
}

// ---------- value props (deterministic: built from confirmed facts only) ----------

function ValueProps({ info }: { info: StoreInfo }) {
  const props: { icon: Parameters<typeof PropIcon>[0]["kind"]; text: string }[] = [];
  if (info.fulfillment === "pickup") props.push({ icon: "bag", text: "Order ahead, pick up" });
  else props.push({ icon: "bag", text: "Order online" });
  if (info.hours) props.push({ icon: "clock", text: info.hours });
  props.push({ icon: "live", text: "Live stock, updated as you shop" });
  props.push({ icon: "card", text: "Secure card checkout" });
  if (info.pickupLocation && props.length < 4) props.push({ icon: "pin", text: info.pickupLocation });
  return (
    <section className="border-b border-line bg-surface">
      <ul className="no-scrollbar mx-auto flex max-w-7xl snap-x gap-8 overflow-x-auto px-5 py-4 md:justify-between md:px-8">
        {props.slice(0, 4).map((p) => (
          <li key={p.text} className="flex shrink-0 snap-start items-center gap-2.5 text-sm font-medium">
            <PropIcon kind={p.icon} />
            <span className="ds-label">{p.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ---------- visit / pickup banner ----------

function VisitBanner({ info, design }: { info: StoreInfo; design: StorefrontDesign }) {
  const href = useStoreHref();
  const pickup = info.fulfillment === "pickup";
  const steps = pickup
    ? ["Add what you want to your bag", "Pay by card in a few taps", "Pick up with your first name"]
    : ["Add what you want to your bag", "Pay by card in a few taps", "We'll get it to you"];
  return (
    <section id="visit" className="mx-auto mt-20 max-w-7xl scroll-mt-20 px-4 md:mt-28 md:px-8">
      <div className="grid overflow-hidden rounded-tile bg-surface md:grid-cols-2">
        <div className="relative min-h-[280px] md:min-h-[460px]">
          <Photo image={design.banner.image} alt={design.banner.title} className="absolute inset-0" />
        </div>
        <div className="flex flex-col justify-center p-7 md:p-14">
          <p className="eyebrow text-muted">{pickup ? "Pickup" : "Visit"}</p>
          <h2 className="ds-display mt-2 text-4xl md:text-5xl">{design.banner.title}</h2>
          {info.pickupLocation || info.hours ? (
            <dl className="mt-6 space-y-3 text-[0.95rem]">
              {info.pickupLocation ? (
                <div className="flex gap-3">
                  <dt className="text-muted">
                    <PropIcon kind="pin" />
                    <span className="sr-only">Where</span>
                  </dt>
                  <dd className="font-medium">{info.pickupLocation}</dd>
                </div>
              ) : null}
              {info.hours ? (
                <div className="flex gap-3">
                  <dt className="text-muted">
                    <PropIcon kind="clock" />
                    <span className="sr-only">When</span>
                  </dt>
                  <dd className="font-medium">{info.hours}</dd>
                </div>
              ) : null}
            </dl>
          ) : null}
          <ol className="mt-8 space-y-3">
            {steps.map((s, i) => (
              <li key={s} className="flex items-center gap-3 text-[0.95rem]">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line-strong text-xs font-bold tabular-nums">{i + 1}</span>
                {s}
              </li>
            ))}
          </ol>
          <div className="mt-9">
            <Link href={href("#shop")} className="btn btn-primary">
              Start your order <ArrowIcon />
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Pickup details card, used on the item page. */
export function PickupCard({ info }: { info: StoreInfo }) {
  if (!info.pickupLocation && !info.hours) return null;
  return (
    <div className="rounded-card border border-line p-5">
      <p className="eyebrow text-muted">{info.fulfillment === "pickup" ? "Pickup" : "Visit"}</p>
      <dl className="mt-3 space-y-2 text-[0.95rem]">
        {info.pickupLocation ? (
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-muted">Where</dt>
            <dd className="font-medium">{info.pickupLocation}</dd>
          </div>
        ) : null}
        {info.hours ? (
          <div className="flex gap-3">
            <dt className="w-14 shrink-0 text-muted">When</dt>
            <dd className="font-medium">{info.hours}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
