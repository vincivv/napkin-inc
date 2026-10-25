"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useCart } from "@/lib/cart";
import { productImage } from "@/lib/design";
import { available, maxQty, type Product, type StockMap, type StoreInfo } from "@/lib/model";
import { useStoreHref } from "@/lib/store-data";
import { PickupCard } from "./StoreHome";
import { AddonCard, priceLabel, ProductCard } from "./Products";
import { StoreGate, useStoreDesign } from "./StoreShell";
import { ProductPhoto, QtyStepper, StatusScreen, StockBadge } from "./ui";

export function ItemPage({ entryId }: { entryId: string }) {
  return <StoreGate>{(s) => <Item entryId={entryId} {...s} />}</StoreGate>;
}

function Item({
  entryId,
  info,
  products,
  stock,
}: {
  entryId: string;
  info: StoreInfo;
  products: Product[];
  stock: StockMap;
}) {
  const href = useStoreHref();
  const design = useStoreDesign();
  const { cart, add, setQty, setOpen } = useCart();
  const product = products.find((p) => p.id === entryId);
  if (!product) {
    return (
      <StatusScreen title="Not available">
        <p>
          This item isn&apos;t available right now.{" "}
          <Link className="font-semibold underline" href={href()}>
            Back to the shop
          </Link>
        </p>
      </StatusScreen>
    );
  }
  const left = available(product, stock);
  const qty = cart[product.id] ?? 0;
  const max = product.isAddon ? 99 : maxQty(product, stock, cart, products);
  const addons = products.filter((p) => p.isAddon && p.id !== product.id);
  const others = products.filter((p) => !p.isAddon && p.id !== product.id).slice(0, 4);
  const bold = design.style === "bold";
  return (
    <>
      <div className="mx-auto max-w-7xl px-4 pt-5 md:px-8">
        <nav className="text-sm text-muted" aria-label="Breadcrumb">
          <Link href={href()} className="hover:underline">
            {info.name}
          </Link>
          <span className="mx-2">/</span>
          <span className="text-ink">{product.name}</span>
        </nav>
        <div className="mt-5 grid gap-8 md:grid-cols-[1.15fr_1fr] md:gap-14">
          <div className="md:sticky md:top-24 md:self-start">
            <ProductPhoto product={product} image={productImage(design, product)} aspect="aspect-[4/5] md:aspect-square" priority />
          </div>
          <div className="md:py-4">
            <p className="eyebrow text-muted">{product.isAddon ? "Add-on" : info.name}</p>
            <h1 className={`ds-display mt-2 ${bold ? "text-5xl md:text-6xl" : "text-4xl md:text-5xl"}`}>{product.name}</h1>
            <p className="mt-3 text-2xl tabular-nums">{priceLabel(product, info.currency)}</p>
            {product.description ? <p className="mt-5 max-w-prose text-lg leading-relaxed text-muted">{product.description}</p> : null}
            <div className="mt-6">
              {product.isAddon ? (
                <span className="rounded-btn bg-surface px-3 py-1.5 text-sm font-medium">Sold as its own line in your bag</span>
              ) : (
                <StockBadge left={left} />
              )}
            </div>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              {qty > 0 ? (
                <>
                  <QtyStepper value={qty} max={max} onChange={(n) => setQty(product.id, Math.min(n, max))} label={product.name} size="lg" />
                  <button type="button" onClick={() => setOpen(true)} className="btn btn-primary !min-h-13 flex-1">
                    View bag
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  disabled={max <= 0 || product.priceCents === null}
                  onClick={() => add(product.id)}
                  className="btn btn-primary !min-h-14 w-full text-base"
                >
                  {left === 0n ? "Sold out" : `Add to bag · ${priceLabel(product, info.currency)}`}
                </button>
              )}
            </div>
            {!product.isAddon && addons.length > 0 ? (
              <div className="mt-10">
                <p className="eyebrow text-muted">Make it yours</p>
                <div className="mt-3 space-y-3">
                  {addons.map((p) => (
                    <AddonCard key={p.id} product={p} currency={info.currency} compact />
                  ))}
                </div>
              </div>
            ) : null}
            <div className="mt-10 divide-y divide-line border-y border-line">
              <Detail title={info.fulfillment === "pickup" ? "Pickup" : "Getting it"} open>
                <PickupCard info={info} />
                {!info.pickupLocation && !info.hours ? <p>{info.fulfillment === "pickup" ? "Pickup only. Details come with your order." : "Details come with your order."}</p> : null}
              </Detail>
              <Detail title="Payment">
                <p>Card checkout through Stripe. The shop confirms the final total, including any tax, before you pay. This demo runs in Stripe test mode, so no real money moves.</p>
              </Detail>
              <Detail title="Stock">
                <p>Stock on this page is live from the shop&apos;s books and updates as people order. Your order is checked against it again when you pay.</p>
              </Detail>
            </div>
          </div>
        </div>
      </div>
      {others.length > 0 ? (
        <section className="mx-auto mt-20 max-w-7xl px-4 md:px-8">
          <h2 className="ds-display text-3xl md:text-4xl">You might also like</h2>
          <div className="mt-8 grid grid-cols-2 gap-x-4 gap-y-10 md:grid-cols-4 md:gap-x-6">
            {others.map((p, i) => (
              <ProductCard key={p.id} product={p} products={products} stock={stock} currency={info.currency} index={i} />
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}

function Detail({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className="group py-4" open={open}>
      <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
        <span className="ds-label">{title}</span>
        <span className="text-xl leading-none text-muted transition group-open:rotate-45" aria-hidden>
          +
        </span>
      </summary>
      <div className="mt-3 space-y-3 text-[0.95rem] leading-relaxed text-muted">{children}</div>
    </details>
  );
}
