"use client";

// Key/value list of spec facts, each editable in place (the brain coerces and checks what is typed).

import { useState } from "react";
import { useData } from "@/data/context";
import { Badge, Button, cx } from "@/components/ui";
import { EditValue } from "@/components/facts";
import type { FactRow } from "@/lib/brain";
import { rowLabel } from "@/lib/rules";

export type SaveFact = (path: string, value: string) => Promise<string | undefined>;

export function FactRows({ rows, onSave, empty = "Nothing here yet." }: { rows: FactRow[]; onSave: SaveFact; empty?: string }) {
  if (!rows.length) return <div className="py-2 text-[12.5px] text-faint">{empty}</div>;
  return (
    <dl className="divide-y divide-line">
      {rows.map((f) => (
        <FactRowView key={f.path} f={f} onSave={onSave} />
      ))}
    </dl>
  );
}

function FactRowView({ f, onSave }: { f: FactRow; onSave: SaveFact }) {
  const { isOwner } = useData();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const unsure = !f.missing && !f.fact.confirmed;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 py-2.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)_auto]">
      <dt className="col-span-2 text-[13px] text-muted sm:col-span-1">{rowLabel(f)}</dt>
      <dd className="min-w-0">
        {editing ? (
          <EditValue
            initial={f.missing ? "" : (f.display ?? "")}
            busy={busy}
            onCancel={() => {
              setEditing(false);
              setErr(undefined);
            }}
            onSave={async (v) => {
              setBusy(true);
              const e = await onSave(f.path, v);
              setBusy(false);
              setErr(e);
              if (!e) setEditing(false);
            }}
          />
        ) : (
          <span className={cx("break-words text-[13.5px]", f.missing ? "text-faint" : "text-ink")}>{f.missing ? "Not set" : f.display || "(empty)"}</span>
        )}
        {unsure && !editing && (
          <Badge tone="warn" className="ml-2" title="Display only: never used for money until you confirm it">
            not confirmed
          </Badge>
        )}
        {err && <div className="mt-1 text-[12px] text-neg">{err}</div>}
      </dd>
      <div className="flex justify-end">
        {!editing && isOwner && (
          <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
            {f.missing ? "Set" : "Change"}
          </Button>
        )}
      </div>
    </div>
  );
}
