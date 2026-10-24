"use client";

import Link from "next/link";
import { useData } from "@/data/context";
import type { DocLine, DocumentRow, FieldValue } from "@/data/types";
import { Mono, StatusBadge, cx, tableCls, tdCls, thCls } from "./ui";
import { formatCents, parseDollars } from "@/lib/money";

/** A scalar document value shown for people: money-looking field names as dollars, product ids as names. */
export function fieldDisplay(name: string, value: string, entry: (id: string) => string): string {
  if (/^-?\d+(\.\d{1,2})?$/.test(value) && /(price|cost|amount|total|fee|discount|subtotal|tax|net|gross)/i.test(name)) {
    try {
      return formatCents(parseDollars(value));
    } catch {
      return value;
    }
  }
  if (/(^|_)(productid|item|product)$/i.test(name) || name === "productId") return entry(value);
  return value;
}

export function FieldGrid({ fields }: { fields: readonly FieldValue[] }) {
  const { names } = useData();
  if (!fields.length) return <div className="text-[12.5px] text-faint">No fields.</div>;
  return (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 md:grid-cols-3">
      {fields.map((f) => (
        <div key={f.name} className="min-w-0">
          <dt className="text-[11.5px] font-medium text-faint">{f.name}</dt>
          <dd className="mt-0.5 break-words text-[13px]">{f.value === "" ? <span className="text-faint">—</span> : fieldDisplay(f.name, f.value, names.entry)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function LinesTable({ lines }: { lines: readonly DocLine[] }) {
  const { names } = useData();
  if (!lines.length) return <div className="px-4 py-3 text-[12.5px] text-faint">No lines.</div>;
  const cols: string[] = [];
  for (const l of lines) for (const v of l.values) if (!cols.includes(v.name)) cols.push(v.name);
  return (
    <div className="overflow-x-auto">
      <table className={tableCls}>
        <thead>
          <tr>
            <th className={thCls}>#</th>
            {cols.map((c) => (
              <th key={c} className={thCls}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td className={cx(tdCls, "text-faint")}>{i + 1}</td>
              {cols.map((c) => {
                const v = l.values.find((x) => x.name === c)?.value;
                return (
                  <td key={c} className={tdCls}>
                    {v === undefined ? <span className="text-faint">—</span> : fieldDisplay(c, v, names.entry)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocLink({ doc }: { doc: DocumentRow }) {
  const { names } = useData();
  return (
    <Link href={`/documents/${doc.id}`} className="text-accent-ink hover:underline">
      {names.docType(doc.docType)} #{doc.number}
    </Link>
  );
}

export function LinkedDocs({ docs }: { docs: readonly DocumentRow[] }) {
  const { names } = useData();
  return (
    <table className={tableCls}>
      <thead>
        <tr>
          <th className={thCls}>Document</th>
          <th className={thCls}>Status</th>
          <th className={cx(thCls, "text-right")}>Amount</th>
        </tr>
      </thead>
      <tbody>
        {docs.map((d) => (
          <tr key={String(d.id)}>
            <td className={tdCls}>
              <DocLink doc={d} /> <Mono>{names.docType(d.docType) === d.docType ? "" : d.docType}</Mono>
            </td>
            <td className={tdCls}>
              <StatusBadge status={d.status} />
            </td>
            <td className={cx(tdCls, "num text-right")}>{formatCents(d.totalCents)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
