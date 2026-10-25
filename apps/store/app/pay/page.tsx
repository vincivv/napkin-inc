"use client";

// Pay for a phone order by its order number. Used when the phone line can't text the pay link: the
// agent reads out "napkin-store.vercel.app/pay" and the order number. The brain's /p/:orderId picks
// (or reopens) the Stripe checkout for that order, so this page never sees an amount.

import { useState } from "react";
import { Footer } from "@/components/ui";
import { BRAIN_URL } from "@/lib/env";

const ORDER_ID_RE = /^[A-Z]{1,4}-[0-9A-HJKMNP-TV-Z]{5}$/;

/** "mc r0353", "MCR0353", "mc-ro353" -> "MC-R0353". Spoken O/I/L are read as 0/1, as in the id alphabet. */
function normalize(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = /^([A-Z]{1,4}?)([0-9A-Z]{5})$/.exec(s);
  if (!m) return s;
  const body = m[2]!.replace(/O/g, "0").replace(/[IL]/g, "1");
  return `${m[1]}-${body}`;
}

export default function PayPhoneOrder() {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const id = normalize(value);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ORDER_ID_RE.test(id)) {
      setError("That doesn't look like an order number. It looks like MC-R0353.");
      return;
    }
    window.location.assign(`${BRAIN_URL}/p/${encodeURIComponent(id)}`);
  }

  return (
    <div className="brand grain min-h-dvh">
      <main className="mx-auto max-w-md px-5 pt-16">
        <p className="text-center text-4xl" aria-hidden>
          📞
        </p>
        <h1 className="mt-3 text-center font-display text-4xl font-black">Pay a phone order</h1>
        <p className="mt-2 text-center text-muted">Enter the order number you were given on the call.</p>
        <form onSubmit={submit} className="mt-10 space-y-3">
          <label htmlFor="order" className="block text-sm font-semibold">
            Order number
          </label>
          <input
            id="order"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
            placeholder="MC-R0353"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            className="h-14 w-full rounded-2xl border border-line bg-card px-5 font-mono text-xl tracking-wider outline-none focus:border-brand"
          />
          {error ? <p className="text-sm font-semibold text-brand-deep">{error}</p> : null}
          <button type="submit" className="h-14 w-full rounded-full bg-brand font-semibold text-on-brand transition active:scale-[0.99]">
            Continue to payment
          </button>
        </form>
      </main>
      <Footer />
    </div>
  );
}
