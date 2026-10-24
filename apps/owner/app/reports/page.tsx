"use client";

import Link from "next/link";
import { useMemo, type ReactNode } from "react";
import { useData } from "@/data/context";
import { Badge, Card, Empty, Loading, Money, PageHeader, cx, fmtTime, tableCls, tdCls, thCls } from "@/components/ui";
import { ACCOUNTS, booksCheck, cashFlow, marginByItem, openByRef, pnl, stockRows, tb } from "@/lib/reports";
import { formatCents, pct } from "@/lib/money";
import { useDocMap, docLabel, useTz } from "@/lib/hooks";

const right = (c = "") => cx(tdCls, "text-right", c);

function Row({ label, cents, bold, indent, note }: { label: ReactNode; cents: bigint; bold?: boolean; indent?: boolean; note?: ReactNode }) {
  return (
    <tr className={bold ? "font-semibold" : ""}>
      <td className={cx(tdCls, indent && "pl-7")}>
        {label}
        {note && <span className="ml-2 text-[11.5px] font-normal text-faint">{note}</span>}
      </td>
      <td className={right()}>
        <Money cents={cents} />
      </td>
    </tr>
  );
}

export default function ReportsPage() {
  const { snapshot, session, names, config } = useData();
  const docs = useDocMap();
  const tz = useTz();
  const lines = snapshot.journalLines;
  const r = useMemo(() => {
    const t = tb(lines);
    const label = (d: Parameters<typeof docLabel>[0]) => docLabel(d, names);
    return {
      tb: t,
      books: booksCheck(lines),
      pnl: pnl(lines),
      receivables: openByRef(lines, docs, ACCOUNTS.receivables, 1n, label),
      payables: openByRef(lines, docs, ACCOUNTS.payables, -1n, label),
      cash: cashFlow(lines),
      stock: stockRows(snapshot.registerBalances),
      margin: marginByItem(snapshot.registerMovements, snapshot.documents),
    };
  }, [lines, docs, names, snapshot.registerBalances, snapshot.registerMovements, snapshot.documents]);
  if (session.mode === "live" && !session.ready) return <Loading />;
  const unconf = new Set(config?.config?._unconfirmed?.paths ?? []);
  const costUnconfirmed = [...unconf].some((p) => p.endsWith(".cost"));
  const p = r.pnl;
  const totD = r.tb.reduce((a, x) => a + x.debitCents, 0n);
  const totC = r.tb.reduce((a, x) => a + x.creditCents, 0n);
  const stockTotal = r.stock.reduce((a, x) => a + x.amountCents, 0n);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Computed live from posted journal lines and register balances. All money is integer cents."
        actions={
          <nav className="flex flex-wrap gap-1 text-[12px]">
            {[["tb", "Trial balance"], ["pnl", "P&L"], ["stock", "Stock"], ["receivables", "Receivables"], ["payables", "Payables"], ["cash", "Cash flow"], ["margin", "Margin"]].map(([id, l]) => (
              <a key={id} href={`#${id}`} className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-ink">
                {l}
              </a>
            ))}
          </nav>
        }
      />
      <div className="space-y-4">
        <Card id="tb" title="Trial balance" pad={false} actions={<Badge tone={r.books.balanced ? "pos" : "neg"}>{r.books.balanced ? "debits = credits" : "OUT OF BALANCE"}</Badge>}>
          {r.tb.length === 0 ? (
            <Empty compact title="No journal lines yet" />
          ) : (
            <table className={tableCls}>
              <thead>
                <tr>
                  <th className={thCls}>Account</th>
                  <th className={cx(thCls, "text-right")}>Debits</th>
                  <th className={cx(thCls, "text-right")}>Credits</th>
                  <th className={cx(thCls, "text-right")}>Balance (Dr − Cr)</th>
                </tr>
              </thead>
              <tbody>
                {r.tb.map((x) => (
                  <tr key={x.account}>
                    <td className={tdCls}>
                      <span className="font-mono text-[11.5px] text-muted">{x.account}</span> {names.account(x.account)}
                    </td>
                    <td className={right()}><Money cents={x.debitCents} muted0 /></td>
                    <td className={right()}><Money cents={x.creditCents} muted0 /></td>
                    <td className={right()}><Money cents={x.balanceCents} muted0 /></td>
                  </tr>
                ))}
                <tr className="font-semibold">
                  <td className={tdCls}>Total</td>
                  <td className={right()}><Money cents={totD} /></td>
                  <td className={right()}><Money cents={totC} /></td>
                  <td className={right()}><Money cents={totD - totC} /></td>
                </tr>
              </tbody>
            </table>
          )}
        </Card>

        <Card id="pnl" title="Profit & loss" pad={false}>
          <table className={tableCls}>
            <tbody>
              <Row label={`Revenue · ${ACCOUNTS.revenue}`} cents={p.revenueCents} />
              <Row indent label={`Discounts · ${ACCOUNTS.discounts}`} cents={-p.discountsCents} />
              <Row indent label={`Refunds · ${ACCOUNTS.refunds}`} cents={-p.refundsCents} />
              <Row bold label="Net revenue" cents={p.netRevenueCents} />
              <Row indent label={`Cost of goods sold · ${ACCOUNTS.cogs}`} cents={-p.cogsCents} note={costUnconfirmed ? "ingredient costs are unconfirmed placeholders" : undefined} />
              <Row bold label="Gross profit" cents={p.grossProfitCents} note={pct(p.grossProfitCents, p.netRevenueCents)} />
              <Row indent label={`Processor fees · ${ACCOUNTS.fees}`} cents={-p.feesCents} />
              <Row bold label="Net income" cents={p.netIncomeCents} />
            </tbody>
          </table>
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card id="stock" title="Stock on hand" pad={false}>
            {r.stock.length === 0 ? (
              <Empty compact title="No stock rows" />
            ) : (
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Item</th>
                    <th className={cx(thCls, "text-right")}>Qty</th>
                    <th className={cx(thCls, "text-right")}>At cost</th>
                  </tr>
                </thead>
                <tbody>
                  {r.stock.map((s) => (
                    <tr key={s.key}>
                      <td className={tdCls}>{names.entry(s.item)}</td>
                      <td className={right("num")}>{s.qty.toString()}</td>
                      <td className={right()}><Money cents={s.amountCents} muted0 /></td>
                    </tr>
                  ))}
                  <tr className="font-semibold">
                    <td className={tdCls} colSpan={2}>Inventory value</td>
                    <td className={right()}><Money cents={stockTotal} /></td>
                  </tr>
                </tbody>
              </table>
            )}
          </Card>

          <Card id="margin" title="Margin by item" pad={false}>
            {r.margin.length === 0 ? (
              <Empty compact title="No sales yet" />
            ) : (
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Item</th>
                    <th className={cx(thCls, "text-right")}>Qty</th>
                    <th className={cx(thCls, "text-right")}>Net sales</th>
                    <th className={cx(thCls, "text-right")}>Cost</th>
                    <th className={cx(thCls, "text-right")}>Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {r.margin.map((m) => (
                    <tr key={m.productId}>
                      <td className={tdCls}>{names.entry(m.productId)}</td>
                      <td className={right("num")}>{m.qty.toString()}</td>
                      <td className={right()}><Money cents={m.netSalesCents} /></td>
                      <td className={right()}>{m.costCents === null ? "—" : <Money cents={m.costCents} />}</td>
                      <td className={right()}>
                        {m.marginCents === null ? "—" : (
                          <>
                            <Money cents={m.marginCents} /> <span className="text-faint">{pct(m.marginCents, m.netSalesCents)}</span>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {costUnconfirmed && <div className="border-t border-line px-4 py-2 text-[11.5px] text-warn">Costs are placeholders the owner has not confirmed.</div>}
          </Card>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <OpenCard id="receivables" title="Receivables · 1200, by order" items={r.receivables} empty="Nothing owed. Sales post when payment arrives." />
          <OpenCard id="payables" title="Payables · 2000" items={r.payables} empty="Nothing owed to suppliers." />
        </div>

        <Card id="cash" title="Cash flow · Stripe clearing 1010 and bank 1000" pad={false}>
          {r.cash.length === 0 ? (
            <Empty compact title="No cash movements yet" />
          ) : (
            <div className="max-h-[480px] overflow-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>When</th>
                    <th className={thCls}>Account</th>
                    <th className={thCls}>Document</th>
                    <th className={cx(thCls, "text-right")}>In</th>
                    <th className={cx(thCls, "text-right")}>Out</th>
                    <th className={cx(thCls, "text-right")}>Running</th>
                  </tr>
                </thead>
                <tbody>
                  {r.cash.slice().reverse().map((c) => (
                    <tr key={String(c.id)}>
                      <td className={cx(tdCls, "whitespace-nowrap text-muted")}>{fmtTime({ microsSinceUnixEpoch: c.postedAtMicros }, tz)}</td>
                      <td className={tdCls}><span className="font-mono text-[11.5px] text-muted">{c.accountCode}</span> {names.account(c.accountCode)}</td>
                      <td className={tdCls}><Link className="text-accent-ink hover:underline" href={`/documents/${c.documentId}`}>{docLabel(docs.get(c.documentId), names)}</Link></td>
                      <td className={right()}>{c.inCents !== 0n && <Money cents={c.inCents} />}</td>
                      <td className={right()}>{c.outCents !== 0n && <Money cents={c.outCents} />}</td>
                      <td className={right()}><Money cents={c.runningCents} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function OpenCard({ id, title, items, empty }: { id: string; title: string; items: { key: string; label: string; balanceCents: bigint; documentIds: bigint[] }[]; empty: string }) {
  return (
    <Card id={id} title={title} pad={false}>
      {items.length === 0 ? (
        <Empty compact title={empty} />
      ) : (
        <table className={tableCls}>
          <tbody>
            {items.map((i) => (
              <tr key={i.key}>
                <td className={tdCls}>
                  <span className="font-mono text-[12px]">{i.key}</span>
                </td>
                <td className={right()}>
                  <Money cents={i.balanceCents} />
                </td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className={tdCls}>Total</td>
              <td className={right()}>{formatCents(items.reduce((a, x) => a + x.balanceCents, 0n))}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Card>
  );
}
