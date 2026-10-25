"use client";

import { usePathname } from "next/navigation";
import { useContext, useEffect, useRef, useState, type FormEvent } from "react";
import { startCheckout } from "@/lib/brain";
import { useCart } from "@/lib/cart";
import { productImage } from "@/lib/design";
import { formatCents } from "@/lib/money";
import { cartCount, estimateCents, maxQty } from "@/lib/model";
import { useStore } from "@/lib/store-data";
import { AddonCard, priceLabel } from "./Products";
import { DesignContext } from "./StoreShell";
import { BagIcon, ProductPhoto, QtyStepper } from "./ui";

function useReadyStore() {
  const { state, slug, preview } = useStore();
  return { ready: state.status === "ready" ? state : null, slug, preview };
}

/** Floating "view bag" bar on phones; desktop uses the header bag. */
export function CartBar() {
  const { ready } = useReadyStore();
  const { cart, open, setOpen, hydrated } = useCart();
  const pathname = usePathname();
  if (!ready || !hydrated || open) return null;
  if (pathname.endsWith("/qr") || pathname.includes("/order/")) return null;
  const count = cartCount(cart);
  if (count === 0) return null;
  const est = estimateCents(
    Object.fromEntries(ready.products.filter((p) => cart[p.id]).map((p) => [p.id, cart[p.id] ?? 0])),
    ready.products,
  );
  return (
    <div className="no-print fade fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:hidden">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-primary !min-h-14 w-full justify-between shadow-[0_12px_30px_-12px_rgb(0_0_0/0.5)]"
      >
        <span className="flex items-center gap-2">
          <BagIcon size={20} />
          View bag · <span className="tabular-nums">{count}</span>
        </span>
        {est !== null ? <span className="tabular-nums">{formatCents(est, ready.info.currency)}</span> : null}
      </button>
    </div>
  );
}

export function CartSheet() {
  const { ready, slug, preview } = useReadyStore();
  const design = useContext(DesignContext);
  const { cart, setQty, open, setOpen, customerName, setCustomerName } = useCart();
  const [coupon, setCoupon] = useState("");
  const [showCoupon, setShowCoupon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, setOpen]);

  useEffect(() => setError(null), [cart]);

  if (!open || !ready) return null;
  const { products, stock, info } = ready;
  const lines = products.filter((p) => (cart[p.id] ?? 0) > 0);
  const unknown = Object.keys(cart).filter((id) => !products.some((p) => p.id === id));
  const addonsNotInCart = products.filter((p) => p.isAddon && !cart[p.id]);
  const est = estimateCents(Object.fromEntries(lines.map((p) => [p.id, cart[p.id] ?? 0])), products);
  const empty = lines.length === 0;
  const count = cartCount(cart);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const name = customerName.trim();
    if (!name) {
      setError("Please add your first name so we know whose order it is.");
      nameRef.current?.focus();
      return;
    }
    if (preview) {
      setError("Checkout is off in preview mode (fixture data).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const url = await startCheckout({
        businessId: slug,
        lines: lines.map((p) => ({ productId: p.id, qty: cart[p.id] ?? 0 })),
        customerName: name,
        ...(coupon.trim() ? { couponCode: coupon.trim() } : {}),
      });
      window.location.assign(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="no-print fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Your bag">
      <button type="button" className="fade absolute inset-0 bg-black/45" aria-label="Close bag" onClick={() => setOpen(false)} />
      <div className="sheet absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col rounded-t-[1.5rem] bg-paper shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:max-h-none md:w-[440px] md:rounded-none">
        <div className="mx-auto mt-3 h-1.5 w-10 rounded-full bg-ink/15 md:hidden" aria-hidden />
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="ds-display text-2xl">
            Your bag {count > 0 ? <span className="text-base font-normal text-muted tabular-nums">({count})</span> : null}
          </h2>
          <button type="button" onClick={() => setOpen(false)} className="grid h-10 w-10 place-items-center rounded-full text-2xl leading-none text-muted hover:bg-surface" aria-label="Close">
            ×
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {empty ? (
              <div className="flex flex-col items-center px-4 py-16 text-center text-muted">
                <BagIcon size={36} />
                <p className="mt-3">Your bag is empty.</p>
                <button type="button" onClick={() => setOpen(false)} className="btn btn-outline mt-6">
                  Keep shopping
                </button>
              </div>
            ) : (
              <ul className="space-y-4">
                {lines.map((p) => {
                  const qty = cart[p.id] ?? 0;
                  const max = maxQty(p, stock, cart, products);
                  return (
                    <li key={p.id} className="flex gap-4">
                      <div className="w-20 shrink-0">
                        <ProductPhoto product={p} image={design ? productImage(design, p) : null} aspect="aspect-square" className="!rounded-card [&_.ds-display]:!text-xs [&_.eyebrow]:hidden" />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col">
                        <div className="flex items-start justify-between gap-2">
                          <p className="font-semibold leading-tight">{p.name}</p>
                          <p className="shrink-0 text-sm tabular-nums">{p.priceCents === null ? "" : formatCents(p.priceCents * BigInt(qty), info.currency)}</p>
                        </div>
                        <p className="text-sm text-muted tabular-nums">
                          {priceLabel(p, info.currency)} each{p.isAddon ? " · add-on" : ""}
                        </p>
                        {qty > max && !p.isAddon ? <p className="mt-1 text-sm font-semibold text-brand">{max === 0 ? "Just sold out." : `Only ${max} available now.`}</p> : null}
                        <div className="mt-2">
                          <QtyStepper value={qty} max={p.isAddon ? 99 : max} onChange={(n) => setQty(p.id, n)} label={p.name} />
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {unknown.length > 0 ? <p className="text-sm text-muted">Some items in your bag are no longer available and were left out.</p> : null}

            {!empty && addonsNotInCart.length > 0 ? (
              <div className="space-y-2 border-t border-line pt-5">
                <p className="eyebrow text-muted">Make it yours</p>
                {addonsNotInCart.map((p) => (
                  <AddonCard key={p.id} product={p} currency={info.currency} compact />
                ))}
              </div>
            ) : null}

            {!empty ? (
              <div className="space-y-3 border-t border-line pt-5">
                <label className="block">
                  <span className="text-sm font-semibold">First name</span>
                  <span className="text-sm text-muted"> ({info.fulfillment === "pickup" ? "for pickup" : "for your order"})</span>
                  <input
                    ref={nameRef}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value.slice(0, 40))}
                    autoComplete="given-name"
                    required
                    placeholder="e.g. Sam"
                    className="input mt-1.5"
                  />
                </label>
                {info.couponsAllowed ? (
                  showCoupon ? (
                    <label className="block">
                      <span className="text-sm font-semibold">Coupon code</span>
                      <input value={coupon} onChange={(e) => setCoupon(e.target.value.slice(0, 40))} autoCapitalize="characters" className="input mt-1.5 uppercase" />
                    </label>
                  ) : (
                    <button type="button" onClick={() => setShowCoupon(true)} className="text-sm font-semibold underline underline-offset-4">
                      Have a coupon?
                    </button>
                  )
                ) : null}
              </div>
            ) : null}
          </div>

          {!empty ? (
            <div className="border-t border-line bg-paper px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] pt-4">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">Estimated total</span>
                <span className="text-xl font-semibold tabular-nums">{est === null ? "—" : formatCents(est, info.currency)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Estimate only. The shop confirms the final total (discounts, tax) before you pay.
                {info.fulfillment === "pickup" ? " Pickup only." : ""}
              </p>
              {error ? (
                <div role="alert" className="mt-3 rounded-card border border-brand/30 bg-tint px-4 py-3 text-sm font-medium text-brand-deep">
                  {error}
                </div>
              ) : null}
              <button type="submit" disabled={busy} className="btn btn-primary mt-4 !min-h-14 w-full text-base">
                {busy ? "Starting checkout…" : preview ? "Checkout (off in preview)" : "Checkout"}
              </button>
              <p className="mt-2 text-center text-xs text-muted">Card payments in Stripe test mode. No real money.</p>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}
