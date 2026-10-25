"use client";

import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { CHART_DAYS, CHART_WEEKS, pageEnd, periodLabel, salesHistory, salesSeries, type SalesBucket, type SalesView } from "@/lib/sales";
import { useTz } from "@/lib/hooks";

const orderWords = (n: number) => `${n} ${n === 1 ? "order" : "orders"}`;

const VIEWS: { view: SalesView; label: string; back: string; forward: string }[] = [
  { view: "hour", label: "Hourly", back: "Previous day", forward: "Next day" },
  { view: "day", label: "Daily", back: `Previous ${CHART_DAYS} days`, forward: `Next ${CHART_DAYS} days` },
  { view: "week", label: "Weekly", back: `Previous ${CHART_WEEKS} weeks`, forward: `Next ${CHART_WEEKS} weeks` },
];

/** Net sales by hour, day or week, with arrows to page back in time. Tap a bar for its numbers. */
export function SalesChart() {
  const { snapshot } = useData();
  const tz = useTz();
  // Recomputed at most once a minute, so the current hour moves on without redoing the sums every render.
  const minute = Math.floor(Date.now() / 60_000);
  const h = useMemo(() => salesHistory(snapshot.journalLines, tz, BigInt(minute) * 60_000_000n), [snapshot.journalLines, tz, minute]);
  // Until the owner picks a view or pages, follow the default (by hour while the shop is new, then by day).
  const [nav, setNav] = useState<{ view: SalesView; end: string }>();
  const view = nav?.view ?? h.view;
  const end = nav?.end ?? h.end;
  const s = useMemo(
    () => salesSeries(snapshot.journalLines, snapshot.orders, tz, BigInt(minute) * 60_000_000n, view, end),
    [snapshot.journalLines, snapshot.orders, tz, minute, view, end],
  );
  const [picked, setPicked] = useState<string>();
  const [hover, setHover] = useState<string>();
  const shown = s.buckets.find((b) => b.key === (hover ?? picked));

  const go = (next: { view: SalesView; end: string }) => {
    setNav(next);
    setPicked(undefined);
    setHover(undefined);
  };
  const v = VIEWS.find((x) => x.view === view)!;
  const period = periodLabel(s, h.today);
  const canBack = h.first !== undefined && s.start > h.first;
  const canForward = end < h.today;
  const max = s.buckets.reduce((m, b) => (b.netCents > m ? b.netCents : m), 0n);
  // One bar stands out: the picked one, else the current hour, day or week.
  const lit = (b: SalesBucket) => (picked ? b.key === picked : b.current);

  return (
    <Card
      title="Sales"
      actions={
        <div role="group" aria-label="Chart view" className="flex rounded-md border border-line p-0.5">
          {VIEWS.map((x) => (
            <button
              key={x.view}
              type="button"
              aria-pressed={x.view === view}
              onClick={() => go({ view: x.view, end: x.view === "hour" ? (h.last ?? h.today) : h.today })}
              className={cx("rounded px-2.5 py-0.5 text-[12.5px] transition-colors", x.view === view ? "bg-surface-2 font-medium text-ink" : "text-muted hover:text-ink")}
            >
              {x.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <Arrow dir={-1} label={v.back} disabled={!canBack} onClick={() => go({ view, end: pageEnd(view, end, -1, h.today) })} />
          <span className="min-w-0 truncate px-1 text-[13px] font-medium text-ink">{period}</span>
          <Arrow dir={1} label={v.forward} disabled={!canForward} onClick={() => go({ view, end: pageEnd(view, end, 1, h.today) })} />
        </div>
        {end !== h.today && (
          <button type="button" onClick={() => go({ view, end: h.today })} className="shrink-0 text-[12.5px] text-accent-ink hover:underline">
            Today
          </button>
        )}
      </div>

      <div aria-live="polite" className="mt-2 flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12.5px] text-muted">{shown ? shown.long : "Total"}</span>
        <span className={cx("num text-[22px] font-semibold tracking-tight", (shown?.netCents ?? s.totalCents) < 0n ? "text-neg" : "text-ink")}>
          {formatCents(shown?.netCents ?? s.totalCents)}
        </span>
        <span className="text-[12.5px] text-faint">{orderWords(shown?.orders ?? s.totalOrders)}</span>
      </div>

      <div className="relative mt-4">
        {max > 0n && (
          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-2" aria-hidden>
            <span className="h-px flex-1 border-t border-dashed border-line" />
            <span className="num text-[11px] text-faint">{formatCents(max)}</span>
          </div>
        )}
        <div className="flex h-40 items-end gap-1 pt-4 sm:gap-1.5" role="group" aria-label={`Net sales, ${period}`} onMouseLeave={() => setHover(undefined)}>
          {s.buckets.map((b) => (
            <Bar
              key={b.key}
              b={b}
              max={max}
              on={b.key === picked}
              lit={lit(b)}
              label={view === "hour" ? `${period}, ${b.long}` : b.long}
              onPick={() => {
                setPicked((p) => (p === b.key ? undefined : b.key));
                setHover(undefined);
              }}
              onHover={(on) => setHover(on ? b.key : undefined)}
            />
          ))}
        </div>
        <div className="mt-1.5 flex gap-1 sm:gap-1.5" aria-hidden>
          {s.buckets.map((b, i) => (
            // Hours label every third bar; weeks every other one on a phone, where "10/19" is wider than its bar.
            <span
              key={b.key}
              className={cx(
                "num min-w-0 flex-1 whitespace-nowrap text-center text-[11px]",
                view === "week" && i % 2 === 1 && "max-sm:invisible",
                lit(b) ? "font-semibold text-ink" : "text-faint",
              )}
            >
              {view !== "hour" || Number(b.key.slice(-2)) % 3 === 0 || i === 0 ? b.short : ""}
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Arrow({ dir, label, disabled, onClick }: { dir: -1 | 1; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line text-muted transition-colors hover:border-line-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:border-line disabled:hover:text-muted"
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path d={dir < 0 ? "M10 4l-4 4 4 4" : "M6 4l4 4-4 4"} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
}

function Bar({ b, max, on, lit, label, onPick, onHover }: { b: SalesBucket; max: bigint; on: boolean; lit: boolean; label: string; onPick: () => void; onHover: (on: boolean) => void }) {
  const h = max > 0n && b.netCents > 0n ? Math.max(4, Number((b.netCents * 1000n) / max) / 10) : 0;
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={`${label}: ${formatCents(b.netCents)}, ${orderWords(b.orders)}`}
      onClick={onPick}
      onMouseEnter={() => onHover(true)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      className="group flex h-full min-w-0 flex-1 cursor-pointer items-end rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line-strong"
    >
      {h > 0 ? (
        <span
          style={{ height: `${h}%` }}
          className={cx("block w-full rounded-t-[3px] transition-colors", lit ? "bg-accent" : "bg-accent/35 group-hover:bg-accent/60")}
        />
      ) : (
        <span className={cx("block h-[2px] w-full rounded-full", lit ? "bg-accent" : "bg-line group-hover:bg-line-strong")} />
      )}
    </button>
  );
}
