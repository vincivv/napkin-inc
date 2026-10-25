"use client";

import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, Loading, PageHeader, cx } from "@/components/ui";
import { OrdersTable } from "@/components/widgets";
import { ORDER_STATUSES } from "@/lib/reports";

const LABEL: Record<string, string> = {
  all: "All",
  pending_payment: "Awaiting payment",
  paid: "To prepare",
  ready: "Ready for pickup",
  picked_up: "Picked up",
  refunded: "Refunded",
  partially_refunded: "Partly refunded",
  cancelled: "Cancelled",
};
/** always shown; the rest only once an order has that status */
const MAIN = new Set(["all", "pending_payment", "paid", "ready", "picked_up"]);

export default function OrdersPage() {
  const { snapshot, session } = useData();
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: snapshot.orders.length };
    for (const o of snapshot.orders) c[o.status] = (c[o.status] ?? 0) + 1;
    return c;
  }, [snapshot.orders]);
  const tabs = ["all", ...ORDER_STATUSES].filter((s) => MAIN.has(s) || (counts[s] ?? 0) > 0 || filter === s);
  const rows = snapshot.orders.filter((o) => (filter === "all" || o.status === filter) && (!q || `${o.id} ${o.customerName}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title="Orders" subtitle="Every order from the storefront, the phone line and the shop chat." />
      {session.mode === "live" && !session.ready ? (
        <Loading />
      ) : (
        <>
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line">
            <nav className="-mb-px flex gap-6 overflow-x-auto" role="tablist">
              {tabs.map((s) => {
                const on = filter === s;
                const n = counts[s] ?? 0;
                return (
                  <button
                    key={s}
                    role="tab"
                    aria-selected={on}
                    onClick={() => setFilter(s)}
                    className={cx("flex items-center gap-2 whitespace-nowrap border-b-2 pb-3 text-[14px] transition-colors", on ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink")}
                  >
                    {LABEL[s] ?? s}
                    <span className={cx("num rounded-full px-1.5 text-[12px] leading-5", on ? "bg-ink text-canvas" : "bg-surface-2 text-muted")}>{n}</span>
                  </button>
                );
              })}
            </nav>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search order or customer"
              className="mb-2.5 h-9 w-64 rounded-md border border-line bg-surface px-3 text-[14px] outline-none placeholder:text-faint focus:border-line-strong"
            />
          </div>
          <Card pad={false}>
            <OrdersTable orders={rows} />
          </Card>
        </>
      )}
    </>
  );
}
