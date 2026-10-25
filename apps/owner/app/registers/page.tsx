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
  const bal = snapshot.registerBalances.filter((b) => b.registerId === cur).sort((a, b) => a.dimsKey.localeCompare(b.dimsKey));
  const mov = newestFirst(snapshot.registerMovements.filter((m) => m.registerId === cur), (m) => m.postedAt.microsSinceUnixEpoch, (m) => m.id);
  return (
    <>
      <PageHeader title="Registers" subtitle="Running totals, updated with every sale, delivery and refund." />
      {regs.length === 0 ? (
        <Card>
          <Empty title="No registers yet" hint="Registers come from the active configuration and fill as documents post." />
        </Card>
      ) : (
        <>
          <div className="mb-6 flex gap-6 border-b border-line">
            {regs.map((r) => (
              <button key={r} onClick={() => setSel(r)} className={cx("-mb-px border-b-2 pb-3 text-[14px] transition-colors", r === cur ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink")}>
                {names.register(r)}
              </button>
            ))}
          </div>
          <div className="space-y-6">
            <Card
              title={`Balances · ${names.register(cur!)}`}
              pad={false}
            >
              {bal.length === 0 ? (
                <Empty compact title="No balance rows yet" />
              ) : (
                <table className={tableCls}>
                  <thead>
                    <tr>
                      <th className={thCls}>Item</th>
                      <th className={cx(thCls, "text-right")}>Quantity</th>
                      <th className={cx(thCls, "text-right")}>Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bal.map((b) => (
                      <tr key={b.key}>
                        <td className={tdCls}>
                          {names.dims(b.dimsKey)}
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
                        <th className={thCls}>Item</th>
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
