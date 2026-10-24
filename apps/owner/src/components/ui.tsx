"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { formatCents } from "@/lib/money";
import { useData } from "@/data/context";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-[19px] font-semibold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-0.5 text-[13px] text-muted">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, actions, children, className, pad = true, id }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; id?: string }) {
  return (
    <section id={id} className={cx("min-w-0 rounded-lg border border-line bg-surface shadow-card", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</h2>
          {actions && <div className="flex items-center gap-2 text-[12px]">{actions}</div>}
        </header>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "pos" | "neg" | "warn" | "info" | "accent";
const toneCls: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line",
  pos: "bg-pos-soft text-pos border-transparent",
  neg: "bg-neg-soft text-neg border-transparent",
  warn: "bg-warn-soft text-warn border-transparent",
  info: "bg-info-soft text-info border-transparent",
  accent: "bg-accent-soft text-accent-ink border-transparent",
};

export function Badge({ tone = "neutral", children, title, className }: { tone?: Tone; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-px text-[11.5px] font-medium leading-[18px]", toneCls[tone], className)}>
      {children}
    </span>
  );
}

const statusTone: Record<string, Tone> = {
  draft: "warn",
  posted: "pos",
  reversed: "neutral",
  pending_payment: "warn",
  paid: "info",
  ready: "accent",
  picked_up: "pos",
  refunded: "neutral",
  partially_refunded: "warn",
  cancelled: "neutral",
  open: "warn",
  answered: "pos",
  queued: "warn",
  confirmed: "pos",
  rejected: "neg",
  applied: "pos",
  allowed: "pos",
  executed: "pos",
  refused: "neg",
  escalated: "warn",
  failed: "neg",
  pending: "warn",
  active: "pos",
  superseded: "neutral",
  claimed: "info",
  done: "pos",
  closed: "neutral",
};

export function StatusBadge({ status }: { status: string }) {
  return <Badge tone={statusTone[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

export function Money({ cents, className, sign, muted0 }: { cents: bigint; className?: string; sign?: boolean; muted0?: boolean }) {
  return <span className={cx("num", cents < 0n && "text-neg", muted0 && cents === 0n && "text-faint", className)}>{formatCents(cents, { sign })}</span>;
}

export function Stat({ label, value, sub, tone, href }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: Tone; href?: string }) {
  const inner = (
    <div className="flex h-full flex-col justify-between gap-1 rounded-lg border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-line-strong">
      <div className="text-[12px] font-medium text-muted">{label}</div>
      <div className={cx("num text-[22px] font-semibold tracking-tight", tone === "neg" ? "text-neg" : tone === "pos" ? "text-pos" : "text-ink")}>{value}</div>
      {sub && <div className="truncate text-[12px] text-faint">{sub}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block min-w-0">
      {inner}
    </Link>
  ) : (
    <div className="min-w-0">{inner}</div>
  );
}

export function Empty({ title, hint, compact }: { title: ReactNode; hint?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("flex flex-col items-center justify-center text-center", compact ? "py-6" : "py-12")}>
      <div className="text-[13px] font-medium text-muted">{title}</div>
      {hint && <div className="mt-1 max-w-md text-[12.5px] text-faint">{hint}</div>}
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-[12.5px] text-faint">
      <span className="size-1.5 animate-pulse rounded-full bg-accent" /> {label}
    </div>
  );
}

type Variant = "primary" | "secondary" | "ghost" | "danger";
const variantCls: Record<Variant, string> = {
  primary: "bg-accent text-white hover:opacity-90 border-transparent",
  secondary: "bg-surface text-ink border-line-strong hover:bg-surface-2",
  ghost: "bg-transparent text-muted border-transparent hover:bg-surface-2 hover:text-ink",
  danger: "bg-surface text-neg border-line-strong hover:bg-neg-soft",
};

export function Button({ variant = "secondary", className, disabledReason, children, size = "md", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; disabledReason?: string; size?: "sm" | "md" }) {
  const disabled = rest.disabled || !!disabledReason;
  const btn = (
    <button
      {...rest}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border font-medium transition-[background,opacity] disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-[12px]" : "h-8 px-3 text-[13px]",
        variantCls[variant],
        className,
      )}
    >
      {children}
    </button>
  );
  if (!disabledReason) return btn;
  return <Tip text={disabledReason}>{btn}</Tip>;
}

/** Hover/focus tooltip that also works on disabled buttons (wraps them in a focusable span). */
export function Tip({ text, children }: { text: string; children: ReactNode }) {
  return (
    <span className="group relative inline-flex" tabIndex={0} aria-label={text}>
      {children}
      <span role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 w-max max-w-[240px] -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-[11.5px] font-medium text-canvas opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100">
        {text}
      </span>
    </span>
  );
}

/** A button for owner-only actions: disabled with an explanation until the owner signs in. */
export function OwnerButton(props: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; reason?: string }) {
  const { isOwner } = useData();
  const { reason, ...rest } = props;
  return <Button {...rest} disabledReason={!isOwner ? "Sign in as the owner to do this" : reason} />;
}

export const tableCls = "w-full border-collapse text-left text-[12.5px]";
export const thCls = "sticky top-0 z-[1] border-b border-line bg-surface px-3 py-2 text-[11.5px] font-medium text-muted whitespace-nowrap";
export const tdCls = "border-b border-line px-3 py-2 align-top";
export const rowLinkCls = "cursor-pointer transition-colors hover:bg-surface-2";

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx("font-mono text-[11.5px] text-muted", className)}>{children}</span>;
}

export function shortId(hex: string | undefined) {
  if (!hex) return "—";
  return `${hex.slice(0, 6)}…${hex.slice(-4)}`;
}

/** Timestamp-ish -> Date. Accepts SpacetimeDB Timestamp. */
export function toDate(ts: { microsSinceUnixEpoch: bigint } | undefined): Date | undefined {
  return ts ? new Date(Number(ts.microsSinceUnixEpoch / 1000n)) : undefined;
}

export function fmtTime(ts: { microsSinceUnixEpoch: bigint } | undefined, timeZone?: string): string {
  const d = toDate(ts);
  if (!d) return "—";
  const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return d.toLocaleString("en-US", { ...opts, timeZone });
  } catch {
    return d.toLocaleString("en-US", opts);
  }
}

export function RelTime({ ts }: { ts: { microsSinceUnixEpoch: bigint } | undefined }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const d = toDate(ts);
  if (!d) return <span className="text-faint">—</span>;
  const s = Math.max(0, Math.round((now - d.getTime()) / 1000));
  const txt = s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  return (
    <time className="whitespace-nowrap text-faint" title={d.toLocaleString()} dateTime={d.toISOString()}>
      {txt}
    </time>
  );
}

/** Adds the "arrive" flash to rows that appear after first render (live updates). */
export function useArrivals<K>(keys: readonly K[]): (k: K) => boolean {
  const { session } = useData();
  const seen = useRef<Set<K> | null>(null);
  const fresh = useRef<Set<K>>(new Set());
  if (!session.ready) return () => false;
  if (seen.current === null) {
    seen.current = new Set(keys);
  } else {
    for (const k of keys) {
      if (!seen.current.has(k)) {
        seen.current.add(k);
        fresh.current.add(k);
      }
    }
  }
  return (k: K) => fresh.current.has(k);
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-[11.5px] font-medium text-faint">{label}</div>
      <div className="mt-0.5 break-words text-[13px] text-ink">{children}</div>
    </div>
  );
}

export function ErrorNote({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <div className="mt-2 rounded-md border border-neg/30 bg-neg-soft px-3 py-2 text-[12.5px] text-neg">{error}</div>;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
