"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useData } from "@/data/context";
import { Card, Loading, PageHeader, Stat } from "@/components/ui";
import { AskBooks } from "@/components/AskBooks";
import { PhoneLine } from "@/components/PhoneLine";
import { OrdersTable, StockLevels } from "@/components/widgets";
import { ACCOUNTS, balanceOf, dayIn, pnl } from "@/lib/reports";
import { formatCents, pct } from "@/lib/money";
import { useTz } from "@/lib/hooks";

export default function DashboardPage() {
  const { snapshot, session, config } = useData();
  const tz = useTz();
  const today = useMemo(() => dayIn(BigInt(Date.now()) * 1000n, tz), [tz]);

  const m = useMemo(() => {
    const lines = snapshot.journalLines;
    const todayLines = lines.filter((l) => dayIn(l.postedAt.microsSinceUnixEpoch, tz) === today);
    const all = pnl(lines);
    const day = pnl(todayLines);
    const ordersToday = snapshot.orders.filter((o) => dayIn(o.createdAt.microsSinceUnixEpoch, tz) === today);
    return {
      all,
      day,
      ordersToday: ordersToday.length,
      awaiting: ordersToday.filter((o) => o.status === "pending_payment").length,
      toFulfil: snapshot.orders.filter((o) => o.status === "paid" || o.status === "ready").length,
      clearing: balanceOf(lines, ACCOUNTS.clearing),
      bank: balanceOf(lines, ACCOUNTS.bank),
      receivable: balanceOf(lines, ACCOUNTS.receivables),
    };
  }, [snapshot.journalLines, snapshot.orders, tz, today]);

  const openInbox = snapshot.inbox.filter((i) => i.status === "open").length;
  const queued = snapshot.ownerStatements.filter((s) => s.status === "queued").length;
  const drafts = snapshot.documents.filter((d) => d.status === "draft" && d.docType !== "sale").length;
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: tz });

  return (
    <>
      <PageHeader
        title={snapshot.business?.name ?? config?.config?.business.name ?? "Dashboard"}
        subtitle={dateLabel}
      />
      {session.mode === "live" && !session.ready ? (
        <Loading label="Syncing the books from SpacetimeDB…" />
      ) : (
        <div className="space-y-6">

          {(openInbox > 0 || queued > 0 || drafts > 0) && (
            <div className="flex flex-wrap gap-2 text-[13.5px]">
              {queued > 0 && (
                <Link href="/inbox#statements" className="rounded-full border border-warn/30 bg-warn-soft px-3.5 py-1.5 font-medium text-warn hover:opacity-90">
                  {queued} phone instruction{queued > 1 ? "s" : ""} need your confirmation →
                </Link>
              )}
              {openInbox > 0 && (
                <Link href="/inbox" className="rounded-full border border-line bg-surface px-3.5 py-1.5 font-medium hover:bg-surface-2">
                  {openInbox} question{openInbox > 1 ? "s" : ""} from your bookkeeper →
                </Link>
              )}
              {drafts > 0 && (
                <Link href="/documents?status=draft" className="rounded-full border border-line bg-surface px-3.5 py-1.5 font-medium hover:bg-surface-2">
                  {drafts} draft{drafts > 1 ? "s" : ""} awaiting approval →
                </Link>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Net sales today" value={formatCents(m.day.netRevenueCents)} sub={`${formatCents(m.all.netRevenueCents)} all time`} href="/reports" />
            <Stat label="Orders today" value={m.ordersToday.toString()} sub={m.awaiting ? `${m.awaiting} awaiting payment · ${m.toFulfil} to fulfil` : `${m.toFulfil} to fulfil`} href="/orders" />
            <Stat label="Cash" value={formatCents(m.bank)} sub={`${formatCents(m.clearing)} on its way from Stripe`} href="/reports" />
            <Stat
              label="Gross margin"
              value={pct(m.all.grossProfitCents, m.all.netRevenueCents)}
              sub={`${formatCents(m.all.grossProfitCents)} profit on ${formatCents(m.all.netRevenueCents)}`}
              tone={m.all.grossProfitCents < 0n ? "neg" : undefined}
              href="/reports"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card
              title="Recent orders"
              pad={false}
              actions={
                <Link href="/orders" className="text-accent-ink hover:underline">
                  All orders
                </Link>
              }
            >
              <div className="max-h-[420px] overflow-y-auto">
                <OrdersTable orders={snapshot.orders.slice()} compact />
              </div>
            </Card>
            <div className="space-y-6">
              <Card
                title="Stock"
                pad={false}
                actions={
                  <Link href="/stock" className="text-accent-ink hover:underline">
                    All stock
                  </Link>
                }
              >
                <StockLevels />
              </Card>
              <PhoneLine businessId={snapshot.businessId} />
            </div>
          </div>

          {snapshot.businessId && (
            <Card title="Ask your books">
              <AskBooks businessId={snapshot.businessId} />
            </Card>
          )}

        </div>
      )}
    </>
  );
}
