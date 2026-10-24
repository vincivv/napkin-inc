"use client";

import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, Loading, PageHeader, cx } from "@/components/ui";
import { OrdersTable } from "@/components/widgets";
import { ORDER_STATUSES } from "@/lib/reports";

export default function OrdersPage() {
  const { snapshot, session } = useData();
  const [filter, setFilter] = useState<string>("all");
  const [q, setQ] = useState("");
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const o of snapshot.orders) c[o.status] = (c[o.status] ?? 0) + 1;
    return c;
  }, [snapshot.orders]);
  const rows = snapshot.orders.filter((o) => (filter === "all" || o.status === filter) && (!q || `${o.id} ${o.customerName}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <PageHeader title="Orders" subtitle={`${snapshot.orders.length} orders · storefront, phone and agent channels`} />
      {session.mode === "live" && !session.ready ? (
        <Loading />
      ) : (
        <Card
          pad={false}
          title={
            <span className="flex flex-wrap gap-1 normal-case tracking-normal">
              {["all", ...ORDER_STATUSES].map((s) => (
                <button key={s} onClick={() => setFilter(s)} className={cx("rounded px-2 py-0.5 text-[12px] font-medium", filter === s ? "bg-surface-2 text-ink" : "text-muted hover:text-ink")}>
                  {s.replace(/_/g, " ")} {s === "all" ? snapshot.orders.length : (counts[s] ?? 0)}
                </button>
              ))}
            </span>
          }
          actions={<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search order or customer" className="h-7 w-48 rounded-md border border-line bg-surface px-2 text-[12px]" />}
        >
          <OrdersTable orders={rows} />
        </Card>
      )}
    </>
  );
}
