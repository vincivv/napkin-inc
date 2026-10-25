"use client";

// Stock: what the shop has on hand, read straight from the stock register (every sale takes units out in the
// same transaction that books it; opening stock and approved deliveries put units in). Counts are never
// estimated: "can fill" divides the booked quantity by each product's units, "days left" is the last 7 days' pace.

import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { useData } from "@/data/context";
import { Badge, Card, Empty, ErrorNote, Loading, Money, OwnerButton, PageHeader, RelTime, Stat, cx, errText, fmtTime, tableCls, tdCls, thCls, type Tone } from "@/components/ui";
import { productsUsingStock } from "@/lib/config";
import { docLabel, useDocMap, useTz } from "@/lib/hooks";
import { buildStockChange, canChangeStock, daysLeft, lineValue, PAID_FROM, pendingDeliveries, REMOVE_REASONS, stockItems, type StockChange, type StockDraft, type StockItemView } from "@/lib/stock";
import { formatCents } from "@/lib/money";
import type { StockLevel } from "@/lib/reports";
import type { DocumentRow } from "@/data/types";

const levelTone: Record<StockLevel, Tone> = { out: "neg", critical: "neg", low: "warn", ok: "pos" };

function levelLabel(v: StockItemView): string {
  if (v.level === "out") return "Out";
  if (v.level === "critical") return `Can’t fill ${v.largest?.name ?? "one"}`;
  if (v.level === "low") return "Running low";
  return "OK";
}

export default function StockPage() {
  const { snapshot, session, config } = useData();
  const tz = useTz();
  const packs = useMemo(() => productsUsingStock(config?.config), [config]);
  const docs = useDocMap();
  const items = useMemo(
    () => stockItems(config?.config, snapshot.registerBalances, snapshot.registerMovements, packs, tz, (id) => docs.get(id)?.docType),
    [config, snapshot.registerBalances, snapshot.registerMovements, packs, tz, docs],
  );
  const pending = useMemo(() => pendingDeliveries(snapshot.documents), [snapshot.documents]);
  const [open, setOpen] = useState<string>();
  const [change, setChange] = useState<{ kind: StockChange; item: string }>();
  const [saved, setSaved] = useState<string>();
  const editable = canChangeStock(config?.config);
  const start = (kind: StockChange, item = "") => {
    setSaved(undefined);
    setChange({ kind, item });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  if (session.mode === "live" && !session.ready) return <Loading />;

  const totalValue = items.reduce((s, v) => s + v.valueCents, 0n);
  const attention = items.filter((v) => v.level !== "ok");
  const usedToday = items.reduce((s, v) => s + v.usedToday, 0n);
  const placeholder = (config?.config?._unconfirmed?.paths ?? []).some((p) => p.startsWith("initialStock"));

  return (
    <>
      <PageHeader
        title="Stock"
        subtitle="What you have on hand right now. Every sale takes stock out the moment it’s booked."
        actions={
          editable && items.length > 0 ? (
            <>
              <OwnerButton size="md" variant="primary" onClick={() => start("add")}>
                + Add stock
              </OwnerButton>
              <OwnerButton size="md" onClick={() => start("remove")}>
                Remove stock
              </OwnerButton>
            </>
          ) : undefined
        }
      />
      {saved && <div className="mb-4 rounded-md border border-pos/30 bg-pos-soft px-3 py-2 text-[12.5px] text-pos">{saved}</div>}
      {change && (
        <StockChangeForm
          key={`${change.kind}:${change.item}`}
          kind={change.kind}
          initialItem={change.item}
          items={items}
          onCancel={() => setChange(undefined)}
          onDone={(msg) => {
            setChange(undefined);
            setSaved(msg);
          }}
        />
      )}
      {!editable && items.length > 0 && (
        <div className="mb-4 rounded-md border border-line bg-surface px-3 py-2 text-[12.5px] text-muted">
          Your shop was set up before you could add or remove stock here.{" "}
          <Link href="/build" className="font-medium text-accent hover:underline">
            Recompile on the Build page to turn it on.
          </Link>
        </div>
      )}
      {items.length === 0 ? (
        <Card>
          <Empty title="Nothing tracked yet" hint="Stock shows up here once your shop is live and its starting stock is on the books." />
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Items tracked" value={items.length} />
            <Stat label="Stock value at cost" value={<Money cents={totalValue} />} />
            <Stat
              label="Need restocking"
              value={attention.length}
              tone={attention.some((v) => v.level === "out" || v.level === "critical") ? "neg" : undefined}
              sub={attention.length ? attention.map((v) => v.name).join(", ") : "Everything is stocked"}
            />
            <Stat label="Sold today" value={usedToday.toString()} sub="units, across all items" />
          </div>

          {placeholder && (
            <div className="rounded-lg border border-warn/40 bg-warn-soft/60 px-4 py-2.5 text-[12.5px] text-warn">
              Your starting stock is a placeholder you haven’t confirmed yet, so these counts may not match your shelf.
            </div>
          )}

          {pending.length > 0 && <PendingDeliveries docs={pending} />}

          <Card title="On hand" pad={false}>
            <div className="overflow-x-auto">
              <table className={tableCls}>
                <thead>
                  <tr>
                    <th className={thCls}>Item</th>
                    <th className={cx(thCls, "text-right")}>On hand</th>
                    <th className={thCls}>Can fill</th>
                    <th className={cx(thCls, "text-right")}>Sold today</th>
                    <th className={thCls}>Sold, 7 days</th>
                    <th className={cx(thCls, "text-right")}>Value at cost</th>
                    <th className={thCls}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((v) => {
                    const left = daysLeft(v);
                    const isOpen = open === v.item;
                    return (
                      <Fragment key={v.item}>
                        <tr
                          className={cx("cursor-pointer hover:bg-surface-2", v.level !== "ok" && (v.level === "low" ? "bg-warn-soft/40" : "bg-neg-soft/40"))}
                          onClick={() => setOpen(isOpen ? undefined : v.item)}
                          aria-expanded={isOpen}
                        >
                          <td className={tdCls}>
                            <div className="font-medium">
                              <span className="mr-1.5 inline-block w-3 text-faint">{isOpen ? "▾" : "▸"}</span>
                              {v.name}
                            </div>
                            <div className="whitespace-nowrap pl-[18px] text-[11.5px] text-faint">
                              {v.lastIn ? <>Last added <RelTime ts={v.lastIn.postedAt} /></> : "No stock added yet"}
                            </div>
                          </td>
                          <td className={cx(tdCls, "text-right")}>
                            <span className={cx("num text-[16px] font-semibold", v.level === "out" || v.level === "critical" ? "text-neg" : v.level === "low" ? "text-warn" : "")}>{v.qty.toString()}</span>
                            {left !== undefined && <div className="whitespace-nowrap text-[11.5px] text-faint">≈ {left === 0 ? "under a day" : `${left} day${left === 1 ? "" : "s"}`} left</div>}
                          </td>
                          <td className={cx(tdCls, "text-[12.5px]")}>
                            {v.fills.length === 0 ? (
                              <span className="text-faint">Not used by any item</span>
                            ) : (
                              v.fills.map((f) => (
                                <div key={f.productId} className="whitespace-nowrap">
                                  <span className="num font-medium">{f.count.toString()}</span> × {f.name}
                                  {f.units > 1n && <span className="text-faint"> ({f.units.toString()} each)</span>}
                                </div>
                              ))
                            )}
                          </td>
                          <td className={cx(tdCls, "num text-right")}>{v.usedToday.toString()}</td>
                          <td className={tdCls}>
                            <Spark daily={v.daily} />
                          </td>
                          <td className={cx(tdCls, "text-right")}>
                            <Money cents={v.valueCents} muted0 />
                            {v.unitCostCents !== undefined && (
                              <div className="text-[11.5px] text-faint">
                                <Money cents={v.unitCostCents} /> each
                              </div>
                            )}
                          </td>
                          <td className={tdCls}>
                            <Badge
                              tone={levelTone[v.level]}
                              title={v.largest ? `“Can’t fill” is below one ${v.largest.name} (${v.largest.units}); “running low” is below two.` : undefined}
                            >
                              {levelLabel(v)}
                            </Badge>
                            {editable && (
                              <div className="-ml-1.5 mt-1 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                              <button className="rounded px-1.5 py-0.5 text-[12px] font-medium text-accent-ink hover:bg-accent-soft" onClick={() => start("add", v.item)}>
                                + Add
                              </button>
                              <button className="rounded px-1.5 py-0.5 text-[12px] text-muted hover:bg-surface-2 hover:text-ink disabled:opacity-40" disabled={v.qty <= 0n} onClick={() => start("remove", v.item)}>
                                Remove
                              </button>
                              </div>
                            )}
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="border-b border-line bg-surface-2/60 px-4 py-3">
                              <History v={v} tz={tz} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
          <p className="text-[12px] text-faint">
            Counts come from your books: starting stock and stock you add go in, sales and stock you remove come out, refunds don’t put items back. Click a row to see every change.
          </p>
        </div>
      )}
    </>
  );
}

/** Seven small bars, one per day, so a busy day stands out. */
function Spark({ daily }: { daily: StockItemView["daily"] }) {
  const max = daily.reduce((m, d) => (d.used > m ? d.used : m), 0n);
  const total = daily.reduce((s, d) => s + d.used, 0n);
  return (
    <div className="flex items-end gap-2" title={daily.map((d) => `${d.day}: ${d.used}`).join("\n")}>
      <div className="flex h-6 items-end gap-[3px]" aria-hidden>
        {daily.map((d) => (
          <span key={d.day} className={cx("w-[6px] rounded-sm", d.used > 0n ? "bg-accent" : "bg-line")} style={{ height: max > 0n && d.used > 0n ? `${Math.max(15, Math.round((Number(d.used) / Number(max)) * 100))}%` : "3px" }} />
        ))}
      </div>
      <span className="num text-[12px] text-muted">{total.toString()}</span>
    </div>
  );
}

function History({ v, tz }: { v: StockItemView; tz: string }) {
  const { names } = useData();
  const docs = useDocMap();
  const rows = v.movements.slice(0, 25);
  if (!rows.length) return <div className="text-[12.5px] text-faint">No changes on the books yet.</div>;
  return (
    <div>
      <div className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">Recent changes · {v.name}</div>
      <table className="w-full text-[12.5px]">
        <tbody>
          {rows.map((m) => {
            const doc = docs.get(m.documentId);
            const n = m.qty < 0n ? -m.qty : m.qty;
            return (
              <tr key={String(m.id)} className="border-t border-line/60 first:border-t-0">
                <td className="whitespace-nowrap py-1 pr-3 text-muted">{fmtTime(m.postedAt, tz)}</td>
                <td className="py-1 pr-3">
                  <Link className="text-accent-ink hover:underline" href={`/documents/${m.documentId}`} onClick={(e) => e.stopPropagation()}>
                    {docLabel(doc, names)}
                  </Link>
                </td>
                <td className={cx("num whitespace-nowrap py-1 pr-3 text-right font-medium", m.kind === "in" ? "text-pos" : "")}>
                  {m.kind === "in" ? "+" : "−"}
                  {n.toString()}
                </td>
                <td className="py-1 text-right">
                  <Money cents={m.amountCents} muted0 />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {v.movements.length > rows.length && (
        <Link href="/registers" className="mt-1.5 inline-block text-[12px] text-accent-ink hover:underline">
          All {v.movements.length} changes →
        </Link>
      )}
    </div>
  );
}

/** Deliveries waiting for approval: shown so the owner knows the counts above don't include them yet. */
function PendingDeliveries({ docs }: { docs: readonly DocumentRow[] }) {
  const { actions, session, config } = useData();
  const [busy, setBusy] = useState<bigint>();
  const [err, setErr] = useState<string>();
  const nameOf = (id: string) => String(config?.config?.catalogs.find((c) => c.lineKey === "stockItem")?.entries.find((e) => e.id === id)?.data["name"] ?? id);
  return (
    <Card title={`Deliveries waiting for approval (${docs.length})`} pad={false}>
      <ErrorNote error={err} />
      <div className="divide-y divide-line">
        {docs.map((d) => {
          const mine = !!session.identityHex && d.createdBy.toHexString() === session.identityHex;
          const supplier = d.fields.find((f) => f.name === "supplier")?.value;
          return (
            <div key={String(d.id)} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1 text-[13px]">
                <div className="font-medium">
                  {d.lines.map((l) => `+${lineValue(l, "qty")} ${nameOf(lineValue(l, "stockItem"))}`).join(", ")}
                  {supplier && <span className="font-normal text-muted"> · from {supplier}</span>}
                </div>
                <div className="text-[11.5px] text-faint">
                  <Link href={`/documents/${d.id}`} className="hover:underline">
                    Stock receipt #{d.number}
                  </Link>{" "}
                  · not in the counts until approved
                </div>
              </div>
              <OwnerButton
                size="sm"
                variant="primary"
                disabled={busy !== undefined}
                reason={mine ? "You recorded this delivery; someone else must approve it" : undefined}
                onClick={async () => {
                  setBusy(d.id);
                  setErr(undefined);
                  try {
                    await actions.postDocument(d.id);
                  } catch (e) {
                    setErr(errText(e));
                  } finally {
                    setBusy(undefined);
                  }
                }}
              >
                {busy === d.id ? "Approving…" : "Approve"}
              </OwnerButton>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

const inputCls = "h-8 w-full min-w-0 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent disabled:opacity-50";
const labelCls = "mb-1 block text-[11.5px] font-medium text-faint";
const centsToDollars = (c: bigint | undefined) => (c === undefined ? "" : `${c / 100n}.${String(c % 100n).padStart(2, "0")}`);

/** Add stock (a delivery, a fresh batch) or take it out (spoiled, a recount). Posts as the owner; the books refuse going below zero. */
function StockChangeForm({ kind, initialItem, items, onCancel, onDone }: { kind: StockChange; initialItem: string; items: readonly StockItemView[]; onCancel: () => void; onDone: (msg: string) => void }) {
  const { actions } = useData();
  const pick = (id: string) => items.find((v) => v.item === id);
  const [d, setD] = useState<StockDraft>(() => ({ item: initialItem, qty: "", unitCost: centsToDollars(pick(initialItem)?.unitCostCents), paidFrom: "", supplier: "", reason: "" }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const cur = pick(d.item);
  const set = <K extends keyof StockDraft>(k: K, v: StockDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const built = buildStockChange(kind, d, cur?.qty);
  const add = kind === "add";

  async function save() {
    if ("error" in built) return setErr(built.error);
    setBusy(true);
    setErr(undefined);
    try {
      await actions.createDocument({ docType: built.docType, fields: built.fields, lines: built.lines, note: "" });
      const after = (cur?.qty ?? 0n) + (add ? 1n : -1n) * BigInt(d.qty.trim());
      onDone(`${add ? "Added" : "Took out"} ${d.qty.trim()} ${cur?.name ?? d.item}. You now have ${after}.`);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mb-4" title={add ? "Add stock" : "Remove stock"}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label>
            <span className={labelCls}>Item</span>
            <select
              className={inputCls}
              value={d.item}
              autoFocus={!d.item}
              onChange={(e) => setD((x) => ({ ...x, item: e.target.value, unitCost: centsToDollars(pick(e.target.value)?.unitCostCents) }))}
            >
              <option value="">Pick an item…</option>
              {items.map((v) => (
                <option key={v.item} value={v.item} disabled={!add && v.qty <= 0n}>
                  {v.name} ({v.qty.toString()} on hand)
                </option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelCls}>{add ? "How many came in" : "How many to take out"}</span>
            <input className={inputCls} inputMode="numeric" autoFocus={!!d.item} value={d.qty} onChange={(e) => set("qty", e.target.value.replace(/[^\d]/g, "").slice(0, 6))} placeholder="e.g. 20" />
          </label>
          <label>
            <span className={labelCls}>Cost of one</span>
            <input className={inputCls} inputMode="decimal" value={d.unitCost} disabled={!add} onChange={(e) => set("unitCost", e.target.value)} placeholder="e.g. 2.50" />
          </label>
        </div>
        {add ? (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <fieldset>
              <span className={labelCls}>How did you pay for it?</span>
              <div className="flex flex-wrap gap-2">
                {PAID_FROM.map((p) => (
                  <label key={p.code} className={cx("cursor-pointer rounded-md border px-3 py-1.5 text-[12.5px]", d.paidFrom === p.code ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong hover:bg-surface-2")}>
                    <input type="radio" className="sr-only" name="paidFrom" checked={d.paidFrom === p.code} onChange={() => set("paidFrom", p.code)} />
                    <span className="font-medium">{p.label}</span> <span className="text-faint">· {p.hint}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <label>
              <span className={labelCls}>Supplier (optional)</span>
              <input className={inputCls} value={d.supplier} onChange={(e) => set("supplier", e.target.value)} placeholder="e.g. Costco" />
            </label>
          </div>
        ) : (
          <fieldset>
            <span className={labelCls}>Why?</span>
            <div className="flex flex-wrap gap-2">
              {REMOVE_REASONS.map((r) => (
                <label key={r} className={cx("cursor-pointer rounded-md border px-3 py-1.5 text-[12.5px]", d.reason === r ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong hover:bg-surface-2")}>
                  <input type="radio" className="sr-only" name="reason" checked={d.reason === r} onChange={() => set("reason", r)} />
                  {r}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
          <div className="min-w-0 flex-1 text-[12.5px] text-muted">
            {"error" in built ? (
              err ? <span className="text-neg">{err}</span> : cur ? <>You have {cur.qty.toString()} {cur.name} now.</> : "Pick what changed."
            ) : add ? (
              <>
                {cur?.name}: {cur?.qty.toString()} → <b className="text-ink">{((cur?.qty ?? 0n) + BigInt(d.qty)).toString()}</b> · adds {formatCents(built.valueCents)} of stock to your books
              </>
            ) : (
              <>
                {cur?.name}: {cur?.qty.toString()} → <b className="text-ink">{((cur?.qty ?? 0n) - BigInt(d.qty)).toString()}</b> · writes off {formatCents(built.valueCents)} at cost
              </>
            )}
            {err && !("error" in built) && <span className="block text-neg">{err}</span>}
          </div>
          <OwnerButton type="button" size="md" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </OwnerButton>
          <OwnerButton type="submit" size="md" variant="primary" disabled={busy}>
            {busy ? "Saving…" : add ? "Add to stock" : "Take out of stock"}
          </OwnerButton>
        </div>
      </form>
    </Card>
  );
}
