"use client";

import { useState } from "react";
import { Badge, Button, type Tone } from "./ui";
import { provenanceLabel, type FactRow, type FactView } from "@/lib/brain";

const tone: Record<FactView["provenance"], Tone> = { owner_said: "pos", paper: "info", inferred: "warn" };

export function ProvenanceBadge({ f }: { f: FactRow }) {
  if (f.missing) return <Badge tone="neutral" title="Nobody has told me this yet">not known yet</Badge>;
  const title = f.fact.source.quote ? `"${f.fact.source.quote}"` : undefined;
  return (
    <Badge tone={tone[f.fact.provenance]} title={title}>
      {provenanceLabel[f.fact.provenance]}
    </Badge>
  );
}

export function Confidence({ f }: { f: FactRow }) {
  if (f.missing) return <span className="text-faint">–</span>;
  const pct = Math.round(f.fact.confidence * 100);
  return (
    <span className="inline-flex items-center gap-1.5" title={`confidence ${pct}%`}>
      <span className="h-1.5 w-12 overflow-hidden rounded-full bg-surface-2">
        <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
      </span>
      <span className="num text-[11.5px] text-muted">{pct}%</span>
    </span>
  );
}

export function Confirmed({ f }: { f: FactRow }) {
  return f.fact.confirmed ? <Badge tone="pos">confirmed</Badge> : <Badge tone="neutral">to confirm</Badge>;
}

export const regionColor: Record<FactView["provenance"], string> = { owner_said: "var(--pos)", paper: "var(--info)", inferred: "var(--warn)" };

/** Inline value editor: the brain coerces and checks what is typed, exactly like an interview answer. */
export function EditValue({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave(v: string): void; onCancel(): void }) {
  const [v, setV] = useState(initial);
  return (
    <form
      className="mt-0.5 flex gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        if (v.trim()) onSave(v.trim());
      }}
    >
      <input
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        aria-label="New value"
        className="h-7 min-w-0 flex-1 rounded-md border border-line-strong bg-canvas px-2 text-[13px] text-ink outline-none focus:border-accent"
      />
      <Button size="sm" variant="primary" type="submit" disabled={busy || !v.trim()}>Save</Button>
      <Button size="sm" variant="ghost" type="button" onClick={onCancel}>Cancel</Button>
    </form>
  );
}
