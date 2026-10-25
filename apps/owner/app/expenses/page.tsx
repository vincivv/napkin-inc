"use client";

// Expenses: the owner records rent, supplies, wages, utilities... optionally from a receipt photo the brain reads.
// The brain only PRE-FILLS the form; the owner checks it and saves, and the platform posts the expense document
// (createDocument as the owner; the expense type posts on create). Nothing is booked from a guess.

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useData } from "@/data/context";
import { Badge, Button, Card, Empty, ErrorNote, errText, Loading, Money, OwnerButton, PageHeader, cx, tableCls, tdCls, thCls } from "@/components/ui";
import { brain, type ReceiptRead } from "@/lib/brain";
import { buildExpense, EXPENSE_DOC, expenseRows, expenseSetup, normalizeAmount, totalsByCategory, type ExpenseDraft, type ExpenseRow, type ExpenseSetup } from "@/lib/expenses";
import { formatCents, parseDollars } from "@/lib/money";
import { readConfig } from "@/lib/config";

const inputCls = "h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50";
const labelCls = "mb-1 flex items-center gap-1.5 text-[11.5px] font-medium text-faint";

const emptyDraft = (): ExpenseDraft => ({ vendor: "", date: "", paidFrom: "", receiptRef: "", note: "", lines: [{ account: "", amount: "", description: "" }] });

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Marks a value the owner has not touched since it was read off the receipt. */
function FromReceipt({ show }: { show: boolean }) {
  return show ? <Badge tone="info" title="Read from the receipt: check it">from receipt</Badge> : null;
}

function ExpenseForm({ setup, onDone }: { setup: ExpenseSetup; onDone: (msg: string) => void }) {
  const { snapshot, actions, isOwner } = useData();
  const businessId = snapshot.businessId;
  const [d, setD] = useState<ExpenseDraft>(emptyDraft);
  const [read, setRead] = useState<ReceiptRead | null>(null);
  const [readError, setReadError] = useState<string | undefined>();
  const [fromReceipt, setFromReceipt] = useState<Set<string>>(new Set());
  const [photo, setPhoto] = useState<string | undefined>();
  const [busy, setBusy] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (photo && URL.revokeObjectURL(photo)), [photo]);

  const touch = (key: string) => setFromReceipt((s) => (s.has(key) ? new Set([...s].filter((k) => k !== key)) : s));
  const set = <K extends keyof ExpenseDraft>(k: K, v: ExpenseDraft[K]) => {
    touch(k);
    setD((x) => ({ ...x, [k]: v }));
  };
  const setLine = (i: number, k: keyof ExpenseDraft["lines"][number], v: string) => {
    touch(`line${i}.${k}`);
    setD((x) => ({ ...x, lines: x.lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) }));
  };

  async function onFile(f: File | undefined) {
    if (!f) return;
    setPhoto(URL.createObjectURL(f));
    setBusy("Reading the receipt…");
    setError(undefined);
    setReadError(undefined);
    setRead(null);
    try {
      const r = await brain.readReceipt(businessId, f);
      setRead(r.read);
      setReadError(r.readError);
      // Only values the brain actually read are filled; everything else stays as the owner left it.
      const v = r.read;
      const account = v && setup.categories.some((c) => c.code === v.account) ? v.account : "";
      const filled = new Set<string>();
      if (v?.vendor) filled.add("vendor");
      if (v?.date) filled.add("date");
      if (v?.total) filled.add("line0.amount");
      if (account) filled.add("line0.account");
      setD((x) => {
        const first = { ...x.lines[0]! };
        if (v?.total) first.amount = v.total;
        if (account) first.account = account;
        return {
          ...x,
          receiptRef: r.receiptRef,
          vendor: v?.vendor || x.vendor,
          date: v?.date || x.date,
          lines: [first, ...x.lines.slice(1)],
        };
      });
      setFromReceipt(filled);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(undefined);
    }
  }

  const built = useMemo(() => buildExpense(d, setup), [d, setup]);
  const runningTotal = d.lines.reduce((a, l) => {
    const n = normalizeAmount(l.amount);
    return n ? a + parseDollars(n) : a;
  }, 0n);
  const mismatch = read?.total && normalizeAmount(read.total) && parseDollars(normalizeAmount(read.total)!) !== runningTotal;

  async function save() {
    if ("error" in built) return setError(built.error);
    setBusy("Saving…");
    setError(undefined);
    try {
      await actions.createDocument({ docType: EXPENSE_DOC, fields: built.fields, lines: built.lines, note: d.note.trim() });
      onDone(`Saved ${formatCents(built.totalCents)}${d.vendor.trim() ? ` from ${d.vendor.trim()}` : ""}. It is posted to the books.`);
    } catch (e) {
      setError(`The books refused it: ${errText(e)}`);
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <Card title="New expense" actions={busy && <Loading label={busy} />}>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-3">
          <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => void onFile(e.target.files?.[0])} />
          <Button variant={photo ? "secondary" : "primary"} onClick={() => fileRef.current?.click()} disabled={!!busy || !isOwner}>
            {photo ? "Use a different receipt" : "Snap or upload a receipt"}
          </Button>
          <p className="text-[12px] text-muted">Optional. I read the vendor, date and total and fill them in for you to check. Anything I can&apos;t read stays empty.</p>
          {photo && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo} alt="Receipt" className="max-h-[360px] w-full rounded-md border border-line object-contain" />
          )}
          {readError && <div className="rounded-md border border-warn/30 bg-warn-soft px-3 py-2 text-[12.5px] text-warn">{readError}</div>}
          {read && (
            <div className="space-y-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12.5px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">What I read</span>
                <Badge tone={read.confidence >= 0.8 ? "pos" : read.confidence >= 0.5 ? "warn" : "neg"}>{Math.round(read.confidence * 100)}% sure</Badge>
                {read.itemsMatchTotal === false && <Badge tone="warn">items don&apos;t add up to the total</Badge>}
              </div>
              {read.items.length > 0 && (
                <ul className="space-y-0.5 text-muted">
                  {read.items.map((it, i) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{it.description}</span>
                      <span className="font-mono">{it.amount || "?"}</span>
                    </li>
                  ))}
                </ul>
              )}
              {read.tax && <div className="text-muted">Tax on receipt: {read.tax}</div>}
              {read.currency && read.currency !== "USD" && <div className="text-warn">Currency on receipt: {read.currency}. The books are in dollars; enter the amount you actually paid.</div>}
              {read.notes && <div className="text-muted">Note: {read.notes}</div>}
              {read.dropped.length > 0 && <div className="text-warn">Left empty because I wasn&apos;t sure: {read.dropped.join("; ")}</div>}
            </div>
          )}
        </div>

        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelCls}>Vendor <FromReceipt show={fromReceipt.has("vendor")} /></span>
              <input className={inputCls} value={d.vendor} onChange={(e) => set("vendor", e.target.value)} placeholder="Who you paid" />
            </label>
            <label className="block">
              <span className={labelCls}>
                Date <FromReceipt show={fromReceipt.has("date")} />
                {!d.date && (
                  <button type="button" className="ml-auto text-accent hover:underline" onClick={() => set("date", todayLocal())}>
                    today
                  </button>
                )}
              </span>
              <input type="date" className={inputCls} value={d.date} onChange={(e) => set("date", e.target.value)} />
            </label>
          </div>

          <div>
            <div className={labelCls}>Paid</div>
            <div className="flex flex-wrap gap-3 text-[13px]">
              {setup.paidFrom.map((p) => (
                <label key={p.code} className="flex items-center gap-1.5">
                  <input type="radio" name="paidFrom" checked={d.paidFrom === p.code} onChange={() => set("paidFrom", p.code)} />
                  {p.code === "2000" ? "Still owed to the supplier" : p.code === "1000" ? "Paid now" : p.name} <span className="text-faint">({p.name})</span>
                </label>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <div className={labelCls}>What it was for</div>
            {d.lines.map((l, i) => (
              <div key={i} className="grid grid-cols-[minmax(0,1fr)_110px] gap-2 sm:grid-cols-[150px_110px_minmax(0,1fr)_auto]">
                <div>
                  <select className={inputCls} value={l.account} onChange={(e) => setLine(i, "account", e.target.value)} aria-label="Category">
                    <option value="">Category…</option>
                    {setup.categories.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  {fromReceipt.has(`line${i}.account`) && <div className="mt-0.5 text-[11px] text-info">suggested from the receipt</div>}
                </div>
                <div>
                  <input className={cx(inputCls, "text-right font-mono")} inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, "amount", e.target.value)} placeholder="0.00" aria-label="Amount" />
                  {fromReceipt.has(`line${i}.amount`) && <div className="mt-0.5 text-right text-[11px] text-info">from receipt</div>}
                </div>
                <input className={cx(inputCls, "col-span-2 sm:col-span-1")} value={l.description} onChange={(e) => setLine(i, "description", e.target.value)} placeholder="Description (optional)" aria-label="Description" />
                {d.lines.length > 1 ? (
                  <Button variant="ghost" size="sm" onClick={() => setD((x) => ({ ...x, lines: x.lines.filter((_, j) => j !== i) }))} aria-label="Remove line">
                    ✕
                  </Button>
                ) : (
                  <span className="hidden sm:block" />
                )}
              </div>
            ))}
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={() => setD((x) => ({ ...x, lines: [...x.lines, { account: "", amount: "", description: "" }] }))}>
                + Split across categories
              </Button>
              <span className="text-[13px]">
                Total <span className="font-mono font-semibold">{formatCents(runningTotal)}</span>
              </span>
            </div>
            {mismatch && <div className="text-[12px] text-warn">The receipt total was {read!.total}; your lines add up to {formatCents(runningTotal)}.</div>}
          </div>

          <label className="block">
            <span className={labelCls}>Note (optional)</span>
            <input className={inputCls} value={d.note} onChange={(e) => set("note", e.target.value)} placeholder="Anything to remember about it" />
          </label>

          <ErrorNote error={error} />
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <OwnerButton variant="primary" onClick={() => void save()} disabled={!!busy} reason={"error" in built ? built.error : undefined}>
              Save expense{"error" in built ? "" : ` · ${formatCents(built.totalCents)}`}
            </OwnerButton>
            <span className="text-[12px] text-faint">Saving posts it to the books right away. To undo, reverse it on its document page.</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

function ReceiptViewer({ businessId, receiptRef, onClose }: { businessId: string; receiptRef: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  useEffect(() => {
    let u: string | undefined;
    let live = true;
    brain
      .receiptObjectUrl(businessId, receiptRef)
      .then((x) => {
        u = x;
        if (live) setUrl(x);
        else URL.revokeObjectURL(x);
      })
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [businessId, receiptRef]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose} role="dialog" aria-label="Receipt">
      <div className="max-h-full w-full max-w-xl overflow-auto rounded-lg bg-surface p-3 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[13px] font-medium">Receipt</span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
        <ErrorNote error={error} />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img src={url} alt="Receipt" className="w-full rounded-md object-contain" /> : !error && <Loading label="Loading the receipt…" />}
      </div>
    </div>
  );
}

function ExpenseTable({ rows, names, onReceipt }: { rows: ExpenseRow[]; names: ReturnType<typeof useData>["names"]; onReceipt: (ref: string) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>Date</th>
            <th className={thCls}>Vendor</th>
            <th className={thCls}>Category</th>
            <th className={thCls}>Paid</th>
            <th className={cx(thCls, "text-right")}>Amount</th>
            <th className={thCls}>Receipt</th>
            <th className={thCls}>Document</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.doc.id)} className={r.reversed ? "text-faint line-through" : ""}>
              <td className={cx(tdCls, "whitespace-nowrap font-mono text-[11.5px]")}>{r.date || "—"}</td>
              <td className={tdCls}>
                {r.vendor || <span className="text-faint">—</span>}
                {r.doc.note && <div className="text-[11.5px] text-faint no-underline">{r.doc.note}</div>}
              </td>
              <td className={tdCls}>{[...new Set(r.lines.map((l) => names.account(l.account)))].join(", ")}</td>
              <td className={cx(tdCls, "text-muted")}>{r.paidFrom === "2000" ? "owed" : r.paidFrom === "1000" ? "paid" : names.account(r.paidFrom)}</td>
              <td className={cx(tdCls, "text-right")}>
                <Money cents={r.totalCents} />
              </td>
              <td className={tdCls}>
                {r.receiptRef ? (
                  <button type="button" className="text-accent hover:underline" onClick={() => onReceipt(r.receiptRef)}>
                    View
                  </button>
                ) : (
                  <span className="text-faint">—</span>
                )}
              </td>
              <td className={tdCls}>
                <Link href={`/documents/${r.doc.id}`} className="hover:underline">
                  #{r.doc.number}
                </Link>
                {r.reversed && <span className="ml-1.5 no-underline">reversed</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ExpensesPage() {
  const { snapshot, session, config, names } = useData();
  const setup = useMemo(() => expenseSetup(config?.config), [config]);
  // a recompiled version that has expenses but is still waiting to be activated
  const waiting = useMemo(
    () =>
      [...snapshot.configVersions]
        .filter((c) => c.status === "pending")
        .sort((a, b) => b.version - a.version)
        .find((c) => expenseSetup(readConfig(c)?.config)),
    [snapshot.configVersions],
  );
  const all = useMemo(() => expenseRows(snapshot.documents), [snapshot.documents]);
  const months = useMemo(() => [...new Set(all.map((r) => r.date.slice(0, 7)).filter(Boolean))].sort().reverse(), [all]);
  const [month, setMonth] = useState("all");
  const [adding, setAdding] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const [saved, setSaved] = useState<string | undefined>();
  const [viewing, setViewing] = useState<string | undefined>();
  const rows = month === "all" ? all : all.filter((r) => r.date.startsWith(month));
  const totals = totalsByCategory(rows);
  const grand = totals.reduce((a, t) => a + t.cents, 0n);

  if (session.mode === "live" && !session.ready) return <Loading />;

  return (
    <>
      <PageHeader
        title="Expenses"
        subtitle="Rent, supplies, wages, utilities. Snap the receipt, check what I read, and save; it posts to the books so your profit is real."
        actions={
          setup &&
          !adding && (
            <OwnerButton
              variant="primary"
              onClick={() => {
                setSaved(undefined);
                setAdding(true);
              }}
            >
              Add expense
            </OwnerButton>
          )
        }
      />
      {!setup ? (
        <Card>
          {waiting ? (
            <Empty
              title={`One step left: activate version ${waiting.version}`}
              hint={
                <>
                  Your recompiled version {waiting.version} has expenses, but your shop still runs the old one until you activate it.{" "}
                  <Link href="/build" className="font-medium text-accent hover:underline">
                    Activate it on the Build page.
                  </Link>
                </>
              }
            />
          ) : (
            <Empty
              title="Expenses aren't turned on for this business yet"
              hint={
                <>
                  Your business was set up before expense tracking existed.{" "}
                  <Link href="/build" className="font-medium text-accent hover:underline">
                    Recompile on the Build page, then activate the new version.
                  </Link>
                </>
              }
            />
          )}
        </Card>
      ) : (
        <div className="space-y-4">
          {saved && <div className="rounded-md border border-pos/30 bg-pos-soft px-3 py-2 text-[12.5px] text-pos">{saved}</div>}
          {adding && (
            <div>
              <ExpenseForm
                key={formKey}
                setup={setup}
                onDone={(msg) => {
                  setSaved(msg);
                  setAdding(false);
                  setFormKey((k) => k + 1);
                }}
              />
              <div className="mt-2">
                <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
            <Card
              pad={false}
              title={`${rows.length} expense${rows.length === 1 ? "" : "s"}`}
              actions={
                months.length > 0 && (
                  <select className="h-7 rounded-md border border-line bg-surface px-2 text-[12px]" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
                    <option value="all">All time</option>
                    {months.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                )
              }
            >
              {rows.length === 0 ? <Empty title="No expenses yet" hint="Add your first one: rent, a supply run, a utility bill." /> : <ExpenseTable rows={rows} names={names} onReceipt={setViewing} />}
            </Card>
            <Card title="By category" pad={false}>
              {totals.length === 0 ? (
                <Empty compact title="Nothing yet" />
              ) : (
                <table className={tableCls}>
                  <tbody>
                    {totals.map((t) => (
                      <tr key={t.account}>
                        <td className={tdCls}>
                          <span className="font-mono text-[11.5px] text-muted">{t.account}</span> {names.account(t.account)}
                        </td>
                        <td className={cx(tdCls, "text-right")}>
                          <Money cents={t.cents} />
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold">
                      <td className={tdCls}>Total</td>
                      <td className={cx(tdCls, "text-right")}>
                        <Money cents={grand} />
                      </td>
                    </tr>
                  </tbody>
                </table>
              )}
            </Card>
          </div>
        </div>
      )}
      {viewing && <ReceiptViewer businessId={snapshot.businessId} receiptRef={viewing} onClose={() => setViewing(undefined)} />}
    </>
  );
}
