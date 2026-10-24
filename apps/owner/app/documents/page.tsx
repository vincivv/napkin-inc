"use client";

import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useMemo } from "react";
import { useData } from "@/data/context";
import { Card, Loading, Money, PageHeader, RelTime, StatusBadge, Empty, cx, rowLinkCls, tableCls, tdCls, thCls } from "@/components/ui";
import { newestFirst } from "@/lib/hooks";

function Inner() {
  const { snapshot, session, names, config } = useData();
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get("type") ?? "all";
  const status = sp.get("status") ?? "all";
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp.toString());
    if (v === "all") n.delete(k);
    else n.set(k, v);
    router.replace(`/documents${n.size ? `?${n}` : ""}`);
  };
  const types = useMemo(() => [...new Set([...(config?.config?.documents.map((d) => d.id) ?? []), ...snapshot.documents.map((d) => d.docType)])], [config, snapshot.documents]);
  const rows = newestFirst(
    snapshot.documents.filter((d) => (type === "all" || d.docType === type) && (status === "all" || d.status === status)),
    (d) => d.createdAt.microsSinceUnixEpoch,
    (d) => d.id,
  );
  const sel = "h-7 rounded-md border border-line bg-surface px-2 text-[12px]";
  return (
    <>
      <PageHeader title="Documents" subtitle="Every business event is a typed document. Posted documents are read-only; mistakes are fixed by reversal." />
      {session.mode === "live" && !session.ready ? (
        <Loading />
      ) : (
        <Card
          pad={false}
          title={`${rows.length} of ${snapshot.documents.length}`}
          actions={
            <>
              <select className={sel} value={type} onChange={(e) => set("type", e.target.value)} aria-label="Type">
                <option value="all">All types</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {names.docType(t)}
                  </option>
                ))}
              </select>
              <select className={sel} value={status} onChange={(e) => set("status", e.target.value)} aria-label="Status">
                {["all", "draft", "posted", "reversed"].map((s) => (
                  <option key={s} value={s}>
                    {s === "all" ? "All statuses" : s}
                  </option>
                ))}
              </select>
            </>
          }
        >
          {rows.length === 0 ? (
            <Empty title="No documents match" hint="Documents appear here as soon as the platform creates them." />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Document</th>
                    <th className={thCls}>Status</th>
                    <th className={thCls}>Ref</th>
                    <th className={thCls}>Created by</th>
                    <th className={thCls}>Approved by</th>
                    <th className={cx(thCls, "text-right")}>Amount</th>
                    <th className={thCls}>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={String(d.id)} className={rowLinkCls} onClick={() => router.push(`/documents/${d.id}`)}>
                      <td className={tdCls}>
                        <Link href={`/documents/${d.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {names.docType(d.docType)} #{d.number}
                        </Link>
                        {d.reversalOf !== 0n && <span className="ml-1.5 text-[11.5px] text-faint">reversal</span>}
                      </td>
                      <td className={tdCls}>
                        <StatusBadge status={d.status} />
                      </td>
                      <td className={cx(tdCls, "font-mono text-[11.5px] text-muted")}>{d.externalRef || "—"}</td>
                      <td className={cx(tdCls, "text-muted")}>{d.createdByRole}</td>
                      <td className={cx(tdCls, "text-muted")}>{d.approvedByRole || "—"}</td>
                      <td className={cx(tdCls, "text-right")}>
                        <Money cents={d.totalCents} muted0 />
                      </td>
                      <td className={tdCls}>
                        <RelTime ts={d.createdAt} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  );
}

export default function DocumentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Inner />
    </Suspense>
  );
}
