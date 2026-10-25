"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useData } from "@/data/context";
import { Badge, Empty, Loading, Money, PageHeader, cx, fmtTime, tableCls, tdCls, thCls } from "@/components/ui";
import { ReportAccordion, useOpenSections, type ReportSection } from "@/components/reports/ReportAccordion";
import { ACCOUNTS, booksCheck, cashFlow, marginByItem, openByRef, pnl, stockRows, tb } from "@/lib/reports";
import { formatCents, pct } from "@/lib/money";
import { useDocMap, docLabel, useTz } from "@/lib/hooks";
import { downloadCsv, journalRows, salesTaxByPeriod, salesTaxRows, trialBalanceRows, type TaxPeriodKind } from "@/lib/books-export";

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

const SECTION_IDS = ["pnl", "tax", "export", "tb", "cash", "receivables", "payables", "stock", "margin"] as const;

export default function ReportsPage() {
  const { snapshot, session, names, config } = useData();
  const docs = useDocMap();
  const tz = useTz();
  const [taxBy, setTaxBy] = useState<TaxPeriodKind>("quarter");
  const { open, toggle, setAll } = useOpenSections(SECTION_IDS);
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
      tax: salesTaxByPeriod(lines, docs, tz, taxBy),
    };
  }, [lines, docs, names, tz, taxBy, snapshot.registerBalances, snapshot.registerMovements, snapshot.documents]);
  if (session.mode === "live" && !session.ready) return <Loading />;
  const unconf = new Set(config?.config?._unconfirmed?.paths ?? []);
  const costUnconfirmed = [...unconf].some((p) => p.endsWith(".cost"));
  const p = r.pnl;
  const totD = r.tb.reduce((a, x) => a + x.debitCents, 0n);
  const totC = r.tb.reduce((a, x) => a + x.creditCents, 0n);
  const stockTotal = r.stock.reduce((a, x) => a + x.amountCents, 0n);
  const taxRate = String(config?.config?.policies?.taxRate ?? "0");
  const slug = (config?.config?.business.name ?? "books").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "books";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

  const taxShowPaid = r.tax.some((t) => t.taxPaidCents !== 0n);
  const taxDue = r.tax.reduce((a, t) => a + t.netTaxDueCents, 0n);
  const recvTotal = r.receivables.reduce((a, x) => a + x.balanceCents, 0n);
  const payTotal = r.payables.reduce((a, x) => a + x.balanceCents, 0n);
  const cashNow = r.cash.at(-1)?.runningCents ?? 0n;
  const downloadTax = () => downloadCsv(`${slug}-sales-tax-by-${taxBy}-${today}.csv`, salesTaxRows(r.tax, taxRate));
  const btn = "rounded-md border border-line bg-surface px-2 py-1 text-[12px] hover:bg-surface-2 disabled:opacity-50";

  const sections: ReportSection[] = [
    {
      id: "pnl",
      title: "Profit & loss",
      description: "Revenue, discounts, refunds, cost of goods and fees down to net income.",
      summary: <>Net income <Money cents={p.netIncomeCents} className="font-medium" /></>,
      children: (
        <table className={tableCls}>
          <tbody>
            <Row label={`Revenue · ${ACCOUNTS.revenue}`} cents={p.revenueCents} />
            <Row indent label={`Discounts · ${ACCOUNTS.discounts}`} cents={-p.discountsCents} />
            <Row indent label={`Refunds · ${ACCOUNTS.refunds}`} cents={-p.refundsCents} />
            <Row bold label="Net revenue" cents={p.netRevenueCents} />
            <Row indent label={`Cost of goods sold · ${ACCOUNTS.cogs}`} cents={-p.cogsCents} note={costUnconfirmed ? "ingredient costs are unconfirmed placeholders" : undefined} />
            <Row bold label="Gross profit" cents={p.grossProfitCents} note={pct(p.grossProfitCents, p.netRevenueCents)} />
            <Row indent label={`Processor fees · ${ACCOUNTS.fees}`} cents={-p.feesCents} />
            {p.operatingExpenses.map((x) => (
              <Row key={x.code} indent label={`${names.account(x.code)} · ${x.code}`} cents={-x.cents} />
            ))}
            <Row bold label="Net income" cents={p.netIncomeCents} />
          </tbody>
        </table>
      ),
    },
    {
      id: "tax",
      title: "Sales tax",
      description: `Tax collected, refunded and due, by ${taxBy}. Use these totals on your state's return.`,
      summary: r.tax.length === 0 ? "No sales yet" : <><Money cents={taxDue} className="font-medium" /> owed</>,
      actions: (
        <>
          <select value={taxBy} onChange={(e) => setTaxBy(e.target.value as TaxPeriodKind)} className="h-7 rounded-md border border-line bg-surface px-2 text-[12px]" aria-label="Group sales tax by">
            <option value="month">By month</option>
            <option value="quarter">By quarter</option>
          </select>
          <button type="button" disabled={r.tax.length === 0} onClick={downloadTax} className={btn}>
            Download CSV
          </button>
        </>
      ),
      children: (
        <>
          {r.tax.length === 0 ? (
            <Empty compact title="No sales yet" hint="Tax shows up here as soon as a paid sale posts." />
          ) : (
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Period</th>
                    <th className={cx(thCls, "text-right")}>Taxable sales</th>
                    <th className={cx(thCls, "text-right")}>Tax collected</th>
                    <th className={cx(thCls, "text-right")}>Tax refunded</th>
                    {taxShowPaid && <th className={cx(thCls, "text-right")}>Already paid</th>}
                    <th className={cx(thCls, "text-right")}>Tax due</th>
                  </tr>
                </thead>
                <tbody>
                  {r.tax.map((t) => (
                    <tr key={t.period}>
                      <td className={cx(tdCls, "font-mono text-[12px]")}>{t.period}</td>
                      <td className={right()}><Money cents={t.taxableSalesCents} muted0 /></td>
                      <td className={right()}><Money cents={t.taxCollectedCents} muted0 /></td>
                      <td className={right()}><Money cents={-t.taxRefundedCents} muted0 /></td>
                      {taxShowPaid && <td className={right()}><Money cents={-t.taxPaidCents} muted0 /></td>}
                      <td className={right("font-semibold")}><Money cents={t.netTaxDueCents} muted0 /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="space-y-1 px-4 py-2.5 text-[11.5px] text-muted">
            <p>
              Rate in your settings: <span className="font-medium text-ink">{pctText(taxRate)}</span>
              {taxRate === "0" || Number(taxRate) === 0 ? " — no tax is being charged. If your state or city taxes what you sell, set the rate before you take more orders." : ". Periods use your shop's time zone."}
            </p>
            <p>Napkin does not file or pay sales tax for you. Use these totals on your state&apos;s return, and check with your state or an accountant which items are taxable and how often you file.</p>
          </div>
        </>
      ),
    },
    {
      id: "export",
      title: "For your accountant",
      description: "CSV files for Excel, Google Sheets, QuickBooks or Xero.",
      summary: "3 downloads",
      children: (
        <div className="p-4">
          <p className="text-[13px] text-muted">Spreadsheet files (CSV) that open in Excel, Google Sheets, QuickBooks or Xero imports. Amounts are dollars, dates are in your shop&apos;s time zone.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <ExportButton disabled={lines.length === 0} onClick={() => downloadCsv(`${slug}-journal-${today}.csv`, journalRows(lines, docs, names, tz))} title="General journal" sub={`${lines.length} lines, every posted entry`} />
            <ExportButton disabled={r.tb.length === 0} onClick={() => downloadCsv(`${slug}-trial-balance-${today}.csv`, trialBalanceRows(r.tb, names))} title="Trial balance" sub={`${r.tb.length} accounts, as of today`} />
            <ExportButton disabled={r.tax.length === 0} onClick={downloadTax} title="Sales tax" sub={`by ${taxBy}`} />
          </div>
        </div>
      ),
    },
    {
      id: "tb",
      title: "Trial balance",
      description: "Debits, credits and balance for every account in the books.",
      summary: (
        <span className="inline-flex items-center gap-2">
          {r.tb.length} accounts <Badge tone={r.books.balanced ? "pos" : "neg"}>{r.books.balanced ? "debits = credits" : "OUT OF BALANCE"}</Badge>
        </span>
      ),
      children:
        r.tb.length === 0 ? (
          <Empty compact title="No journal lines yet" />
        ) : (
          <div className="overflow-x-auto">
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
          </div>
        ),
    },
    {
      id: "cash",
      title: "Cash flow",
      description: "Money coming in from Stripe and going out of the bank, newest first.",
      summary: r.cash.length === 0 ? "No movements yet" : <><Money cents={cashNow} className="font-medium" /> balance</>,
      children:
        r.cash.length === 0 ? (
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
        ),
    },
    {
      id: "receivables",
      title: "Receivables",
      description: "Money customers still owe, by order.",
      summary: r.receivables.length === 0 ? "Nothing owed" : <><Money cents={recvTotal} className="font-medium" /> owed to you</>,
      children: <OpenTable items={r.receivables} empty="Nothing owed. Sales post when payment arrives." />,
    },
    {
      id: "payables",
      title: "Payables",
      description: "Money you owe suppliers.",
      summary: r.payables.length === 0 ? "Nothing owed" : <><Money cents={payTotal} className="font-medium" /> you owe</>,
      children: <OpenTable items={r.payables} empty="Nothing owed to suppliers." />,
    },
    {
      id: "stock",
      title: "Stock on hand",
      description: "Quantity and value at cost of every item in stock.",
      summary: r.stock.length === 0 ? "No stock" : <><Money cents={stockTotal} className="font-medium" /> at cost</>,
      children:
        r.stock.length === 0 ? (
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
        ),
    },
    {
      id: "margin",
      title: "Margin by item",
      description: "Net sales, cost and margin for each product sold.",
      summary: r.margin.length === 0 ? "No sales yet" : `${r.margin.length} item${r.margin.length === 1 ? "" : "s"}`,
      children: (
        <>
          {r.margin.length === 0 ? (
            <Empty compact title="No sales yet" />
          ) : (
            <div className="overflow-x-auto">
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
            </div>
          )}
          {costUnconfirmed && <div className="px-4 py-2 text-[11.5px] text-warn">Costs are placeholders the owner has not confirmed.</div>}
        </>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Computed live from posted journal lines and register balances. Click a report to open it."
        actions={
          <div className="flex gap-1 text-[12px]">
            <button type="button" onClick={() => setAll(true)} className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-ink">
              Expand all
            </button>
            <button type="button" onClick={() => setAll(false)} disabled={open.size === 0} className="rounded px-2 py-1 text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-50">
              Collapse all
            </button>
          </div>
        }
      />
      <ReportAccordion sections={sections} open={open} onToggle={toggle} />
    </>
  );
}

function OpenTable({ items, empty }: { items: { key: string; label: string; balanceCents: bigint; documentIds: bigint[] }[]; empty: string }) {
  if (items.length === 0) return <Empty compact title={empty} />;
  return (
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
  );
}

function pctText(rate: string): string {
  const n = Number(rate);
  return Number.isFinite(n) ? `${(n * 100).toFixed(3).replace(/\.?0+$/, "")}%` : rate;
}

function ExportButton({ title, sub, onClick, disabled }: { title: string; sub: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="flex min-w-[180px] flex-col items-start rounded-lg border border-line px-3 py-2 text-left hover:bg-surface-2 disabled:opacity-50">
      <span className="text-[13px] font-medium">↓ {title}</span>
      <span className="text-[11.5px] text-faint">{sub}</span>
    </button>
  );
}
