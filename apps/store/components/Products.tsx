"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useCart } from "@/lib/cart";
import { productImage } from "@/lib/design";
import { formatCents, formatCentsShort } from "@/lib/money";
import { available, maxQty, type Product, type StockMap } from "@/lib/model";
import { useStore, useStoreHref } from "@/lib/store-data";
import { useStoreDesign } from "./StoreShell";
import { HeartIcon, ProductPhoto, QtyStepper, StockBadge } from "./ui";

export function priceLabel(p: Product, currency: string): string {
  return p.priceCents === null ? p.priceText : formatCents(p.priceCents, currency);
}

/** Saved items per store, in this browser only (a shopper convenience; nothing is sent anywhere). */
function useSaved(slug: string) {
  const key = `napkin.saved.${slug}`;
  const [saved, setSaved] = useState<string[]>([]);
  useEffect(() => {
    try {
      const v = JSON.parse(window.localStorage.getItem(key) ?? "[]");
      if (Array.isArray(v)) setSaved(v.filter((x): x is string => typeof x === "string"));
    } catch {
      // storage unavailable
    }
  }, [key]);
  const toggle = useCallback(
    (id: string) =>
      setSaved((s) => {
        const next = s.includes(id) ? s.filter((x) => x !== id) : [...s, id];
        try {
          window.localStorage.setItem(key, JSON.stringify(next));
        } catch {
          // storage unavailable: saved for this visit only
        }
        return next;
      }),
    [key],
  );
  return { saved, toggle };
}

export function ProductCard({
  product,
  products,
  stock,
  currency,
  index = 0,
}: {
  product: Product;
  products: readonly Product[];
  stock: StockMap;
  currency: string;
  index?: number;
}) {
  const href = useStoreHref();
  const { slug } = useStore();
  const design = useStoreDesign();
  const { saved, toggle } = useSaved(slug);
  const { cart, add, setQty } = useCart();
  const left = available(product, stock);
  const qty = cart[product.id] ?? 0;
  const max = maxQty(product, stock, cart, products);
  const soldOut = left === 0n;
  const isSaved = saved.includes(product.id);
  const bold = design.style === "bold";
  const link = href(`/item/${encodeURIComponent(product.id)}`);
  return (
    <article className="rise group flex flex-col" style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}>
      <div className="relative">
        <Link href={link} className={soldOut ? "block opacity-60 grayscale" : "block"} aria-label={product.name}>
          <ProductPhoto product={product} image={productImage(design, product)} aspect={bold ? "aspect-[3/4]" : "aspect-[4/5]"} />
        </Link>
        <button
          type="button"
          onClick={() => toggle(product.id)}
          className="absolute left-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-paper/92 shadow-sm backdrop-blur-sm transition hover:scale-105"
          aria-pressed={isSaved}
          aria-label={isSaved ? `Unsave ${product.name}` : `Save ${product.name}`}
        >
          <HeartIcon filled={isSaved} />
        </button>
        <div className="absolute right-3 top-3">
          <StockBadge left={left} onImage />
        </div>
      </div>
      <div className="flex flex-1 flex-col pt-4">
        <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
          <Link href={link} className="min-w-0">
            <h3 className={`line-clamp-2 ${bold ? "text-[0.9rem] font-bold uppercase tracking-wide sm:text-[0.95rem]" : "ds-display text-[1.2rem] leading-tight sm:text-[1.45rem]"}`}>{product.name}</h3>
          </Link>
          <span className={`shrink-0 tabular-nums ${bold ? "text-[0.95rem] font-bold" : "text-[0.95rem] font-medium text-muted"}`}>{priceLabel(product, currency)}</span>
        </div>
        {product.description ? <p className="mt-1 line-clamp-2 text-[0.82rem] leading-snug text-muted sm:text-sm">{product.description}</p> : null}
        <div className="mt-auto pt-4">
          {qty > 0 ? (
            <QtyStepper value={qty} max={max} onChange={(n) => setQty(product.id, Math.min(n, max))} label={product.name} wide />
          ) : (
            <button
              type="button"
              disabled={max <= 0 || product.priceCents === null}
              onClick={() => add(product.id)}
              className={`btn w-full ${bold ? "btn-primary" : "btn-outline"}`}
            >
              {soldOut ? "Sold out" : "Add to bag"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** An add-on is sold as its own line item, with a clear "+$price" control. */
export function AddonCard({ product, currency, compact = false }: { product: Product; currency: string; compact?: boolean }) {
  const { cart, add, setQty } = useCart();
  const qty = cart[product.id] ?? 0;
  const plus = product.priceCents === null ? `+${product.priceText}` : `+${formatCentsShort(product.priceCents, currency)}`;
  return (
    <div className={`flex items-center gap-4 rounded-card border border-line bg-paper ${compact ? "p-3" : "p-4"}`}>
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-card bg-tint text-2xl font-light" aria-hidden>
        +
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-tight">{product.name}</p>
        {product.description && !compact ? <p className="mt-0.5 text-sm leading-snug text-muted">{product.description}</p> : null}
        <p className="mt-0.5 text-sm tabular-nums text-muted">{plus.slice(1)} each</p>
      </div>
      {qty > 0 ? (
        <QtyStepper value={qty} max={99} onChange={(n) => setQty(product.id, n)} label={product.name} />
      ) : (
        <button
          type="button"
          onClick={() => add(product.id)}
          disabled={product.priceCents === null}
          className="btn btn-outline !min-h-11 shrink-0 !px-4"
          aria-label={`Add ${product.name} for ${plus.slice(1)}`}
        >
          {plus}
        </button>
      )}
    </div>
  );
}
