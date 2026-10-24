"use client";
// Client-side cart per store, persisted in localStorage. Quantities only: prices are never stored here.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Cart } from "./model";

type CartApi = {
  cart: Cart;
  hydrated: boolean;
  setQty: (productId: string, qty: number) => void;
  add: (productId: string, by?: number) => void;
  clear: () => void;
  customerName: string;
  setCustomerName: (name: string) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
  bumpKey: number; // increments on every add, to animate the cart button
};

const CartContext = createContext<CartApi | null>(null);

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}

type Saved = { cart: Cart; customerName: string };

function read(key: string): Saved {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { cart: {}, customerName: "" };
    const v = JSON.parse(raw) as Partial<Saved>;
    const cart: Cart = {};
    for (const [id, qty] of Object.entries(v.cart ?? {})) {
      if (typeof qty === "number" && Number.isInteger(qty) && qty > 0) cart[id] = qty;
    }
    return { cart, customerName: typeof v.customerName === "string" ? v.customerName : "" };
  } catch {
    return { cart: {}, customerName: "" };
  }
}

export function CartProvider({ slug, preview, children }: { slug: string; preview: boolean; children: ReactNode }) {
  const key = `napkin.cart.${preview ? "preview." : ""}${slug}`;
  const [cart, setCart] = useState<Cart>({});
  const [customerName, setCustomerName] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(false);
  const [bumpKey, setBumpKey] = useState(0);

  useEffect(() => {
    const saved = read(key);
    setCart(saved.cart);
    setCustomerName(saved.customerName);
    setHydrated(true);
  }, [key]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(key, JSON.stringify({ cart, customerName }));
    } catch {
      // storage unavailable (private mode): the cart still works for this visit
    }
  }, [key, cart, customerName, hydrated]);

  const setQty = useCallback((productId: string, qty: number) => {
    setCart((c) => {
      const next = { ...c };
      if (qty > 0) next[productId] = Math.floor(qty);
      else delete next[productId];
      return next;
    });
  }, []);
  const add = useCallback((productId: string, by = 1) => {
    setCart((c) => ({ ...c, [productId]: (c[productId] ?? 0) + by }));
    setBumpKey((k) => k + 1);
  }, []);
  const clear = useCallback(() => setCart({}), []);

  const value = useMemo(
    () => ({ cart, hydrated, setQty, add, clear, customerName, setCustomerName, open, setOpen, bumpKey }),
    [cart, hydrated, setQty, add, clear, customerName, open, bumpKey],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}
