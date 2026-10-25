// Prices & rules page model: the spec's facts grouped the way an owner reads them (each item with its sizes and
// add-ons, then shop rules, then business details), with short labels inside a group.

import type { Configuration } from "@napkin/schema";
import type { FactRow } from "./brain";

export interface ItemGroup {
  id: string;
  name: FactRow | undefined;
  rows: FactRow[];
  sizes: { id: string; name: FactRow | undefined; rows: FactRow[] }[];
  addOns: { id: string; name: FactRow | undefined; rows: FactRow[] }[];
  hasStock: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();
const ORDER = ["name", "price", "cost", "stockUnits", "stockTracked", "description"];
const byField = (a: FactRow, b: FactRow) => ORDER.indexOf(leaf(a.path)) - ORDER.indexOf(leaf(b.path));
const leaf = (path: string) => path.slice(path.lastIndexOf(".") + 1);

/** Group facts. Starting stock is left out (after launch, stock changes on the Stock page). */
export function groupFacts(facts: readonly FactRow[]): { items: ItemGroup[]; rules: FactRow[]; business: FactRow[] } {
  const items = new Map<string, ItemGroup>();
  const rules: FactRow[] = [];
  const business: FactRow[] = [];
  const item = (id: string) => {
    let g = items.get(id);
    if (!g) items.set(id, (g = { id, name: undefined, rows: [], sizes: [], addOns: [], hasStock: false }));
    return g;
  };
  for (const f of facts) {
    const m = /^offerings\.([^.]+)(?:\.(variants|addOns)\.([^.]+))?\.(\w+)$/.exec(f.path);
    if (m) {
      const [, oid, grp, eid, field] = m as unknown as [string, string, string | undefined, string | undefined, string];
      const g = item(oid);
      if (field === "initialStock") {
        g.hasStock = true;
        continue;
      }
      if (!grp) {
        if (field === "name") g.name = f;
        else g.rows.push(f);
        continue;
      }
      const list = grp === "variants" ? g.sizes : g.addOns;
      let el = list.find((x) => x.id === eid);
      if (!el) list.push((el = { id: eid!, name: undefined, rows: [] }));
      if (field === "name") el.name = f;
      else el.rows.push(f);
      continue;
    }
    if (f.path.startsWith("policies.")) rules.push(f);
    else if (f.path.startsWith("business.") || f.path.startsWith("operations.")) business.push(f);
  }
  const out = [...items.values()];
  for (const g of out) {
    // a one-size item ("Beef burrito" sold as "Beef burrito"): show its price and cost on the item itself
    if (g.sizes.length === 1 && same(g.sizes[0]!.name?.display, g.name?.display)) {
      g.rows.push(...g.sizes[0]!.rows);
      g.sizes = [];
    }
    g.rows.sort(byField);
    for (const s of g.sizes) s.rows.sort(byField);
    for (const a of g.addOns) a.rows.sort(byField);
  }
  return { items: out, rules, business };
}

const SHORT: Record<string, string> = {
  price: "Price",
  stockUnits: "How many go into one",
  stockTracked: "Track stock",
  description: "Description",
  name: "Name",
};

/** Short label inside a group; shop rules and details keep the engine's own wording, capitalized. */
export function rowLabel(f: FactRow): string {
  const m = /^offerings\.[^.]+(?:\.(variants|addOns)\.[^.]+)?\.(\w+)$/.exec(f.path);
  if (m) {
    if (m[2] === "cost") return m[1] === "addOns" ? "Your cost per add-on" : "Your cost to make one";
    return SHORT[m[2]!] ?? f.label;
  }
  return f.label.charAt(0).toUpperCase() + f.label.slice(1);
}

/** The BusinessSpec version a configuration was compiled from ("compiled from BusinessSpec v12 (...)"). */
export function compiledSpecVersion(config: Configuration | undefined): number | undefined {
  const m = /BusinessSpec v(\d+)/.exec(config?.source ?? "");
  return m ? Number(m[1]) : undefined;
}
