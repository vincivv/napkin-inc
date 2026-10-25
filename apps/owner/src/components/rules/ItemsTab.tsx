"use client";

// Items tab: search + one compact row per item (collapsed by default), expanding to edit price, cost, sizes, add-ons.
// Stays usable with hundreds of items: only expanded rows render their editors.

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Badge, Card, Empty, cx } from "@/components/ui";
import { itemSummary, matchesItem, priceLabel, tracksStock, type ItemGroup } from "@/lib/rules";
import { FactRows, type SaveFact } from "./FactRows";

export function ItemsTab({ items, onSave }: { items: ItemGroup[]; onSave: SaveFact }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const shown = useMemo(() => items.filter((g) => matchesItem(g, query)), [items, query]);
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  if (!items.length)
    return (
      <Card>
        <Empty title="No items yet" hint={<IntakeHint />} />
      </Card>
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 sm:max-w-sm">
          <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" fill="none" stroke="currentColor" strokeWidth="1.6">
            <circle cx="7" cy="7" r="4.5" />
            <path d="m10.5 10.5 3 3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search items, sizes or add-ons"
            aria-label="Search items"
            className="h-9 w-full rounded-md border border-line bg-surface pl-8 pr-3 text-[13px] text-ink outline-none placeholder:text-faint focus:border-line-strong"
          />
        </label>
        {query.trim() && (
          <span className="text-[12.5px] text-muted">
            {shown.length} of {items.length}
          </span>
        )}
        {open.size > 0 && (
          <button type="button" onClick={() => setOpen(new Set())} className="ml-auto text-[12.5px] text-muted hover:text-ink">
            Collapse all
          </button>
        )}
      </div>

      <Card pad={false}>
        {shown.length === 0 ? (
          <Empty compact title="No items match" hint={`Nothing named “${query.trim()}”. Try a shorter search.`} />
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((g) => (
              <ItemRow key={g.id} g={g} open={open.has(g.id)} onToggle={() => toggle(g.id)} onSave={onSave} />
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[12.5px] text-faint">
        <IntakeHint />
      </p>
    </div>
  );
}

function IntakeHint() {
  return (
    <>
      Adding a new item? Tell me about it on the{" "}
      <Link href="/intake" className="text-accent hover:underline">
        Intake page
      </Link>
      , then come back here to apply it.
    </>
  );
}

function ItemRow({ g, open, onToggle, onSave }: { g: ItemGroup; open: boolean; onToggle(): void; onSave: SaveFact }) {
  const price = priceLabel(g);
  const summary = itemSummary(g);
  const stock = tracksStock(g);
  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2"
      >
        <svg aria-hidden viewBox="0 0 16 16" className={cx("size-3.5 shrink-0 text-faint transition-transform", open && "rotate-90")} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="m6 4 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium text-ink">{g.name?.display || g.id}</span>
          {(summary || stock) && (
            <span className="block truncate text-[12px] text-muted sm:hidden">{[summary, stock && "stock tracked"].filter(Boolean).join(" · ")}</span>
          )}
        </span>
        {summary && <span className="hidden w-40 shrink-0 truncate text-[12.5px] text-muted sm:block">{summary}</span>}
        <span className="hidden w-24 shrink-0 sm:block">{stock && <Badge title="Stock is counted for this item">Stock tracked</Badge>}</span>
        <span className={cx("num w-32 shrink-0 text-right text-[13px]", price ? "text-ink" : "text-faint")}>{price ?? "No price"}</span>
      </button>

      {open && (
        <div className="space-y-5 border-t border-line bg-surface-2/40 px-4 pb-4 pl-10 pt-2">
          {(g.rows.length > 0 || (!g.sizes.length && !g.addOns.length)) && <FactRows rows={g.rows} onSave={onSave} />}
          {g.sizes.length > 0 && (
            <Sub title="Sizes">
              {g.sizes.map((s) => (
                <div key={s.id}>
                  <div className="pt-2 text-[12.5px] font-medium text-ink">{s.name?.display || s.id}</div>
                  <FactRows rows={s.rows} onSave={onSave} />
                </div>
              ))}
            </Sub>
          )}
          {g.addOns.length > 0 && (
            <Sub title="Add-ons">
              {g.addOns.map((a) => (
                <div key={a.id}>
                  <div className="pt-2 text-[12.5px] font-medium text-ink">{a.name?.display || a.id}</div>
                  <FactRows rows={a.rows} onSave={onSave} />
                </div>
              ))}
            </Sub>
          )}
          {g.hasStock && (
            <p className="text-[12px] text-faint">
              To change how many you have, use the{" "}
              <Link href="/stock" className="text-accent hover:underline">
                Stock page
              </Link>
              .
            </p>
          )}
        </div>
      )}
    </li>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div className="border-b border-line pb-1.5 text-[12px] font-medium text-faint">{title}</div>
      <div className="divide-y divide-line">{children}</div>
    </div>
  );
}
