"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import type { CustomerOrderRow, DecisionRecordRow } from "@/data/types";
import { booksCheck, nextOrderAction, stockLevel, stockRows, type StockLevel } from "@/lib/reports";
import { productsUsingStock } from "@/lib/config";
import { newestFirst, refHref, useDocMap } from "@/lib/hooks";
import { formatCents } from "@/lib/money";
import { Badge, Empty, Money, OwnerButton, RelTime, StatusBadge, cx, errText, rowLinkCls, tableCls, tdCls, thCls, useArrivals } from "./ui";

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

const levelTone: Record<StockLevel, "neg" | "warn" | "pos"> = { out: "neg", critical: "neg", low: "warn", ok: "pos" };

export function StockLevels() {
  const { snapshot, names, config } = useData();
  const packs = useMemo(() => productsUsingStock(config?.config), [config]);
  const rows = stockRows(snapshot.registerBalances);
  const unconfirmed = new Set(config?.config?._unconfirmed?.paths ?? []);
  if (!rows.length) return <Empty compact title="No stock on the books yet" hint="Stock appears when the opening balance or a stock receipt is posted." />;
  return (
    <div className="divide-y divide-line">
      {rows.map((r) => {
        const usedBy = packs.get(r.item) ?? [];
        const largest = usedBy.reduce<(typeof usedBy)[number] | undefined>((m, p) => (!m || p.units > m.units ? p : m), undefined);
        const lvl = stockLevel(r.qty, largest?.units);
        const fits = usedBy.map((p) => `${p.name}: ${r.qty > 0n ? r.qty / p.units : 0n}`).join(" · ");
        return (
          <div key={r.key} className={cx("flex items-center gap-3 px-4 py-2.5", lvl !== "ok" && (lvl === "low" ? "bg-warn-soft/60" : "bg-neg-soft/60"))}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{names.entry(r.item)}</div>
              <div className="truncate text-[12px] text-faint">{fits ? `Can fill → ${fits}` : r.item}</div>
            </div>
            <div className="text-right">
              <div className={cx("num text-[18px] font-semibold", lvl === "out" || lvl === "critical" ? "text-neg" : lvl === "low" ? "text-warn" : "")}>{r.qty.toString()}</div>
              <div className="text-[11.5px] text-faint">
                <Money cents={r.amountCents} /> at cost
              </div>
            </div>
            <Badge
              tone={levelTone[lvl]}
              title={largest ? `Display only: "critical" below one ${largest.name} (${largest.units}), "low" below two.` : "No product draws on this item"}
            >
              {lvl === "out" ? "Out" : lvl === "critical" ? `Can’t fill ${largest?.name ?? "pack"}` : lvl === "low" ? "Low" : "OK"}
            </Badge>
          </div>
        );
      })}
      {[...unconfirmed].some((p) => p.startsWith("initialStock")) && (
        <div className="px-4 py-2 text-[11.5px] text-warn">Starting stock is a placeholder the owner hasn’t confirmed.</div>
      )}
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

export function OrdersTable({ orders, compact }: { orders: readonly CustomerOrderRow[]; compact?: boolean }) {
  const router = useRouter();
  const sorted = newestFirst(orders, (o) => o.createdAt.microsSinceUnixEpoch, (o) => o.id);
  const isNew = useArrivals(orders.map((o) => o.id));
  if (!sorted.length) return <Empty compact={compact} title="No orders yet" hint="Orders from the storefront, the phone line and agents appear here the moment they are created." />;
  return (
    <div className="overflow-x-auto">
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>Order</th>
            <th className={thCls}>Customer</th>
            {!compact && <th className={thCls}>Channel</th>}
            <th className={thCls}>Status</th>
            <th className={cx(thCls, "text-right")}>Total</th>
            {!compact && <th className={cx(thCls, "text-right")}>Refunded</th>}
            <th className={thCls}>Created</th>
            <th className={cx(thCls, "text-right")} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((o) => (
            <tr key={o.id} className={cx(rowLinkCls, isNew(o.id) && "arrive")} onClick={() => router.push(`/orders/${encodeURIComponent(o.id)}`)}>
              <td className={tdCls}>
                <span className="font-mono text-[12px] font-medium">{o.id}</span>
              </td>
              <td className={tdCls}>{o.customerName || <span className="text-faint">—</span>}</td>
              {!compact && <td className={cx(tdCls, "text-muted")}>{o.channel}</td>}
              <td className={tdCls}>
                <StatusBadge status={o.status} />
              </td>
              <td className={cx(tdCls, "text-right")}>
                <Money cents={o.totalCents} />
              </td>
              {!compact && (
                <td className={cx(tdCls, "text-right")}>
                  <Money cents={o.refundedCents} muted0 />
                </td>
              )}
              <td className={tdCls}>
                <RelTime ts={o.createdAt} />
              </td>
              <td className={cx(tdCls, "py-1.5 text-right")}>
                <OrderAction order={o} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
