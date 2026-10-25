"use client";

import type { CSSProperties, ReactNode } from "react";

/*
 * Public marketing page for Napkin Inc.
 * Every number on this page comes from README.md, docs/INVARIANTS.md or redteam/RESULTS.md.
 */

function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

const delay = (ms: number): CSSProperties => ({ animationDelay: `${ms}ms` });

/* ---------------------------------------------------------------- shared bits */

function PrimaryCta({ onClick, children, className }: { onClick(): void; children: ReactNode; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        "group inline-flex h-12 items-center justify-center gap-2 rounded-xl bg-ink px-6 text-[15px] font-semibold text-canvas shadow-[0_8px_24px_-8px_rgb(0_0_0/0.35)] transition-[transform,opacity] hover:opacity-90 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
      <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
        →
      </span>
    </button>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return <div className="text-[12px] font-semibold uppercase tracking-[0.14em] text-accent-ink">{children}</div>;
}

function SectionHead({ eyebrow, title, sub, id }: { eyebrow: string; title: ReactNode; sub?: ReactNode; id: string }) {
  return (
    <div className="mx-auto mb-10 max-w-2xl text-center @2xl:mb-14">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h2 id={id} className="mt-3 text-[28px] font-semibold leading-[1.15] tracking-tight text-ink @2xl:text-[38px]">
        {title}
      </h2>
      {sub && <p className="mt-4 text-[15.5px] leading-relaxed text-muted @2xl:text-[17px]">{sub}</p>}
    </div>
  );
}

type Prov = "paper" | "said" | "unknown";
const provCls: Record<Prov, string> = {
  paper: "bg-info-soft text-info",
  said: "bg-pos-soft text-pos",
  unknown: "bg-warn-soft text-warn",
};
const provLabel: Record<Prov, string> = { paper: "read from paper", said: "you said it", unknown: "not known yet" };

function ProvTag({ p, className }: { p: Prov; className?: string }) {
  return (
    <span className={cx("inline-flex items-center whitespace-nowrap rounded-[5px] px-1.5 text-[11px] font-medium leading-[18px]", provCls[p], className)}>
      {provLabel[p]}
    </span>
  );
}

/* ---------------------------------------------------------------- hero visual */

function NapkinCard() {
  const lines: { text: string; mark?: "info" | "pos" }[] = [
    { text: "Maya's Cookies" },
    { text: "cookie ....... $3", mark: "info" },
    { text: "box of 6 ..... $15", mark: "info" },
    { text: "+ sea salt  +$1", mark: "pos" },
    { text: "pickup? phone orders!" },
  ];
  return (
    <div className="landing-napkin relative w-[250px] rotate-[-4deg] rounded-[6px] p-5 @2xl:w-[240px]">
      <div aria-hidden className="landing-napkin-fold" />
      <div className="landing-hand relative space-y-1.5 text-[19px] leading-snug text-[#2b2a6e]">
        {lines.map((l, i) => (
          <div key={l.text} className={cx("landing-write", i === 0 && "mb-2 text-[23px] underline decoration-[#2b2a6e]/40 decoration-wavy underline-offset-4")} style={delay(150 + i * 220)}>
            <span
              className={cx(
                "rounded-sm px-0.5",
                l.mark === "info" && "shadow-[inset_0_-0.45em_0_rgb(31_111_178/0.18)]",
                l.mark === "pos" && "shadow-[inset_0_-0.45em_0_rgb(18_128_92/0.18)]",
              )}
            >
              {l.text}
            </span>
          </div>
        ))}
        <div aria-hidden className="landing-write absolute -right-1 bottom-0 text-[26px]" style={delay(1300)}>
          ☺
        </div>
      </div>
    </div>
  );
}

function StoreCard() {
  const items: { name: string; price: string; p: Prov }[] = [
    { name: "Cookie", price: "$3.00", p: "paper" },
    { name: "Box of 6", price: "$15.00", p: "paper" },
    { name: "Sea-salt add-on", price: "+$1.00", p: "said" },
  ];
  return (
    <div className="landing-rise w-full rounded-2xl border border-line bg-surface p-4 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.25)]" style={delay(900)}>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Storefront · live</div>
          <div className="truncate text-[16px] font-semibold text-ink">Maya&apos;s Cookies</div>
        </div>
        <QrGlyph />
      </div>
      <ul className="mt-3 divide-y divide-line">
        {items.map((it) => (
          <li key={it.name} className="flex items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-medium text-ink">{it.name}</div>
              <ProvTag p={it.p} className="mt-0.5" />
            </div>
            <span className="num text-[14px] font-semibold text-ink">{it.price}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 rounded-lg bg-surface-2 px-3 py-2">
        <span className="whitespace-nowrap text-[12.5px] text-muted">Cost of a cookie</span>
        <span className="flex items-center gap-1.5 whitespace-nowrap">
          <ProvTag p="unknown" />
          <span className="text-[12px] font-medium text-accent-ink">asks you</span>
        </span>
      </div>
    </div>
  );
}

function QrGlyph() {
  // Decorative 7x7 QR-like glyph.
  const on = "1111111100000110111011011101101110110000011111111".split("");
  return (
    <div aria-hidden className="grid size-11 shrink-0 grid-cols-7 gap-px rounded-md border border-line bg-surface p-1">
      {on.map((c, i) => (
        <span key={i} className={c === "1" ? "rounded-[1px] bg-ink" : ""} />
      ))}
    </div>
  );
}

function LedgerCard() {
  return (
    <div className="landing-rise w-full rounded-2xl border border-line bg-surface p-4 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.25)]" style={delay(1300)}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.1em] text-faint">Sale · box of 6</div>
        <span className="inline-flex items-center gap-1 rounded-[5px] bg-pos-soft px-1.5 text-[11px] font-medium leading-[18px] text-pos">posted</span>
      </div>
      <table className="mt-2 w-full text-[12.5px]">
        <caption className="sr-only">Example double-entry journal entry</caption>
        <thead>
          <tr className="text-left text-[11px] text-faint">
            <th scope="col" className="pb-1 font-medium">Account</th>
            <th scope="col" className="pb-1 text-right font-medium">Dr</th>
            <th scope="col" className="pb-1 text-right font-medium">Cr</th>
          </tr>
        </thead>
        <tbody className="num text-ink">
          <tr className="border-t border-line">
            <td className="py-1.5">Stripe clearing</td>
            <td className="py-1.5 text-right">15.00</td>
            <td className="py-1.5 text-right text-faint">–</td>
          </tr>
          <tr className="border-t border-line">
            <td className="py-1.5 pl-3">Sales</td>
            <td className="py-1.5 text-right text-faint">–</td>
            <td className="py-1.5 text-right">15.00</td>
          </tr>
        </tbody>
      </table>
      <div className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-pos">
        <CheckIcon /> Debits = credits
      </div>
    </div>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 20 20" className={cx("size-4 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 10.5l3.5 3.5 7.5-8" />
    </svg>
  );
}

function HeroVisual() {
  return (
    <div className="relative isolate mx-auto w-full max-w-[600px]">
      <div aria-hidden className="landing-glow pointer-events-none absolute -inset-10 -z-10" />
      <div className="grid grid-cols-1 items-center gap-6 @2xl:grid-cols-[auto_minmax(0,1fr)] @2xl:gap-9">
        <div className="flex justify-center @2xl:block">
          <NapkinCard />
        </div>
        <div className="relative flex flex-col gap-3">
          <div aria-hidden className="landing-rise absolute -left-7 top-1/2 hidden -translate-y-1/2 text-[22px] text-faint @2xl:block" style={delay(700)}>
            ⟶
          </div>
          <div aria-hidden className="landing-rise -mt-2 text-center text-[22px] text-faint @2xl:hidden" style={delay(700)}>
            ↓
          </div>
          <StoreCard />
          <LedgerCard />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- sections */

const STEPS: { n: string; title: string; body: ReactNode; icon: ReactNode }[] = [
  {
    n: "1",
    title: "Snap the napkin",
    body: "Take a photo of your sketch, talk it through, or both. Napkin reads the menu, the prices and the plan, and marks where each fact came from.",
    icon: <path d="M4 6h3l1.5-2h3L13 6h3v10H4zM10 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />,
  },
  {
    n: "2",
    title: "Answer the money questions",
    body: "One question at a time, most important first. Nothing it guessed is used for money until you confirm it.",
    icon: <path d="M4 4h12v9H9l-3 3v-3H4z" />,
  },
  {
    n: "3",
    title: "Go live",
    body: "A storefront with QR codes, checkout, an AI phone line, AI staff and a back office with real double-entry books.",
    icon: <path d="M11 3 4 11h5l-1 6 7-8h-5z" />,
  },
];

const FEATURES: { title: string; body: string; icon: ReactNode }[] = [
  {
    title: "Storefront + QR codes",
    body: "A shop page for your menu and printable QR codes for the counter, the window and the flyer.",
    icon: <path d="M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h2v2h-2zM15 15h2v2h-2zM12 15h1M15 12h2" />,
  },
  {
    title: "Real checkout",
    body: "Stripe checkout in test mode, with payments posted to the books exactly once.",
    icon: <path d="M2.5 5h15v10h-15zM2.5 8.5h15M5.5 12.5h3" />,
  },
  {
    title: "An AI phone line",
    body: "Customers call and order. Owner instructions given by phone are queued for you to confirm in the app.",
    icon: <path d="M5 3h3l1.5 4-2 1.2a8 8 0 0 0 4.3 4.3l1.2-2 4 1.5v3a1.5 1.5 0 0 1-1.6 1.5C9 16 4 11 3.5 4.6A1.5 1.5 0 0 1 5 3z" />,
  },
  {
    title: "AI staff",
    body: "A Shopkeeper, Support and a Bookkeeper. Each acts only through guarded tools and leaves a decision record.",
    icon: <path d="M7 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM2.5 16c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5M13.5 8a2 2 0 1 0 0-4M14.5 11.5c1.8.4 3 2.1 3 4.5" />,
  },
  {
    title: "A 1C-style back office",
    body: "Documents, registers and double-entry books. Posted documents never change; corrections are reversals.",
    icon: <path d="M6 2.5h6l3 3V17.5H6zM12 2.5v3h3M8.5 9.5h4M8.5 12.5h4" />,
  },
  {
    title: "Live on SpacetimeDB",
    body: "Orders, stock and the ledger update in real time, and the money rules run inside the database transaction.",
    icon: <path d="M10 3c3.9 0 7 1.1 7 2.5S13.9 8 10 8 3 6.9 3 5.5 6.1 3 10 3zM3 5.5v9C3 15.9 6.1 17 10 17s7-1.1 7-2.5v-9M3 10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />,
  },
];

const INVARIANTS: { title: string; body: string }[] = [
  { title: "Books always balance", body: "Every posted document's debits equal its credits." },
  { title: "Ledger cash = processor truth", body: "Stripe clearing plus payouts equals what the processor reports." },
  { title: "Stock never goes negative", body: "Unless you choose to allow backorders." },
  { title: "Margin floor, proven with Z3", body: "No sale nets below cost × (1 + floor). Checked again on every sale and refund." },
  { title: "Segregation of duties", body: "Whoever creates a document can't approve it when the document type says so." },
  { title: "Only you change prices and policies", body: "Through the owner-authenticated channel. Untrusted text never changes policy." },
  { title: "Exactly-once payments", body: "Processor events are de-duplicated in the same transaction as posting." },
  { title: "Posted documents are immutable", body: "Corrections are reversals, and closed periods can't be posted to." },
  { title: "Agents go through the guards", body: "Platform document APIs only, each action with a decision record." },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent-ink">
      <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}

function BreachBar({ label, value, max, tone }: { label: string; value: number; max: number; tone: "neg" | "pos" }) {
  const pct = max === 0 ? 0 : (value / max) * 100;
  return (
    <div className="grid grid-cols-[72px_1fr_auto] items-center gap-3">
      <span className="text-[12.5px] font-medium text-muted">{label}</span>
      <span className="h-2.5 overflow-hidden rounded-full bg-surface-2">
        <span className={cx("block h-full rounded-full", tone === "neg" ? "bg-neg" : "bg-pos")} style={{ width: `${Math.max(pct, value === 0 ? 0 : 4)}%` }} />
      </span>
      <span className={cx("num w-10 text-right text-[26px] font-semibold leading-none tracking-tight", tone === "neg" ? "text-neg" : "text-pos")}>{value}</span>
    </div>
  );
}

function RedTeamCard({ title, sub, baseline, napkin, max }: { title: string; sub: string; baseline: number; napkin: number; max: number }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5 shadow-card">
      <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-[13px] leading-relaxed text-muted">{sub}</p>
      <div className="mt-4 space-y-2.5" role="img" aria-label={`Breaches: baseline ${baseline}, Napkin ${napkin}`}>
        <BreachBar label="Baseline" value={baseline} max={max} tone="neg" />
        <BreachBar label="Napkin" value={napkin} max={max} tone="pos" />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- page */

export function Landing({ onStart, onSignIn }: { onStart(): void; onSignIn(): void }) {
  return (
    <div className="@container min-h-screen overflow-x-hidden bg-canvas text-ink">
      {/* nav */}
      <header className="sticky top-0 z-30 border-b border-line/70 bg-canvas/80 backdrop-blur-md">
        <nav aria-label="Main" className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 @2xl:px-6">
          <span className="flex items-center gap-2 text-[16px] font-semibold tracking-tight text-ink">
            <span aria-hidden className="text-[20px]">🧻</span> Napkin Inc.
          </span>
          <div className="flex items-center gap-1 @2xl:gap-5">
            <a href="#how" className="hidden text-[13.5px] text-muted hover:text-ink @2xl:inline">
              How it works
            </a>
            <a href="#rules" className="hidden text-[13.5px] text-muted hover:text-ink @2xl:inline">
              Money rules
            </a>
            <button
              type="button"
              onClick={onSignIn}
              className="rounded-md px-2.5 py-1.5 text-[13.5px] font-medium text-ink hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              Sign in
            </button>
          </div>
        </nav>
      </header>

      <main>
        {/* hero */}
        <section aria-labelledby="hero-title" className="relative">
          <div aria-hidden className="landing-grid pointer-events-none absolute inset-0 -z-0" />
          <div className="relative mx-auto grid max-w-6xl grid-cols-1 items-center gap-12 px-4 pb-16 pt-12 @2xl:px-6 @2xl:pt-16 @5xl:grid-cols-[1fr_1.12fr] @5xl:gap-8 @5xl:pb-24 @5xl:pt-24">
            <div className="text-center @5xl:text-left">
              <div className="inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-[12px] font-medium text-muted shadow-card">
                <span className="size-1.5 rounded-full bg-pos" /> Built at Cal Hacks 13 · Stripe test mode
              </div>
              <h1 id="hero-title" className="mt-5 text-[40px] font-semibold leading-[1.04] tracking-[-0.03em] text-ink @2xl:text-[56px] @5xl:text-[64px]">
                From a napkin sketch to a <span className="landing-hand-accent">running business</span>.
              </h1>
              <p className="mx-auto mt-5 max-w-xl text-[16px] leading-relaxed text-muted @2xl:text-[18px] @5xl:mx-0">
                Snap the idea you scribbled on a napkin, or just talk it through. In minutes you have a storefront with QR codes, a real checkout, an AI phone line, AI staff and a back office with books that balance.
              </p>
              <div className="mt-8 flex flex-col items-center gap-3 @2xl:flex-row @2xl:justify-center @5xl:justify-start">
                <PrimaryCta onClick={onStart} className="w-full @2xl:w-auto">
                  Start your business
                </PrimaryCta>
                <a href="#rules" className="inline-flex h-12 items-center rounded-xl px-4 text-[14.5px] font-medium text-muted hover:text-ink">
                  Why the AI can&apos;t lose your money
                </a>
              </div>
              <p className="mt-6 text-[13px] text-faint">
                The AI does the talking and judgment. Deterministic code owns the money and the rules.
              </p>
            </div>
            <HeroVisual />
          </div>
        </section>

        {/* how it works */}
        <section id="how" aria-labelledby="how-title" className="scroll-mt-16 border-t border-line bg-surface py-16 @2xl:py-24">
          <div className="mx-auto max-w-6xl px-4 @2xl:px-6">
            <SectionHead id="how-title" eyebrow="How it works" title="Three steps. About as long as a coffee." sub="You bring the idea. Napkin builds the business around it, and asks before it assumes." />
            <ol className="grid grid-cols-1 gap-4 @3xl:grid-cols-3 @3xl:gap-6">
              {STEPS.map((s) => (
                <li key={s.n} className="relative rounded-2xl border border-line bg-canvas p-6">
                  <div className="flex items-center gap-3">
                    <Icon>{s.icon}</Icon>
                    <span className="num text-[13px] font-semibold text-faint">Step {s.n}</span>
                  </div>
                  <h3 className="mt-4 text-[18px] font-semibold tracking-tight text-ink">{s.title}</h3>
                  <p className="mt-2 text-[14.5px] leading-relaxed text-muted">{s.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* what you get */}
        <section aria-labelledby="get-title" className="py-16 @2xl:py-24">
          <div className="mx-auto max-w-6xl px-4 @2xl:px-6">
            <SectionHead id="get-title" eyebrow="What you get" title="A whole business, not a website." sub="Everything is wired together from the first minute: the shop, the phone, the staff and the books." />
            <ul className="grid grid-cols-1 gap-4 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {FEATURES.map((f) => (
                <li key={f.title} className="rounded-2xl border border-line bg-surface p-6 shadow-card transition-colors hover:border-line-strong">
                  <Icon>{f.icon}</Icon>
                  <h3 className="mt-4 text-[16px] font-semibold text-ink">{f.title}</h3>
                  <p className="mt-1.5 text-[14px] leading-relaxed text-muted">{f.body}</p>
                </li>
              ))}
            </ul>

            {/* never assume */}
            <div className="mt-6 grid grid-cols-1 items-center gap-6 rounded-2xl border border-line bg-surface p-6 shadow-card @3xl:grid-cols-[1fr_auto] @3xl:p-8">
              <div>
                <h3 className="text-[20px] font-semibold tracking-tight text-ink">It never assumes.</h3>
                <p className="mt-2 max-w-xl text-[14.5px] leading-relaxed text-muted">
                  Every fact shows where it came from. When something is missing or unclear, the AI staff escalate to you instead of guessing.
                </p>
              </div>
              <div className="flex flex-wrap gap-2 @3xl:justify-end">
                {(["paper", "said", "unknown"] as const).map((p) => (
                  <span key={p} className={cx("inline-flex items-center rounded-lg px-3 py-1.5 text-[13px] font-medium", provCls[p])}>
                    {provLabel[p]}
                  </span>
                ))}
                <span className="inline-flex items-center rounded-lg bg-accent-soft px-3 py-1.5 text-[13px] font-medium text-accent-ink">→ asks the owner</span>
              </div>
            </div>
          </div>
        </section>

        {/* money rules */}
        <section id="rules" aria-labelledby="rules-title" className="scroll-mt-16 border-t border-line bg-surface py-16 @2xl:py-24">
          <div className="mx-auto max-w-6xl px-4 @2xl:px-6">
            <SectionHead
              id="rules-title"
              eyebrow="Money rules the AI can't break"
              title={
                <>
                  Even a compromised model
                  <br className="hidden @2xl:block" /> can&apos;t lose your money.
                </>
              }
              sub="The money rules are enforced by the platform, inside the transaction, not by the prompt. Swap the model, jailbreak it, script it to attack: the books still hold."
            />

            <div className="grid grid-cols-1 gap-4 @3xl:grid-cols-2">
              <RedTeamCard
                title="Real-model attacks"
                sub="45 attacks against the AI staff on the real model: fake discounts, refund abuse, prompt injection, fake payments and more."
                baseline={3}
                napkin={0}
                max={18}
              />
              <RedTeamCard
                title="Compromised model, worst case"
                sub="The same 45 attacks with the model replaced by a script that does exactly what the attacker asks and never refuses."
                baseline={18}
                napkin={0}
                max={18}
              />
            </div>
            <div className="mt-4 flex items-start gap-3 rounded-2xl border border-pos/25 bg-pos-soft px-5 py-4">
              <CheckIcon className="mt-0.5 text-pos" />
              <p className="text-[14px] font-medium leading-relaxed text-pos">
                Napkin: 0 breaches in both runs, $0.00 lost. Duplicate and out-of-order webhooks, crashes and timeouts: every chaos case that ran passed.
              </p>
            </div>
            <p className="mt-3 text-[12.5px] leading-relaxed text-faint">
              Baseline = the same AI staff, prompt and tools with the platform&apos;s enforcement switched off. Measured on a running system; full results in redteam/RESULTS.md.
            </p>

            <h3 className="mt-14 text-center text-[13px] font-semibold uppercase tracking-[0.12em] text-muted">The nine hard invariants</h3>
            <ol className="mt-6 grid grid-cols-1 gap-3 @2xl:grid-cols-2 @5xl:grid-cols-3">
              {INVARIANTS.map((inv, i) => (
                <li key={inv.title} className="flex gap-3 rounded-xl border border-line bg-canvas p-4">
                  <span className="num flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-[12.5px] font-semibold text-accent-ink ring-1 ring-line">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="text-[14.5px] font-semibold text-ink">{inv.title}</div>
                    <div className="mt-0.5 text-[13px] leading-relaxed text-muted">{inv.body}</div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* final CTA */}
        <section aria-labelledby="cta-title" className="py-20 @2xl:py-28">
          <div className="mx-auto max-w-3xl px-4 text-center @2xl:px-6">
            <div aria-hidden className="text-[44px]">🧻</div>
            <h2 id="cta-title" className="mt-3 text-[30px] font-semibold leading-tight tracking-tight text-ink @2xl:text-[44px]">
              Got an idea on a napkin?
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-[16px] leading-relaxed text-muted @2xl:text-[18px]">
              Bring it. We&apos;ll ask the questions that matter, then open the doors.
            </p>
            <div className="mt-8 flex justify-center">
              <PrimaryCta onClick={onStart} className="w-full @2xl:w-auto">
                Start your business
              </PrimaryCta>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-2 px-4 py-6 text-center text-[12.5px] text-faint @2xl:flex-row @2xl:px-6 @2xl:text-left">
          <span>
            <span aria-hidden>🧻</span> Napkin Inc. · Built solo at Cal Hacks 13.0
          </span>
          <span>Payments are Stripe test mode. No real money.</span>
        </div>
      </footer>
    </div>
  );
}
