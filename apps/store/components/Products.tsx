"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart";
import { formatCents, formatCentsShort } from "@/lib/money";
import { available, maxQty, type Product, type StockMap } from "@/lib/model";
import { useStoreHref } from "@/lib/store-data";
import { ProductArt, QtyStepper, StockBadge } from "./ui";

export function priceLabel(p: Product, currency: string): string {
  return p.priceCents === null ? p.priceText : formatCents(p.priceCents, currency);
}

export function ProductCard({
  product,
  products,
  stock,
  emoji,
  currency,
}: {
  product: Product;
  products: readonly Product[];
  stock: StockMap;
  emoji: string;
  currency: string;
}) {
  const href = useStoreHref();
  const { cart, add, setQty } = useCart();
  const left = available(product, stock);
  const qty = cart[product.id] ?? 0;
  const max = maxQty(product, stock, cart, products);
  const soldOut = left === 0n;
  return (
    <article className="card-shadow rounded-[2rem] border border-line bg-card p-3">
      <Link href={href(`/item/${encodeURIComponent(product.id)}`)} className={soldOut ? "block opacity-55 grayscale" : "block"}>
        <ProductArt product={product} emoji={emoji} />
      </Link>
      <div className="px-2 pb-1 pt-4">
        <div className="flex items-start justify-between gap-3">
          <Link href={href(`/item/${encodeURIComponent(product.id)}`)}>
            <h3 className="font-display text-2xl font-semibold leading-tight">{product.name}</h3>
          </Link>
          <span className="font-display text-2xl font-bold text-brand tabular-nums">{priceLabel(product, currency)}</span>
        </div>
        {product.description ? <p className="mt-1 text-[0.95rem] leading-snug text-muted">{product.description}</p> : null}
        <div className="mt-4 flex items-center justify-between gap-3">
          <StockBadge left={left} />
          {qty > 0 ? (
            <QtyStepper value={qty} max={max} onChange={(n) => setQty(product.id, Math.min(n, max))} label={product.name} />
          ) : (
            <button
              type="button"
              disabled={max <= 0 || product.priceCents === null}
              onClick={() => add(product.id)}
              className="btn-shadow h-11 rounded-full bg-brand px-6 font-semibold text-on-brand transition active:scale-95 disabled:bg-ink/15 disabled:text-muted disabled:shadow-none"
            >
              {soldOut ? "Sold out" : "Add to cart"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

/** An add-on is sold as its own line item, with a clear "+$price" control. */
export function AddonRow({ product, currency, tone = "card" }: { product: Product; currency: string; tone?: "card" | "plain" }) {
  const { cart, add, setQty } = useCart();
  const qty = cart[product.id] ?? 0;
  const plus = product.priceCents === null ? `+${product.priceText}` : `+${formatCentsShort(product.priceCents, currency)}`;
  return (
    <div
      className={`flex items-center gap-3 rounded-2xl p-3 ${
        tone === "card" ? "border border-dashed border-brand/35 bg-card" : "bg-tint/60"
      }`}
    >
      <div className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-tint font-display text-3xl font-black text-brand" aria-hidden>
        +
      </div>
      <div className="min-w-0 flex-1">
        <p className="font-semibold leading-tight">{product.name}</p>
        {product.description ? <p className="text-sm leading-snug text-muted">{product.description}</p> : null}
      </div>
      {qty > 0 ? (
        <QtyStepper value={qty} max={99} onChange={(n) => setQty(product.id, n)} label={product.name} />
      ) : (
        <button
          type="button"
          onClick={() => add(product.id)}
          disabled={product.priceCents === null}
          className="h-11 shrink-0 rounded-full bg-accent px-4 font-bold text-ink transition active:scale-95"
          aria-label={`Add ${product.name} for ${plus.slice(1)}`}
        >
          {plus}
        </button>
      )}
    </div>
  );
}
