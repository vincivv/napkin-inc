"use client";

import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Card, Loading, Money, PageHeader, RelTime, StatusBadge, Empty, cx, rowLinkCls, tableCls, tdCls, thCls } from "@/components/ui";
import { formatCents } from "@/lib/money";

type SortKey = "date" | "number" | "type" | "status" | "amount";
type Dir = "asc" | "desc";
const SORT_KEYS: SortKey[] = ["date", "number", "type", "status", "amount"];
/** First click on a column: numbers and dates start biggest/newest first, text starts A→Z. */
const firstDir: Record<SortKey, Dir> = { date: "desc", number: "desc", amount: "desc", type: "asc", status: "asc" };
const cmpBig = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

function SortTh({ k, label, sort, dir, onSort, className }: { k: SortKey; label: string; sort: SortKey; dir: Dir; onSort: (k: SortKey) => void; className?: string }) {
  const active = sort === k;
  return (
    <th className={cx(thCls, className)} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        onClick={() => onSort(k)}
        className={cx("group inline-flex items-center gap-1 hover:text-ink", active && "text-ink")}
      >
        {label}
        <span aria-hidden className={cx("w-2.5 text-[10px]", active ? "text-ink" : "text-faint opacity-0 group-hover:opacity-100")}>
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}

function Inner() {
  const { snapshot, session, names, config } = useData();
  const router = useRouter();
  const sp = useSearchParams();
  const type = sp.get("type") ?? "all";
  const status = sp.get("status") ?? "all";
  const sortParam = sp.get("sort") as SortKey | null;
  const sort: SortKey = sortParam && SORT_KEYS.includes(sortParam) ? sortParam : "date";
  const dir: Dir = sp.get("dir") === "asc" || sp.get("dir") === "desc" ? (sp.get("dir") as Dir) : firstDir[sort];
  const [q, setQ] = useState("");
  const replace = (patch: Record<string, string | null>) => {
    const n = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) n.delete(k);
      else n.set(k, v);
    }
    router.replace(`/documents${n.size ? `?${n}` : ""}`, { scroll: false });
  };
  const set = (k: string, v: string) => replace({ [k]: v === "all" ? null : v });
  const onSort = (k: SortKey) => {
    const next: Dir = sort === k ? (dir === "asc" ? "desc" : "asc") : firstDir[k];
    // Default (newest first) keeps the URL clean.
    replace(k === "date" && next === "desc" ? { sort: null, dir: null } : { sort: k, dir: next === firstDir[k] ? null : next });
  };
  const types = useMemo(() => [...new Set([...(config?.config?.documents.map((d) => d.id) ?? []), ...snapshot.documents.map((d) => d.docType)])], [config, snapshot.documents]);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = snapshot.documents.filter((d) => {
      if (type !== "all" && d.docType !== type) return false;
      if (status !== "all" && d.status !== status) return false;
      if (!needle) return true;
      const hay = [names.docType(d.docType), d.docType, `#${d.number}`, String(d.id), d.status, d.externalRef, d.createdByRole, d.approvedByRole, formatCents(d.totalCents)].join(" ").toLowerCase();
      return hay.includes(needle);
    });
    const cmp = (a: (typeof filtered)[number], b: (typeof filtered)[number]): number => {
      switch (sort) {
        case "date":
          return cmpBig(a.createdAt.microsSinceUnixEpoch, b.createdAt.microsSinceUnixEpoch);
        case "number":
          return cmpBig(a.number, b.number);
        case "amount":
          return cmpBig(a.totalCents, b.totalCents);
        case "type":
          return names.docType(a.docType).localeCompare(names.docType(b.docType)) || cmpBig(a.number, b.number);
        case "status":
          return a.status.localeCompare(b.status);
      }
    };
    const sign = dir === "asc" ? 1 : -1;
    // Ties fall back to id so the order is stable.
    return filtered.slice().sort((a, b) => sign * (cmp(a, b) || cmpBig(a.id, b.id)));
  }, [snapshot.documents, type, status, q, sort, dir, names]);
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
              <input
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search…"
                aria-label="Search documents"
                className="h-7 w-40 rounded-md border border-line bg-surface px-2 text-[12px] placeholder:text-faint"
              />
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
            <Empty title="No documents match" hint={snapshot.documents.length ? "Try another type, status or search." : "Documents appear here as soon as the platform creates them."} />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <SortTh k="type" label="Type" sort={sort} dir={dir} onSort={onSort} />
                    <SortTh k="number" label="No." sort={sort} dir={dir} onSort={onSort} />
                    <SortTh k="status" label="Status" sort={sort} dir={dir} onSort={onSort} />
                    <th className={thCls}>Ref</th>
                    <th className={thCls}>Created by</th>
                    <th className={thCls}>Approved by</th>
                    <SortTh k="amount" label="Amount" sort={sort} dir={dir} onSort={onSort} className="text-right" />
                    <SortTh k="date" label="Created" sort={sort} dir={dir} onSort={onSort} />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={String(d.id)} className={rowLinkCls} onClick={() => router.push(`/documents/${d.id}`)}>
                      <td className={tdCls}>
                        <Link href={`/documents/${d.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
                          {names.docType(d.docType)}
                        </Link>
                        {d.reversalOf !== 0n && <span className="ml-1.5 text-[11.5px] text-faint">reversal</span>}
                      </td>
                      <td className={cx(tdCls, "num text-muted")}>#{d.number.toString()}</td>
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
