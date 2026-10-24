"use client";

import Link from "next/link";
import { useCart } from "@/lib/cart";
import { available, maxQty } from "@/lib/model";
import { useStoreHref } from "@/lib/store-data";
import { PickupCard } from "./StoreHome";
import { AddonRow, priceLabel } from "./Products";
import { StoreGate } from "./StoreShell";
import { ProductArt, QtyStepper, StatusScreen, StockBadge } from "./ui";

export function ItemPage({ entryId }: { entryId: string }) {
  const href = useStoreHref();
  const { cart, add, setQty, setOpen } = useCart();
  return (
    <StoreGate>
      {({ info, products, stock }) => {
        const product = products.find((p) => p.id === entryId);
        if (!product) {
          return (
            <StatusScreen emoji="🔎" title="Not on the menu">
              <p>
                This item isn&apos;t available right now.{" "}
                <Link className="font-semibold text-brand underline" href={href()}>
                  See the menu
                </Link>
              </p>
            </StatusScreen>
          );
        }
        const left = available(product, stock);
        const qty = cart[product.id] ?? 0;
        const max = product.isAddon ? 99 : maxQty(product, stock, cart, products);
        const addons = products.filter((p) => p.isAddon && p.id !== product.id);
        return (
          <div className="mx-auto max-w-xl px-4 pt-4">
            <Link href={href()} className="inline-flex h-10 items-center gap-1 text-sm font-semibold text-brand">
              ← {info.name}
            </Link>
            <div className="card-shadow mt-2 rounded-[2rem] border border-line bg-card p-3">
              <ProductArt product={product} emoji={info.theme.emoji} size="lg" />
              <div className="px-2 pb-2 pt-5">
                <div className="flex items-start justify-between gap-4">
                  <h1 className="font-display text-4xl font-black leading-none text-brand">{product.name}</h1>
                  <span className="font-display text-3xl font-bold tabular-nums">{priceLabel(product, info.currency)}</span>
                </div>
                {product.description ? <p className="mt-3 text-lg leading-snug text-ink/80">{product.description}</p> : null}
                <div className="mt-4">
                  {product.isAddon ? (
                    <span className="rounded-full bg-tint px-3 py-1 text-sm font-semibold text-brand-deep">Add-on, sold as its own line</span>
                  ) : (
                    <StockBadge left={left} />
                  )}
                </div>
                <div className="mt-6 flex items-center gap-3">
                  {qty > 0 ? (
                    <>
                      <QtyStepper value={qty} max={max} onChange={(n) => setQty(product.id, Math.min(n, max))} label={product.name} size="lg" />
                      <button
                        type="button"
                        onClick={() => setOpen(true)}
                        className="btn-shadow h-12 flex-1 rounded-full bg-brand font-semibold text-on-brand active:scale-[0.98]"
                      >
                        View cart
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={max <= 0 || product.priceCents === null}
                      onClick={() => add(product.id)}
                      className="btn-shadow h-14 w-full rounded-full bg-brand text-lg font-semibold text-on-brand transition active:scale-[0.98] disabled:bg-ink/15 disabled:text-muted disabled:shadow-none"
                    >
                      {left === 0n ? "Sold out" : `Add to cart · ${priceLabel(product, info.currency)}`}
                    </button>
                  )}
                </div>
              </div>
            </div>
            {!product.isAddon && addons.length > 0 ? (
              <div className="mt-5 space-y-3">
                <p className="px-1 text-sm font-semibold text-muted">Make it extra</p>
                {addons.map((p) => (
                  <AddonRow key={p.id} product={p} currency={info.currency} />
                ))}
              </div>
            ) : null}
            <PickupCard info={info} />
            <div className="mt-6 text-center">
              <Link href={href()} className="text-sm font-semibold text-brand underline underline-offset-4">
                See the whole menu
              </Link>
            </div>
          </div>
        );
      }}
    </StoreGate>
  );
}
