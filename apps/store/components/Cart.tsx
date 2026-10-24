"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { startCheckout } from "@/lib/brain";
import { useCart } from "@/lib/cart";
import { formatCents } from "@/lib/money";
import { cartCount, estimateCents, maxQty } from "@/lib/model";
import { useStore } from "@/lib/store-data";
import { AddonRow, priceLabel } from "./Products";
import { QtyStepper } from "./ui";

function useReadyStore() {
  const { state, slug, preview } = useStore();
  return { ready: state.status === "ready" ? state : null, slug, preview };
}

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
    <div className="no-print fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(1rem,env(safe-area-inset-bottom))] fade">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn-shadow mx-auto flex h-14 w-full max-w-md items-center justify-between rounded-full bg-brand px-6 text-on-brand transition active:scale-[0.98]"
      >
        <span className="flex items-center gap-2 font-semibold">
          <span className="grid h-7 min-w-7 place-items-center rounded-full bg-on-brand/20 px-2 text-sm tabular-nums">{count}</span>
          View cart
        </span>
        {est !== null ? (
          <span className="text-sm">
            <span className="opacity-75">est.</span> <span className="font-semibold tabular-nums">{formatCents(est, ready.info.currency)}</span>
          </span>
        ) : null}
      </button>
    </div>
  );
}

export function CartSheet() {
  const { ready, slug, preview } = useReadyStore();
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
    <div className="no-print fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Your cart">
      <button type="button" className="fade absolute inset-0 bg-ink/45" aria-label="Close cart" onClick={() => setOpen(false)} />
      <div className="sheet absolute inset-x-0 bottom-0 mx-auto flex max-h-[92dvh] max-w-lg flex-col rounded-t-[2rem] bg-paper shadow-2xl sm:bottom-4 sm:rounded-[2rem]">
        <div className="flex items-center justify-between px-5 pb-2 pt-3">
          <div className="mx-auto h-1.5 w-10 rounded-full bg-ink/15 sm:hidden" aria-hidden />
        </div>
        <div className="flex items-center justify-between px-5 pb-3">
          <h2 className="font-display text-2xl font-bold text-brand">Your order</h2>
          <button type="button" onClick={() => setOpen(false)} className="h-10 rounded-full px-3 text-sm font-semibold text-muted">
            Close
          </button>
        </div>

        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 pb-4">
            {empty ? (
              <div className="rounded-2xl border border-dashed border-line px-4 py-10 text-center text-muted">
                <div className="mb-2 text-4xl" aria-hidden>
                  {info.theme.emoji}
                </div>
                Your cart is empty.
              </div>
            ) : (
              <ul className="divide-y divide-line rounded-2xl border border-line bg-card">
                {lines.map((p) => {
                  const qty = cart[p.id] ?? 0;
                  const max = maxQty(p, stock, cart, products);
                  return (
                    <li key={p.id} className="flex items-center gap-3 p-3">
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold leading-tight">{p.name}</p>
                        <p className="text-sm text-muted tabular-nums">
                          {priceLabel(p, info.currency)} each
                          {p.isAddon ? " · add-on" : ""}
                        </p>
                        {qty > max ? (
                          <p className="mt-1 text-sm font-semibold text-brand">
                            {max === 0 ? "Just sold out." : `Only ${max} available now.`}
                          </p>
                        ) : null}
                      </div>
                      <QtyStepper value={qty} max={p.isAddon ? 99 : max} onChange={(n) => setQty(p.id, n)} label={p.name} />
                    </li>
                  );
                })}
              </ul>
            )}
            {unknown.length > 0 ? (
              <p className="text-sm text-muted">Some items in your cart are no longer on the menu and were left out.</p>
            ) : null}

            {!empty && addonsNotInCart.length > 0 ? (
              <div className="space-y-2">
                <p className="pt-1 text-sm font-semibold text-muted">Make it extra</p>
                {addonsNotInCart.map((p) => (
                  <AddonRow key={p.id} product={p} currency={info.currency} tone="plain" />
                ))}
              </div>
            ) : null}

            {!empty ? (
              <div className="space-y-3 pt-2">
                <label className="block">
                  <span className="text-sm font-semibold">First name</span>
                  <span className="text-sm text-muted"> (for pickup)</span>
                  <input
                    ref={nameRef}
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value.slice(0, 40))}
                    autoComplete="given-name"
                    required
                    placeholder="e.g. Sam"
                    className="mt-1 block h-12 w-full rounded-xl border border-line bg-card px-4 text-base outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                  />
                </label>
                {info.couponsAllowed ? (
                  showCoupon ? (
                    <label className="block">
                      <span className="text-sm font-semibold">Coupon code</span>
                      <input
                        value={coupon}
                        onChange={(e) => setCoupon(e.target.value.slice(0, 40))}
                        autoCapitalize="characters"
                        className="mt-1 block h-12 w-full rounded-xl border border-line bg-card px-4 text-base uppercase outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                      />
                    </label>
                  ) : (
                    <button type="button" onClick={() => setShowCoupon(true)} className="text-sm font-semibold text-brand underline underline-offset-4">
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
                <span className="font-display text-2xl font-bold tabular-nums">{est === null ? "—" : formatCents(est, info.currency)}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted">
                Estimate only. The shop confirms the final total (discounts, tax) before you pay.
                {info.fulfillment === "pickup" ? " Pickup only." : ""}
              </p>
              {error ? (
                <div role="alert" className="mt-3 rounded-xl border border-brand/30 bg-tint px-4 py-3 text-sm font-medium text-brand-deep">
                  {error}
                </div>
              ) : null}
              <button
                type="submit"
                disabled={busy}
                className="btn-shadow mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-full bg-brand text-lg font-semibold text-on-brand transition active:scale-[0.98] disabled:opacity-70"
              >
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
