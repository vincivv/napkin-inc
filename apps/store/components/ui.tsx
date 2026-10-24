"use client";

import type { ReactNode } from "react";
import type { Product } from "@/lib/model";

export function QtyStepper({
  value,
  max,
  onChange,
  label,
  size = "md",
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  label: string;
  size?: "md" | "lg";
}) {
  const h = size === "lg" ? "h-12" : "h-11";
  return (
    <div className={`inline-flex ${h} items-center rounded-full border border-line bg-card`} role="group" aria-label={`Quantity of ${label}`}>
      <button
        type="button"
        className={`${h} w-11 rounded-full text-xl font-semibold text-brand active:scale-90 transition`}
        onClick={() => onChange(value - 1)}
        aria-label={`Remove one ${label}`}
      >
        −
      </button>
      <span className="min-w-6 text-center font-semibold tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className={`${h} w-11 rounded-full text-xl font-semibold text-brand active:scale-90 transition disabled:opacity-30`}
        onClick={() => onChange(value + 1)}
        disabled={value >= max}
        aria-label={`Add one ${label}`}
      >
        +
      </button>
    </div>
  );
}

export function StockBadge({ left, compact = false }: { left: bigint | null; compact?: boolean }) {
  if (left === null) return null;
  if (left === 0n) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-ink/8 px-2.5 py-1 text-xs font-semibold uppercase tracking-wide text-muted">
        Sold out
      </span>
    );
  }
  const low = left <= 5n;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
        low ? "bg-brand text-on-brand" : "bg-tint text-brand-deep"
      }`}
      title="Live stock"
    >
      <span className="live-dot" aria-hidden />
      <span>
        {low && !compact ? "Only " : ""}
        <span key={String(left)} className="tick tabular-nums">
          {String(left)}
        </span>{" "}
        left
      </span>
    </span>
  );
}

/** Product illustration from the theme emoji: one for a single, a boxed grid for a multi-pack. */
export function ProductArt({ product, emoji, size = "md" }: { product: Product; emoji: string; size?: "md" | "lg" }) {
  const big = size === "lg";
  if (product.isAddon) {
    return (
      <div className="relative grid aspect-square place-items-center rounded-2xl bg-tint">
        <span className={`font-display font-black text-brand ${big ? "text-7xl" : "text-4xl"}`} aria-hidden>
          +
        </span>
      </div>
    );
  }
  const n = Number(product.stockUnits > 12n ? 12n : product.stockUnits < 1n ? 1n : product.stockUnits);
  if (n === 1) {
    return (
      <div className={`relative grid place-items-center overflow-hidden rounded-3xl bg-tint ${big ? "aspect-[4/3]" : "aspect-[4/3]"}`}>
        <Crumbs />
        <span className={`wobble drop-shadow-sm ${big ? "text-[8.5rem]" : "text-[5.5rem]"}`} aria-hidden>
          {emoji}
        </span>
      </div>
    );
  }
  const cols = n <= 4 ? 2 : 3;
  return (
    <div className={`relative grid place-items-center overflow-hidden rounded-3xl bg-tint aspect-[4/3]`}>
      <Crumbs />
      <div
        className="grid gap-1 rounded-2xl border-4 border-brand/80 bg-card/70 p-2 shadow-[inset_0_-6px_0_color-mix(in_oklab,var(--brand-primary)_14%,transparent)] -rotate-3"
        style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
        aria-hidden
      >
        {Array.from({ length: n }, (_, i) => (
          <span key={i} className={`${big ? "text-6xl" : "text-[2.6rem]"} leading-none`} style={{ transform: `rotate(${((i * 47) % 30) - 15}deg)` }}>
            {emoji}
          </span>
        ))}
      </div>
    </div>
  );
}

function Crumbs() {
  // decorative dots in the accent color
  const dots = [
    [12, 18, 6],
    [82, 22, 4],
    [70, 78, 7],
    [22, 74, 4],
    [50, 12, 3],
    [90, 55, 5],
  ];
  return (
    <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
      {dots.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={(r ?? 4) / 3} fill="var(--brand-primary)" opacity="0.18" />
      ))}
    </svg>
  );
}

export function Squiggle({ className = "" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 220 14" fill="none" aria-hidden preserveAspectRatio="none">
      <path
        d="M2 9c18-7 32 6 50 0s32-7 50 0 32 6 50 0 32-7 50 0 14 2 16 1"
        stroke="var(--brand-accent)"
        strokeWidth="5"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function Footer() {
  return (
    <footer className="mx-auto max-w-3xl px-5 pb-28 pt-10 text-center text-xs text-muted">
      <p className="font-semibold">Payments are Stripe test mode. No real money.</p>
      <p className="mt-1 opacity-80">
        Storefront by <span className="font-display italic">Napkin Inc.</span>
      </p>
    </footer>
  );
}

export function StatusScreen({ emoji, title, children }: { emoji: string; title: string; children?: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-[55dvh] max-w-md flex-col items-center justify-center px-6 text-center">
      <div className="mb-4 text-6xl" aria-hidden>
        {emoji}
      </div>
      <h1 className="font-display text-3xl font-bold text-brand">{title}</h1>
      {children ? <div className="mt-3 text-muted">{children}</div> : null}
    </div>
  );
}

export function Skeleton() {
  return (
    <div className="mx-auto max-w-3xl animate-pulse px-5 pt-10" aria-label="Loading">
      <div className="mx-auto h-24 w-24 rounded-full bg-ink/8" />
      <div className="mx-auto mt-6 h-10 w-3/4 rounded-xl bg-ink/8" />
      <div className="mx-auto mt-3 h-4 w-2/3 rounded bg-ink/6" />
      <div className="mt-10 space-y-5">
        <div className="h-72 rounded-3xl bg-ink/6" />
        <div className="h-72 rounded-3xl bg-ink/6" />
      </div>
    </div>
  );
}
