"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import type { CustomerOrderRow, DecisionRecordRow } from "@/data/types";
import { booksCheck, nextOrderAction, type StockLevel } from "@/lib/reports";
import { stockItems, stockLevelLabel, type StockItemView } from "@/lib/stock";
import { productsUsingStock } from "@/lib/config";
import { newestFirst, refHref, useDocMap, useTz } from "@/lib/hooks";
import { initial, orderItems, paymentWords, shortTime } from "@/lib/orders";
import { formatCents } from "@/lib/money";
import { Empty, OwnerButton, RelTime, StatusBadge, cx, errText, useArrivals } from "./ui";

export function BooksBalance({ large }: { large?: boolean }) {
  const { snapshot, names } = useData();
  const docs = useDocMap();
  const b = booksCheck(snapshot.journalLines);
  const empty = b.lineCount === 0;
  return (
    <div className={cx("rounded-lg border shadow-card", b.balanced ? "border-pos/25 bg-pos-soft" : "border-neg/40 bg-neg-soft")}>
      <div className={cx("flex flex-wrap items-center gap-x-6 gap-y-2", large ? "px-5 py-4" : "px-4 py-3")}>
        <div className={cx("grid shrink-0 place-items-center rounded-full", large ? "size-10" : "size-8", b.balanced ? "bg-pos text-white" : "bg-neg text-white")}>
          {b.balanced ? (
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
              <path d="m5 10.5 3.2 3L15 6.5" />
            </svg>
          ) : (
            <span className="text-[18px] font-bold">!</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className={cx("font-semibold tracking-tight", large ? "text-[17px]" : "text-[15px]", b.balanced ? "text-pos" : "text-neg")}>
            {b.balanced ? "Books balance: debits = credits ✓" : "Books do NOT balance"}
          </div>
          <div className="mt-0.5 text-[12.5px] text-muted">
            {empty ? "No journal lines yet. Every posted document must balance before it is written." : `${b.lineCount} journal lines across ${b.documentCount} posted documents, checked live on every change.`}
          </div>
        </div>
        <div className="flex gap-6">
          <div>
            <div className="text-[11.5px] text-muted">Debits</div>
            <div className="num text-[16px] font-semibold">{formatCents(b.debitCents)}</div>
          </div>
          <div>
            <div className="text-[11.5px] text-muted">Credits</div>
            <div className="num text-[16px] font-semibold">{formatCents(b.creditCents)}</div>
          </div>
          {!b.balanced && (
            <div>
              <div className="text-[11.5px] text-neg">Difference</div>
              <div className="num text-[16px] font-semibold text-neg">{formatCents(b.debitCents - b.creditCents, { sign: true })}</div>
            </div>
          )}
        </div>
      </div>
      {!b.balanced && (
        <div className="border-t border-neg/25 px-5 py-2 text-[12.5px] text-neg">
          {b.unbalancedDocuments.map((u) => (
            <div key={String(u.documentId)}>
              <Link className="underline" href={`/documents/${u.documentId}`}>
                {(() => {
                  const d = docs.get(u.documentId);
                  return d ? `${names.docType(d.docType)} #${d.number}` : `document ${u.documentId}`;
                })()}
              </Link>{" "}
              is off by {formatCents(u.diffCents, { sign: true })}
            </div>
          ))}
          {b.negativeLines > 0 && <div>{b.negativeLines} journal line(s) have a negative side.</div>}
        </div>
      )}
    </div>
  );
}

/** Every stock item with its count, for the dashboard and the Stock page (same numbers on both). */
export function useStockItems(): StockItemView[] {
  const { snapshot, config } = useData();
  const tz = useTz();
  const docs = useDocMap();
  const packs = useMemo(() => productsUsingStock(config?.config), [config]);
  return useMemo(
    () => stockItems(config?.config, snapshot.registerBalances, snapshot.registerMovements, packs, tz, (id) => docs.get(id)),
    [config, snapshot.registerBalances, snapshot.registerMovements, packs, tz, docs],
  );
}

const levelText: Record<StockLevel, string> = { out: "text-neg", critical: "text-neg", low: "text-warn", ok: "text-ink" };
const levelBar: Record<StockLevel, string> = { out: "bg-neg", critical: "bg-neg", low: "bg-warn", ok: "bg-accent" };

/** "94 / 100": what is left of the last fill. */
export function StockCount({ v, className }: { v: Pick<StockItemView, "qty" | "full" | "level">; className?: string }) {
  return (
    <span className={cx("num whitespace-nowrap font-mono text-[13px]", className)}>
      <span className={cx("font-semibold", levelText[v.level])}>{v.qty.toString()}</span>
      <span className="text-faint"> / {v.full.toString()}</span>
    </span>
  );
}

/** The bar under a stock count: blue when fine, amber when running low, red when a pack can't be filled. */
export function StockMeter({ v, className }: { v: Pick<StockItemView, "qty" | "full" | "level" | "name">; className?: string }) {
  const pct = v.full > 0n && v.qty > 0n ? Math.max(2, Math.min(100, Number((v.qty * 1000n) / v.full) / 10)) : 0;
  return (
    <div
      role="meter"
      aria-label={`${v.name} left`}
      aria-valuemin={0}
      aria-valuemax={Number(v.full)}
      aria-valuenow={Number(v.qty)}
      className={cx("h-1.5 overflow-hidden rounded-full bg-surface-2", className)}
    >
      <div className={cx("h-full rounded-full transition-[width] duration-500", levelBar[v.level])} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Dashboard card: each stock item's count and bar. */
export function StockLevels() {
  const { config } = useData();
  const items = useStockItems();
  const placeholder = (config?.config?._unconfirmed?.paths ?? []).some((p) => p.startsWith("initialStock"));
  if (!items.length) return <Empty compact title="No stock on the books yet" hint="Stock appears when the opening balance or a stock receipt is posted." />;
  return (
    <div className="space-y-4 px-5 py-4">
      {items.map((v) => (
        <div key={v.item} title={v.largest ? `“Can’t fill” is below one ${v.largest.name} (${v.largest.units}); “running low” is below two.` : undefined}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 truncate text-[14px] font-medium text-ink">{v.name}</span>
            <StockCount v={v} />
          </div>
          <StockMeter v={v} className="mt-2" />
          {v.level !== "ok" && <div className={cx("mt-1 text-[12px]", levelText[v.level])}>{stockLevelLabel(v)}</div>}
        </div>
      ))}
      {placeholder && <div className="text-[11.5px] text-warn">Starting stock is a placeholder the owner hasn’t confirmed.</div>}
    </div>
  );
}

export function OrderAction({ order, size = "sm" }: { order: CustomerOrderRow; size?: "sm" | "md" }) {
  const { actions } = useData();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const next = nextOrderAction(order);
  if (!next) return null;
  return (
    <span className="inline-flex flex-col items-end" onClick={(e) => e.stopPropagation()}>
      <OwnerButton
        size={size}
        variant={next.status === "ready" ? "primary" : "secondary"}
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setErr(undefined);
          try {
            await actions.updateOrderStatus(order.id, next.status);
          } catch (e) {
            setErr(errText(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Saving…" : next.label}
      </OwnerButton>
      {err && <span className="mt-1 max-w-[220px] text-right text-[11.5px] text-neg">{err}</span>}
    </span>
  );
}

/**
 * Orders as a list people read at a glance: initial, name, what they bought and how they paid, time, total.
 * Paid orders still to prepare are tinted so they stand out. `compact` drops the order number (dashboard).
 */
export function OrdersTable({ orders, compact }: { orders: readonly CustomerOrderRow[]; compact?: boolean }) {
  const router = useRouter();
  const { names } = useData();
  const docs = useDocMap();
  const tz = useTz();
  const now = BigInt(Date.now()) * 1000n;
  const sorted = newestFirst(orders, (o) => o.createdAt.microsSinceUnixEpoch, (o) => o.id);
  const isNew = useArrivals(orders.map((o) => o.id));
  const withActions = sorted.some((o) => nextOrderAction(o));
  if (!sorted.length) return <Empty compact={compact} title="No orders yet" hint="Orders from the storefront, the phone line and agents appear here the moment they are created." />;
  return (
    <ul className="divide-y divide-line">
      {sorted.map((o) => {
        const items = orderItems(docs.get(o.saleDocumentId), names.entry);
        const href = `/orders/${encodeURIComponent(o.id)}`;
        const time = shortTime(o.createdAt.microsSinceUnixEpoch, tz, now);
        return (
          <li
            key={o.id}
            role="link"
            tabIndex={0}
            onClick={() => router.push(href)}
            onKeyDown={(e) => e.key === "Enter" && router.push(href)}
            className={cx(
              "flex cursor-pointer items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none sm:gap-4",
              o.status === "paid" && "bg-accent-soft/50",
              isNew(o.id) && "arrive",
            )}
          >
            <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-accent-soft text-[15px] font-semibold text-accent-ink">
              {initial(o.customerName)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2 overflow-hidden">
                <span className="min-w-[3rem] truncate text-[15px] font-semibold text-ink">{o.customerName || "Customer"}</span>
                {/* payment states are already in the line below; the badge is for the steps the owner acts on */}
                {(o.status === "paid" || o.status === "ready") && <StatusBadge status={o.status} />}
              </div>
              <div className="truncate text-[13px] text-muted">
                {[items || (compact ? "" : o.id), paymentWords(o)].filter(Boolean).join(" · ")}
              </div>
              {/* on a phone the button sits under the text, so the row keeps room for the name */}
              {nextOrderAction(o) && (
                <div className="mt-2 sm:hidden">
                  <OrderAction order={o} />
                </div>
              )}
            </div>
            <div className="hidden w-[4.5rem] shrink-0 text-right sm:block">
              <div className="num whitespace-nowrap font-mono text-[12.5px] text-faint">{time}</div>
              {!compact && items && <div className="font-mono text-[11px] text-faint">{o.id}</div>}
            </div>
            <div className="shrink-0 text-right sm:w-20">
              <div className={cx("num text-[17px] font-semibold", o.status === "cancelled" || o.status === "refunded" ? "text-faint line-through" : "text-ink")}>{formatCents(o.totalCents)}</div>
              <div className="num whitespace-nowrap font-mono text-[11.5px] text-faint sm:hidden">{time}</div>
            </div>
            {/* one fixed-width slot on every row once any order has a button, so the totals line up */}
            {withActions && (
              <div className="hidden w-[124px] shrink-0 justify-end sm:flex">
                <OrderAction order={o} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function DecisionItem({ d }: { d: DecisionRecordRow }) {
  const ref = refHref(d.documentRef);
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={d.outcome} />
        <span className="font-medium">{d.actorId}</span>
        <span className="text-muted">{d.action.replace(/_/g, " ")}</span>
        <span className="flex-1" />
        <RelTime ts={d.timestamp} />
      </div>
      <div className="mt-1 text-[12.5px] text-ink">{d.reason || <span className="text-faint">No reason recorded</span>}</div>
      {(d.ruleIds.length > 0 || ref) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {d.ruleIds.map((r) => (
            <span key={r} className="rounded bg-surface-2 px-1.5 py-px font-mono text-[11px] text-muted">
              {r}
            </span>
          ))}
          {ref && (
            <Link href={ref.href} className="text-[12px] text-accent-ink hover:underline">
              {ref.label} →
            </Link>
          )}
        </div>
      )}
      {d.wouldChangeIf && (
        <div className="mt-1.5 text-[12px] text-muted">
          <span className="font-medium text-faint">Would change if: </span>
          {d.wouldChangeIf}
        </div>
      )}
    </div>
  );
}

export function DecisionFeed({ limit, rows }: { limit?: number; rows?: readonly DecisionRecordRow[] }) {
  const { snapshot } = useData();
  const all = newestFirst(rows ?? snapshot.decisions, (d) => d.timestamp.microsSinceUnixEpoch, (d) => d.id);
  const list = limit ? all.slice(0, limit) : all;
  const isNew = useArrivals(all.map((d) => d.id));
  if (!list.length) return <Empty compact title="No decisions recorded yet" hint="Every agent tool call — allowed, refused or escalated — writes a DecisionRecord here." />;
  return (
    <div className="divide-y divide-line">
      {list.map((d) => (
        <div key={String(d.id)} className={cx(isNew(d.id) && "arrive")}>
          <DecisionItem d={d} />
        </div>
      ))}
    </div>
  );
}
