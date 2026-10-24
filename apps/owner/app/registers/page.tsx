"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Badge, Card, Empty, Loading, Money, PageHeader, cx, fmtTime, tableCls, tdCls, thCls } from "@/components/ui";
import { newestFirst, useDocMap, docLabel, useTz } from "@/lib/hooks";

export default function RegistersPage() {
  const { snapshot, session, names, config } = useData();
  const docs = useDocMap();
  const tz = useTz();
  const regs = useMemo(() => {
    const ids = new Set<string>([...(config?.config?.registers.map((r) => r.id) ?? []), ...snapshot.registerBalances.map((b) => b.registerId), ...snapshot.registerMovements.map((m) => m.registerId)]);
    return [...ids];
  }, [config, snapshot.registerBalances, snapshot.registerMovements]);
  const [sel, setSel] = useState<string>();
  const cur = sel ?? regs[0];
  if (session.mode === "live" && !session.ready) return <Loading />;
  const def = config?.config?.registers.find((r) => r.id === cur);
  const bal = snapshot.registerBalances.filter((b) => b.registerId === cur).sort((a, b) => a.dimsKey.localeCompare(b.dimsKey));
  const mov = newestFirst(snapshot.registerMovements.filter((m) => m.registerId === cur), (m) => m.postedAt.microsSinceUnixEpoch, (m) => m.id);
  return (
    <>
      <PageHeader title="Registers" subtitle="Running balances kept in the same transaction as every posting." />
      {regs.length === 0 ? (
        <Card>
          <Empty title="No registers yet" hint="Registers come from the active configuration and fill as documents post." />
        </Card>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap gap-1">
            {regs.map((r) => (
              <button key={r} onClick={() => setSel(r)} className={cx("rounded-md border px-3 py-1 text-[13px]", r === cur ? "border-line-strong bg-surface font-medium" : "border-transparent text-muted hover:text-ink")}>
                {names.register(r)}
              </button>
            ))}
          </div>
          <div className="space-y-4">
            <Card
              title={`Balances · ${names.register(cur!)}`}
              pad={false}
              actions={def && <Badge>{def.kind} · dims {def.dimensions.join(", ") || "none"}{def.allowNegative ? "" : " · never negative"}</Badge>}
            >
              {bal.length === 0 ? (
                <Empty compact title="No balance rows yet" />
              ) : (
                <table className={tableCls}>
                  <thead>
                    <tr>
                      <th className={thCls}>Dimensions</th>
                      <th className={cx(thCls, "text-right")}>Quantity</th>
                      <th className={cx(thCls, "text-right")}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bal.map((b) => (
                      <tr key={b.key}>
                        <td className={tdCls}>
                          {names.dims(b.dimsKey)} <span className="ml-1 font-mono text-[11px] text-faint">{b.dimsKey}</span>
                        </td>
                        <td className={cx(tdCls, "num text-right", b.qty < 0n && "text-neg")}>{b.qty.toString()}</td>
                        <td className={cx(tdCls, "text-right")}>
                          <Money cents={b.amountCents} muted0 />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <Card title={`Movement history (${mov.length})`} pad={false}>
              {mov.length === 0 ? (
                <Empty compact title="No movements yet" />
              ) : (
                <div className="max-h-[560px] overflow-auto">
                  <table className={tableCls}>
                    <thead>
                      <tr>
                        <th className={thCls}>When</th>
                        <th className={thCls}>Document</th>
                        <th className={thCls}>Dimensions</th>
                        <th className={thCls}>Dir</th>
                        <th className={cx(thCls, "text-right")}>Qty</th>
                        <th className={cx(thCls, "text-right")}>Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {mov.map((m) => (
                        <tr key={String(m.id)}>
                          <td className={cx(tdCls, "whitespace-nowrap text-muted")}>{fmtTime(m.postedAt, tz)}</td>
                          <td className={tdCls}>
                            <Link className="text-accent-ink hover:underline" href={`/documents/${m.documentId}`}>
                              {docLabel(docs.get(m.documentId), names)}
                            </Link>
                          </td>
                          <td className={tdCls}>{names.dims(m.dimsKey)}</td>
                          <td className={tdCls}>
                            <Badge tone={m.kind === "in" ? "pos" : "warn"}>{m.kind}</Badge>
                          </td>
                          <td className={cx(tdCls, "num text-right")}>{m.qty.toString()}</td>
                          <td className={cx(tdCls, "text-right")}>
                            <Money cents={m.amountCents} muted0 />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
