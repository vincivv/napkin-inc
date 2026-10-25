"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { createContext, Suspense, useContext, useEffect, type ReactNode } from "react";
import { CartProvider, useCart } from "@/lib/cart";
import { fallbackDesign, designStyle, photoCredits, useDesign, type StorefrontDesign } from "@/lib/design";
import { formatPhone, PHONE_LINE } from "@/lib/env";
import { spacedCode, usePhoneCode } from "@/lib/phone";
import { cartCount, type StoreInfo } from "@/lib/model";
import { StoreDataProvider, useStore, useStoreHref, type StoreState } from "@/lib/store-data";
import { CartBar, CartSheet } from "./Cart";
import { ChatWidget } from "./ChatWidget";
import { BagIcon, Skeleton, StatusScreen } from "./ui";

export const DesignContext = createContext<StorefrontDesign | null>(null);

/** The store's design. Only available inside a ready store (StoreGate children). */
export function useStoreDesign(): StorefrontDesign {
  const d = useContext(DesignContext);
  if (!d) throw new Error("useStoreDesign must be used inside a ready store");
  return d;
}

export function StoreShell({ slug, children }: { slug: string; children: ReactNode }) {
  return (
    <Suspense fallback={<Skeleton />}>
      <ShellWithParams slug={slug}>{children}</ShellWithParams>
    </Suspense>
  );
}

function ShellWithParams({ slug, children }: { slug: string; children: ReactNode }) {
  // Preview mode is OFF unless the URL explicitly says ?preview=fixture.
  const preview = useSearchParams().get("preview") === "fixture";
  return (
    <StoreDataProvider slug={slug} preview={preview}>
      <CartProvider slug={slug} preview={preview}>
        <Themed slug={slug}>{children}</Themed>
      </CartProvider>
    </StoreDataProvider>
  );
}

function Themed({ slug, children }: { slug: string; children: ReactNode }) {
  const { state, preview } = useStore();
  const { design: loaded, settled } = useDesign(slug);
  const info = state.status === "ready" ? state.info : null;
  const design = loaded ?? (info && settled ? fallbackDesign(info) : null);
  useEffect(() => {
    if (info) document.title = info.name;
  }, [info]);
  if (state.status === "ready" && !design) {
    return (
      <div className="brand min-h-dvh">
        <Skeleton />
      </div>
    );
  }
  return (
    <DesignContext.Provider value={design}>
      <div className="brand min-h-dvh" data-style={design?.style ?? "editorial"} style={design ? designStyle(design) : undefined}>
        {preview ? <PreviewBanner /> : null}
        {design && info ? <Announcement design={design} /> : null}
        <Header />
        <main>{children}</main>
        {design && info ? <Footer info={info} design={design} /> : null}
        <CartBar />
        <CartSheet />
        {design ? <ChatWidget /> : null}
      </div>
    </DesignContext.Provider>
  );
}

function PreviewBanner() {
  return (
    <div className="no-print bg-ink px-4 py-2 text-center text-xs font-medium text-paper">
      PREVIEW: fixture data from fixtures/maya/configuration.json (placeholder stock, not live). Checkout is off.
    </div>
  );
}

function Announcement({ design }: { design: StorefrontDesign }) {
  if (!design.announcement) return null;
  return (
    <div className="no-print bg-brand px-4 py-2 text-center text-[0.8rem] font-medium text-on-brand">
      <span className="ds-label">{design.announcement}</span>
    </div>
  );
}

function Header() {
  const { state } = useStore();
  const design = useContext(DesignContext);
  const href = useStoreHref();
  const { cart, setOpen, bumpKey } = useCart();
  const pathname = usePathname();
  const count = cartCount(cart);
  const onQr = pathname.endsWith("/qr");
  if (state.status !== "ready" || !design) return null;
  const bold = design.style === "bold";
  const nav = [
    { label: "Shop", to: href("#shop") },
    { label: state.info.fulfillment === "pickup" ? "Pickup" : "Visit", to: href("#visit") },
    { label: "Pay a phone order", to: "/pay" },
  ];
  return (
    <header className={`no-print sticky top-0 z-30 border-b border-line ${bold ? "bg-ink text-paper" : "bg-paper/90 backdrop-blur-md"}`}>
      <div className="mx-auto grid h-16 max-w-7xl grid-cols-[1fr_auto_1fr] items-center gap-4 px-4 md:px-8">
        <nav className="hidden items-center gap-7 text-sm font-medium md:flex" aria-label="Store">
          {nav.map((n) => (
            <Link key={n.label} href={n.to} className={`ds-label transition-opacity hover:opacity-60`}>
              {n.label}
            </Link>
          ))}
        </nav>
        <span className="md:hidden" />
        <Link
          href={href()}
          className={`ds-display truncate text-center text-xl leading-none sm:text-2xl ${bold ? "tracking-tight" : "tracking-[0.18em] !font-semibold uppercase !text-[1.05rem] sm:!text-[1.15rem]"}`}
        >
          {state.info.name}
        </Link>
        <div className="flex items-center justify-end gap-1">
          {!onQr ? (
            <button
              key={bumpKey}
              type="button"
              onClick={() => setOpen(true)}
              className={`relative grid h-11 w-11 place-items-center rounded-full transition-opacity hover:opacity-70 ${bumpKey ? "bump" : ""}`}
              aria-label={`Open bag, ${count} item${count === 1 ? "" : "s"}`}
            >
              <BagIcon />
              {count > 0 ? (
                <span
                  className={`absolute right-0.5 top-0.5 grid h-5 min-w-5 place-items-center rounded-full px-1 text-[0.68rem] font-bold tabular-nums ${
                    bold ? "bg-paper text-ink" : "bg-brand text-on-brand"
                  }`}
                >
                  {count}
                </span>
              ) : null}
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function Footer({ info, design }: { info: StoreInfo; design: StorefrontDesign }) {
  const href = useStoreHref();
  const code = usePhoneCode(info.businessId);
  const credits = photoCredits(design);
  const bold = design.style === "bold";
  return (
    <footer className={`no-print mt-24 ${bold ? "bg-ink text-paper" : "border-t border-line bg-surface"}`}>
      <div className="mx-auto grid max-w-7xl gap-10 px-4 pb-10 pt-14 md:grid-cols-[1.4fr_1fr_1fr_1fr] md:px-8">
        <div>
          <p className="ds-display text-3xl">{info.name}</p>
          {info.oneLiner || info.tagline ? <p className="mt-3 max-w-xs text-sm opacity-75">{info.oneLiner || info.tagline}</p> : null}
        </div>
        <FooterCol title="Shop">
          <Link href={href("#shop")}>All products</Link>
          <Link href={href("/qr")}>QR codes</Link>
        </FooterCol>
        <FooterCol title="Help">
          {PHONE_LINE && code ? (
            <a href={`tel:${PHONE_LINE}`}>
              Order by phone: {formatPhone(PHONE_LINE)}, code {spacedCode(code)}
            </a>
          ) : null}
          <Link href="/pay">Pay for a phone order</Link>
          <span className="opacity-75">Card payments by Stripe</span>
        </FooterCol>
        <FooterCol title={info.fulfillment === "pickup" ? "Pickup" : "Visit"}>
          {info.pickupLocation ? <span>{info.pickupLocation}</span> : <span className="opacity-75">Location shared after you order</span>}
          {info.hours ? <span className="opacity-75">{info.hours}</span> : null}
        </FooterCol>
      </div>
      <div className={`border-t ${bold ? "border-paper/15" : "border-line"}`}>
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-4 py-6 text-xs opacity-70 md:flex-row md:items-start md:justify-between md:px-8">
          <p>
            <span className="font-semibold">Stripe test mode: no real money moves.</span> Storefront by <span className="italic">Paper to Biz</span>
          </p>
          {credits.length > 0 ? (
            <details className="md:max-w-xl md:text-right">
              <summary className="cursor-pointer select-none">Photo credits ({credits.length})</summary>
              <ul className="mt-2 space-y-1">
                {credits.map((c) => (
                  <li key={c.url}>
                    {c.creditUrl ? (
                      <a href={c.creditUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                        {c.credit}
                      </a>
                    ) : (
                      c.credit
                    )}
                    {c.license ? (
                      <>
                        {" · "}
                        {c.licenseUrl ? (
                          <a href={c.licenseUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                            {c.license}
                          </a>
                        ) : (
                          c.license
                        )}
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="eyebrow opacity-60">{title}</p>
      <div className="mt-4 flex flex-col gap-2.5 text-sm [&_a:hover]:underline [&_a]:underline-offset-4">{children}</div>
    </div>
  );
}

/** Renders loading / offline / not-found / not-open states, or the page once the store is ready. */
export function StoreGate({ children }: { children: (s: Extract<StoreState, { status: "ready" }>) => ReactNode }) {
  const { state, slug } = useStore();
  const design = useContext(DesignContext);
  switch (state.status) {
    case "loading":
      return <Skeleton />;
    case "offline":
      return (
        <StatusScreen title="Can't reach the shop">
          <p>We couldn&apos;t connect to the live shop. Check your connection; this page retries on its own.</p>
        </StatusScreen>
      );
    case "not_found":
      return (
        <StatusScreen title="No shop here">
          <p>
            There&apos;s no shop called <span className="font-mono">{slug}</span>.{" "}
            <Link href="/" className="underline">
              See all shops
            </Link>
          </p>
        </StatusScreen>
      );
    case "not_open":
      return (
        <StatusScreen title={`${state.name} is getting ready`}>
          <p>The shop isn&apos;t open yet. This page updates by itself the moment it opens.</p>
        </StatusScreen>
      );
    case "ready":
      return design ? <>{children(state)}</> : <Skeleton />;
  }
}
