"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, cx } from "@/components/ui";
import { formatCents } from "@/lib/money";
import { dayIn } from "@/lib/reports";
import { CHART_DAYS, relativeDay, salesSeries, type SalesBucket } from "@/lib/sales";
import { useTz } from "@/lib/hooks";

const orderWords = (n: number) => `${n} ${n === 1 ? "order" : "orders"}`;

/** Net sales per day for the last two weeks (or per hour while the shop is new). Tap a bar for that day's numbers. */
export function SalesChart() {
  const { snapshot } = useData();
  const tz = useTz();
  // Recomputed at most once a minute, so the current hour moves on without redoing the sums every render.
  const minute = Math.floor(Date.now() / 60_000);
  const now = BigInt(minute) * 60_000_000n;
  const s = useMemo(() => salesSeries(snapshot.journalLines, snapshot.orders, tz, BigInt(minute) * 60_000_000n), [snapshot.journalLines, snapshot.orders, tz, minute]);
  const [picked, setPicked] = useState<string>();
  const [hover, setHover] = useState<string>();
  const shown = s.buckets.find((b) => b.key === (hover ?? picked));

  const today = dayIn(now, tz);
  const period = s.mode === "day" ? `Last ${CHART_DAYS} days` : relativeDay(s.day, today);
  const max = s.buckets.reduce((m, b) => (b.netCents > m ? b.netCents : m), 0n);
  // One bar stands out: the picked one, else today (or the current hour).
  const lit = (b: SalesBucket) => (picked ? b.key === picked : b.current);

  return (
    <Card
      title={s.mode === "day" ? `Sales, last ${CHART_DAYS} days` : `Sales by hour · ${period}`}
      actions={
        <Link href="/reports#pnl" className="text-accent-ink hover:underline">
          Reports
        </Link>
      }
    >
      <div aria-live="polite" className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[12.5px] text-muted">{shown ? (s.mode === "day" ? shown.long : `${period}, ${shown.long}`) : period}</span>
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
        <div className="flex h-40 items-end gap-1 pt-4 sm:gap-1.5" role="group" aria-label={`Net sales, ${period.toLowerCase()}`} onMouseLeave={() => setHover(undefined)}>
          {s.buckets.map((b) => (
            <Bar
              key={b.key}
              b={b}
              max={max}
              on={b.key === picked}
              lit={lit(b)}
              label={s.mode === "day" ? b.long : `${period}, ${b.long}`}
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
            <span key={b.key} className={cx("num flex-1 text-center text-[11px]", lit(b) ? "font-semibold text-ink" : "text-faint")}>
              {s.mode === "day" || Number(b.key.slice(-2)) % 3 === 0 || i === 0 ? b.short : ""}
            </span>
          ))}
        </div>
      </div>
      {s.mode === "hour" && <p className="mt-3 text-[12px] text-faint">The day-by-day view starts once you have 3 days of sales.</p>}
    </Card>
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
