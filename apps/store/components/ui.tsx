"use client";

import { useState, type ReactNode } from "react";
import type { DesignImage } from "@/lib/design";
import type { Product } from "@/lib/model";

export function QtyStepper({
  value,
  max,
  onChange,
  label,
  size = "md",
  wide = false,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
  size?: "md" | "lg";
  wide?: boolean;
}) {
  const h = size === "lg" ? "h-13" : "h-11";
  return (
    <div
      className={`inline-flex ${h} items-center justify-between rounded-btn border-[1.5px] border-line-strong ${wide ? "w-full" : ""}`}
      role="group"
      aria-label={`Quantity of ${label}`}
    >
      <button
        type="button"
        className={`${h} w-11 rounded-btn text-xl font-semibold transition active:scale-90`}
        onClick={() => onChange(value - 1)}
        aria-label={`Remove one ${label}`}
      >
        −
      </button>
      <span className="min-w-8 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className={`${h} w-11 rounded-btn text-xl font-semibold transition active:scale-90 disabled:opacity-30`}
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`Add one ${label}`}
      >
        +
      </button>
    </div>
  );
}

export function StockBadge({ left, onImage = false }: { left: bigint | null; onImage?: boolean }) {
  if (left === null) return null;
  const base = onImage ? "bg-paper/92 backdrop-blur-sm shadow-sm" : "bg-surface";
  if (left === 0n) {
    return <span className={`inline-flex items-center rounded-btn px-2.5 py-1 text-[0.7rem] font-bold uppercase tracking-wider text-muted ${base}`}>Sold out</span>;
  }
  const low = left <= 5n;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-btn px-2.5 py-1 text-[0.72rem] font-semibold ${low ? "bg-brand text-on-brand" : `${base} text-ink`}`}
      title="Live stock"
    >
      <span className="live-dot" aria-hidden />
      <span>
        {low ? "Only " : ""}
        <span key={String(left)} className="tick tabular-nums">
          {String(left)}
        </span>{" "}
        left
      </span>
    </span>
  );
}

/**
 * A product's photo, or (no photo yet) a quiet label tile in the store's palette. Broken image URLs fall
 * back to the label tile too, so a dead link never shows a broken-image icon.
 */
export function ProductPhoto({
  product,
  image,
  aspect = "aspect-[4/5]",
  className = "",
  priority = false,
}: {
  product: Product;
  image: DesignImage | null;
  aspect?: string;
  className?: string;
  priority?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  return (
    <div className={`relative overflow-hidden rounded-tile bg-surface ${aspect} ${className}`}>
      {image && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image.url}
          alt={image.alt || product.name}
          className="photo photo-zoom"
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        <LabelTile title={product.name} kicker={product.isAddon ? "Add-on" : product.stockUnits > 1n ? `Pack of ${String(product.stockUnits)}` : ""} />
      )}
    </div>
  );
}

function LabelTile({ title, kicker }: { title: string; kicker: string }) {
  return (
    <div className="tile-pattern absolute inset-0 grid place-items-center p-3 sm:p-6">
      <div className="max-w-full rounded-card border border-line-strong bg-paper px-3 py-4 text-center shadow-[0_18px_40px_-24px_rgb(0_0_0/0.35)] sm:px-5 sm:py-6">
        {kicker ? <p className="eyebrow whitespace-nowrap !text-[0.6rem] text-muted sm:!text-[0.72rem]">{kicker}</p> : null}
        <p className="ds-display mt-1 text-lg leading-tight sm:text-2xl">{title}</p>
        <div className="mx-auto mt-3 h-0.5 w-8 bg-accent" />
      </div>
    </div>
  );
}

/** Full-bleed or framed photo with a broken-link fallback to a soft color field. */
export function Photo({ image, alt, className = "", priority = false }: { image: DesignImage | null; alt: string; className?: string; priority?: boolean }) {
  const [broken, setBroken] = useState(false);
  if (!image || broken) return <div className={`tile-pattern ${className}`} aria-hidden />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.url}
      alt={image.alt || alt}
      className={`photo ${className}`}
      loading={priority ? "eager" : "lazy"}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

export function BagIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z" />
      <path d="M9 8V6a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function HeartIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
      <path d="M12 20s-7.5-4.4-9.3-9.2C1.6 7.6 3.6 4.5 6.9 4.5c2 0 3.4 1.1 5.1 3 1.7-1.9 3.1-3 5.1-3 3.3 0 5.3 3.1 4.2 6.3C19.5 15.6 12 20 12 20Z" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

/** Small line icons for the value-prop strip. */
export function PropIcon({ kind }: { kind: "clock" | "bag" | "live" | "card" | "pin" | "phone" }) {
  const common = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (kind) {
    case "clock":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "bag":
      return (
        <svg {...common}>
          <path d="M5 8h14l-1.2 11.1a2 2 0 0 1-2 1.9H8.2a2 2 0 0 1-2-1.9L5 8Z" />
          <path d="M9 8V6a3 3 0 0 1 6 0v2" />
        </svg>
      );
    case "live":
      return (
        <svg {...common}>
          <path d="M3 12h4l2-5 4 10 2-5h6" />
        </svg>
      );
    case "card":
      return (
        <svg {...common}>
          <rect x="3" y="5.5" width="18" height="13" rx="2" />
          <path d="M3 10h18M7 15h3" />
        </svg>
      );
    case "pin":
      return (
        <svg {...common}>
          <path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11Z" />
          <circle cx="12" cy="10" r="2.3" />
        </svg>
      );
    case "phone":
      return (
        <svg {...common}>
          <path d="M6.5 3.5h3l1.5 4-2 1.3a11 11 0 0 0 6.2 6.2l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A17 17 0 0 1 4.5 5.7a2 2 0 0 1 2-2.2Z" />
        </svg>
      );
  }
}

/** Plain footer for pages outside a store (the shop index, /pay). */
export function Footer() {
  return (
    <footer className="mx-auto max-w-3xl px-5 pb-16 pt-10 text-center text-xs text-muted">
      <p className="font-semibold">Payments are Stripe test mode. No real money.</p>
      <p className="mt-1 opacity-80">
        Storefronts by <span className="italic">Napkin Inc.</span>
      </p>
    </footer>
  );
}

export function StatusScreen({ title, children }: { title: string; children?: ReactNode; emoji?: string }) {
  return (
    <div className="mx-auto flex min-h-[55dvh] max-w-md flex-col items-center justify-center px-6 text-center">
      <h1 className="ds-display text-4xl">{title}</h1>
      {children ? <div className="mt-3 text-muted">{children}</div> : null}
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="animate-pulse" aria-label="Loading">
      <div className="h-9 bg-ink/6" />
      <div className="h-16 border-b border-ink/6" />
      <div className="h-[58vh] bg-ink/6" />
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-4 px-4 pt-10 md:grid-cols-4 md:px-8">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="aspect-[4/5] rounded-2xl bg-ink/6" />
            <div className="mt-3 h-4 w-2/3 rounded bg-ink/6" />
          </div>
        ))}
      </div>
    </div>
  );
}
