"use client";

import type { CSSProperties, ReactNode } from "react";

/*
 * Public marketing page for Paper to Biz (paperto.biz).
 * Every number on this page comes from README.md, docs/INVARIANTS.md or redteam/RESULTS.md.
 */

function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

/* ---------------------------------------------------------------- shared bits */

function Button({ onClick, children, variant = "solid", className }: { onClick(): void; children: ReactNode; variant?: "solid" | "ghost"; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "inline-flex h-11 items-center justify-center rounded-full px-5 text-[14.5px] font-medium transition-[opacity,transform,background-color] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        variant === "solid" ? "bg-ink text-canvas hover:opacity-85" : "border border-line-strong bg-surface text-ink hover:bg-surface-2",
        className,
      )}
    >
      {children}
    </button>
  );
}

function Logo() {
  return (
    <span className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-ink">
      <svg aria-hidden viewBox="0 0 20 20" className="size-5">
        <path d="M3 3h14v9l-5 5H3z" fill="currentColor" />
        <path d="M12 17v-5h5" fill="none" stroke="var(--canvas)" strokeWidth={1.4} strokeLinejoin="round" />
      </svg>
      Paper to Biz
    </span>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

/* ---------------------------------------------------------------- hero visual */

function PaperSheet() {
  const lines = ["Maya's Cookies", "cookie ....... $3", "box of 6 ..... $15", "+ sea salt  +$1"];
  return (
    <div className="landing-paper relative w-[230px] rotate-[-3deg] rounded-[3px] pb-6 pl-10 pr-5 pt-4">
      <div className="landing-hand relative text-[18px] leading-[30px] text-[#2b2a6e]">
        {lines.map((l, i) => (
          <div key={l} className={cx("landing-write", i === 0 && "text-[22px] underline decoration-[#2b2a6e]/40 decoration-wavy underline-offset-4")} style={delay(200 + i * 220)}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function StorePanel() {
  const items = [
    { name: "Cookie", price: "$3.00" },
    { name: "Box of 6", price: "$15.00" },
    { name: "Sea-salt add-on", price: "+$1.00" },
  ];
  return (
    <div className="landing-rise w-full max-w-[300px] rounded-2xl border border-line bg-surface p-4 shadow-[0_24px_48px_-24px_rgb(0_0_0/0.25)]" style={delay(900)}>
      <div className="flex items-center justify-between">
        <span className="text-[15px] font-semibold text-ink">Maya&apos;s Cookies</span>
        <span className="flex items-center gap-1.5 text-[12px] font-medium text-pos">
          <span className="size-1.5 rounded-full bg-pos" /> Open
        </span>
      </div>
      <ul className="mt-3 divide-y divide-line">
        {items.map((it) => (
          <li key={it.name} className="flex items-center justify-between py-2.5 text-[14px]">
            <span className="text-ink">{it.name}</span>
            <span className="num font-medium text-ink">{it.price}</span>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex h-10 items-center justify-center rounded-full bg-ink text-[13.5px] font-medium text-canvas">Order for pickup</div>
    </div>
  );
}

function HeroVisual() {
  return (
    <div className="landing-rise mx-auto w-full max-w-[880px] overflow-hidden rounded-2xl border border-line bg-surface/70 shadow-[0_40px_80px_-40px_rgb(0_0_0/0.35)] backdrop-blur" style={delay(500)}>
      <div className="flex items-center gap-1.5 border-b border-line px-4 py-3">
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
        <span className="size-2.5 rounded-full bg-line-strong" />
      </div>
      <div className="relative grid grid-cols-1 items-center justify-items-center gap-8 px-6 py-10 @3xl:grid-cols-[1fr_auto_1fr] @3xl:gap-6 @3xl:py-14">
        <PaperSheet />
        <span aria-hidden className="landing-rise text-[22px] text-faint" style={delay(700)}>
          <span className="@3xl:hidden">↓</span>
          <span className="hidden @3xl:inline">→</span>
        </span>
        <div className="relative w-full max-w-[300px]">
          <StorePanel />
          <div
            className="landing-rise absolute -bottom-5 -right-3 flex items-center gap-1.5 rounded-full border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink shadow-[0_8px_24px_-8px_rgb(0_0_0/0.25)] @3xl:-right-8"
            style={delay(1400)}
          >
            <CheckIcon className="text-pos" /> Sale posted · books balance
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- content */

const STEPS = [
  { title: "Snap the paper", body: "A menu, a price list, a sketch. Take a photo, or just talk it through." },
  { title: "Answer a few questions", body: "Only the ones that touch money, most important first." },
  { title: "Open the doors", body: "Storefront, QR codes, checkout, a phone line and real books." },
];

const RULES = ["Books always balance", "Stock never goes negative", "Only you change prices", "Payments post exactly once"];

/* ---------------------------------------------------------------- page */

/** Signed out it offers sign-up and sign-in; mid-setup the caller relabels both to lead back to the setup steps. */
export function Landing({ onStart, onSignIn, startLabel = "Start your business", signInLabel = "Sign in" }: { onStart(): void; onSignIn(): void; startLabel?: string; signInLabel?: string }) {
  return (
    <div className="@container min-h-screen overflow-x-hidden bg-canvas text-ink">
      <div className="landing-sky">
        <header className="sticky top-0 z-30 backdrop-blur-md">
          <nav aria-label="Main" className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 @2xl:px-6">
            <Logo />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onSignIn}
                className="hidden rounded-full px-3 py-1.5 text-[14px] font-medium text-ink hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-accent @md:inline"
              >
                {signInLabel}
              </button>
              <button
                type="button"
                onClick={onStart}
                className="rounded-full bg-ink px-4 py-2 text-[14px] font-medium text-canvas hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                Get started
              </button>
            </div>
          </nav>
        </header>

        <main>
          <section aria-labelledby="hero-title" className="mx-auto max-w-6xl px-4 pb-20 pt-14 text-center @2xl:px-6 @2xl:pt-24 @5xl:pb-28">
            <div className="landing-rise inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-[12.5px] font-medium text-muted backdrop-blur">
              Built at Cal Hacks 13
            </div>
            <h1
              id="hero-title"
              className="landing-rise mx-auto mt-6 max-w-[14ch] text-[44px] font-semibold leading-[1] tracking-[-0.045em] text-ink @2xl:text-[68px] @5xl:text-[84px]"
              style={delay(80)}
            >
              From paper to a running business.
            </h1>
            <p className="landing-rise mx-auto mt-6 max-w-[34rem] text-[16.5px] leading-relaxed text-muted @2xl:text-[18px]" style={delay(160)}>
              Write your idea down, snap a photo, and get a shop that takes payments and keeps its own books. It asks before it assumes.
            </p>
            <div className="landing-rise mt-9 flex flex-col items-center justify-center gap-3 @md:flex-row" style={delay(240)}>
              <Button onClick={onStart} className="w-full @md:w-auto">
                {startLabel}
              </Button>
              <Button onClick={onSignIn} variant="ghost" className="w-full @md:w-auto">
                {signInLabel}
              </Button>
            </div>

            <div className="mt-16 @2xl:mt-20">
              <HeroVisual />
            </div>
          </section>
        </main>
      </div>

      {/* how it works */}
      <section aria-labelledby="how-title" className="mx-auto max-w-6xl px-4 py-20 @2xl:px-6 @2xl:py-28">
        <h2 id="how-title" className="max-w-[18ch] text-[32px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink @2xl:text-[48px]">
          Three steps. About as long as a coffee.
        </h2>
        <ol className="mt-12 grid grid-cols-1 gap-10 @3xl:grid-cols-3 @3xl:gap-8">
          {STEPS.map((s, i) => (
            <li key={s.title} className="border-t border-line-strong pt-5">
              <span className="num text-[13px] font-medium text-faint">0{i + 1}</span>
              <h3 className="mt-3 text-[20px] font-semibold tracking-tight text-ink">{s.title}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* money rules */}
      <section aria-labelledby="rules-title" className="px-4 @2xl:px-6">
        <div className="mx-auto grid max-w-6xl grid-cols-1 gap-12 rounded-3xl bg-ink px-6 py-12 text-canvas @2xl:px-12 @2xl:py-16 @4xl:grid-cols-[1.1fr_1fr] @4xl:items-end">
          <div>
            <h2 id="rules-title" className="max-w-[16ch] text-[32px] font-semibold leading-[1.05] tracking-[-0.035em] @2xl:text-[48px]">
              The AI talks. Code holds the money.
            </h2>
            <p className="mt-5 max-w-md text-[15.5px] leading-relaxed opacity-70">
              Money rules run inside the database, not the prompt. We threw 45 attacks at the AI staff, then swapped the model for a script that obeys the attacker.
            </p>
          </div>
          <div>
            <div className="flex items-baseline gap-3">
              <span className="num text-[88px] font-semibold leading-none tracking-[-0.05em] @2xl:text-[112px]">0</span>
              <span className="text-[15px] leading-snug opacity-70">
                breaches.
                <br />
                $0.00 lost.
              </span>
            </div>
            <ul className="mt-8 grid grid-cols-1 gap-x-6 gap-y-3 border-t border-canvas/15 pt-6 text-[14.5px] @md:grid-cols-2">
              {RULES.map((r) => (
                <li key={r} className="flex items-center gap-2">
                  <CheckIcon className="opacity-60" /> {r}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* final CTA */}
      <section aria-labelledby="cta-title" className="px-4 py-24 text-center @2xl:px-6 @2xl:py-32">
        <h2 id="cta-title" className="text-[32px] font-semibold leading-[1.05] tracking-[-0.035em] text-ink @2xl:text-[48px]">
          Got it on paper?
        </h2>
        <div className="mt-8 flex justify-center">
          <Button onClick={onStart}>{startLabel}</Button>
        </div>
      </section>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-[13px] text-faint @2xl:flex-row @2xl:px-6">
          <Logo />
          <span>paperto.biz · Stripe test mode, no real money moves.</span>
        </div>
      </footer>
    </div>
  );
}
