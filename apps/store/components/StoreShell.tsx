"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, type ReactNode } from "react";
import { CartProvider, useCart } from "@/lib/cart";
import { cartCount } from "@/lib/model";
import { StoreDataProvider, useStore, useStoreHref, type StoreState } from "@/lib/store-data";
import { DEFAULT_THEME } from "@/lib/model";
import { themeStyle } from "@/lib/theme";
import { CartBar, CartSheet } from "./Cart";
import { Footer, Skeleton, StatusScreen } from "./ui";

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
        <Themed>{children}</Themed>
      </CartProvider>
    </StoreDataProvider>
  );
}

function Themed({ children }: { children: ReactNode }) {
  const { state, preview } = useStore();
  const theme = state.status === "ready" ? state.info.theme : DEFAULT_THEME;
  const title = state.status === "ready" ? state.info.name : null;
  useEffect(() => {
    if (title) document.title = title;
  }, [title]);
  return (
    <div className="brand grain min-h-dvh" style={themeStyle(theme)}>
      {preview ? <PreviewBanner /> : null}
      <Header />
      <main>{children}</main>
      <Footer />
      <CartBar />
      <CartSheet />
    </div>
  );
}

function PreviewBanner() {
  return (
    <div className="no-print bg-ink px-4 py-2 text-center text-xs font-medium text-paper">
      PREVIEW: fixture data from fixtures/maya/configuration.json (placeholder stock, not live). Checkout is off.
    </div>
  );
}

function Header() {
  const { state } = useStore();
  const href = useStoreHref();
  const { cart, setOpen, bumpKey } = useCart();
  const pathname = usePathname();
  const count = cartCount(cart);
  const onQr = pathname.endsWith("/qr");
  if (state.status !== "ready") return null;
  return (
    <header className="no-print sticky top-0 z-30 border-b border-line bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
        <Link href={href()} className="flex items-center gap-2 font-display text-lg font-bold text-brand">
          <span aria-hidden className="text-2xl">
            {state.info.theme.emoji}
          </span>
          <span className="truncate">{state.info.name}</span>
        </Link>
        {!onQr ? (
          <button
            key={bumpKey}
            type="button"
            onClick={() => setOpen(true)}
            className={`relative flex h-10 items-center gap-2 rounded-full border border-line bg-card px-4 text-sm font-semibold text-brand ${bumpKey ? "bump" : ""}`}
            aria-label={`Open cart, ${count} item${count === 1 ? "" : "s"}`}
          >
            <BagIcon />
            <span className="tabular-nums">{count}</span>
          </button>
        ) : null}
      </div>
    </header>
  );
}

function BagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

/** Renders loading / offline / not-found / not-open states, or the page once the store is ready. */
export function StoreGate({ children }: { children: (s: Extract<StoreState, { status: "ready" }>) => ReactNode }) {
  const { state, slug } = useStore();
  switch (state.status) {
    case "loading":
      return <Skeleton />;
    case "offline":
      return (
        <StatusScreen emoji="📡" title="Can't reach the shop">
          <p>We couldn&apos;t connect to the live shop. Check your connection; this page retries on its own.</p>
        </StatusScreen>
      );
    case "not_found":
      return (
        <StatusScreen emoji="🧭" title="No shop here">
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
        <StatusScreen emoji="🌱" title={`${state.name} is getting ready`}>
          <p>The shop isn&apos;t open yet. This page updates by itself the moment it opens.</p>
        </StatusScreen>
      );
    case "ready":
      return <>{children(state)}</>;
  }
}
