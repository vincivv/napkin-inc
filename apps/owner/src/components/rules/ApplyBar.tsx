"use client";

// The apply flow banner: unapplied changes -> checking (streaming compile) -> review the diff -> make it live.

import Link from "next/link";
import { Badge, Button, OwnerButton } from "@/components/ui";
import type { CompileQuestion, DiffRow } from "@/lib/compile";

export type Phase =
  | { kind: "idle" }
  | { kind: "checking"; step: string }
  | { kind: "review"; configId: bigint }
  | { kind: "activating"; configId: bigint }
  | { kind: "done"; version: number }
  | { kind: "failed"; message: string; questions: CompileQuestion[] };

export function ApplyBar({ phase, changes, onApply, onLive, onCancel }: { phase: Phase; changes: DiffRow[] | undefined; onApply(): void; onLive(): void; onCancel(): void }) {
  if (phase.kind === "done")
    return <div className="mb-6 rounded-md border border-pos/30 bg-pos-soft px-3 py-2 text-[12.5px] text-pos">Done. Your changes are live (version {phase.version}).</div>;
  return (
    <div className="mb-6 rounded-lg border border-accent/30 bg-surface px-4 py-3 shadow-card">
      {phase.kind === "idle" && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1 text-[13px]">
            <div className="font-semibold text-ink">You have changes that aren’t live yet</div>
            <div className="text-[12.5px] text-muted">I’ll check them (prices, costs, the books) and show you what customers will see before anything changes.</div>
          </div>
          <OwnerButton variant="primary" size="md" onClick={onApply}>
            Review & apply
          </OwnerButton>
        </div>
      )}
      {phase.kind === "checking" && (
        <div className="flex items-center gap-3 text-[13px]">
          <span className="flex items-center gap-2 text-ink">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" /> {phase.step}…
          </span>
          <span className="text-[12px] text-muted">This takes about 20 seconds.</span>
        </div>
      )}
      {(phase.kind === "review" || phase.kind === "activating") && (
        <div>
          <div className="mb-2 text-[13px] font-semibold text-ink">Everything checks out. Here’s what will change:</div>
          {!changes ? (
            <div className="text-[12.5px] text-muted">Loading the new version…</div>
          ) : changes.length === 0 ? (
            <div className="text-[12.5px] text-muted">Nothing customers see changes (only details like hours or names, or nothing at all).</div>
          ) : (
            <ul className="space-y-1 text-[12.5px]">
              {changes.map((d) => (
                <li key={`${d.section}:${d.key}`} className="flex flex-wrap items-baseline gap-x-2">
                  <Badge tone={d.kind === "removed" ? "neg" : d.kind === "added" ? "pos" : "warn"}>{d.section}</Badge>
                  <span className="text-ink">{d.label}</span>
                  <span className="text-muted">
                    {d.before ?? "—"} → <b className="text-ink">{d.after ?? "removed"}</b>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            <OwnerButton variant="primary" size="md" disabled={phase.kind === "activating" || !changes} onClick={onLive}>
              {phase.kind === "activating" ? "Going live…" : "Make it live"}
            </OwnerButton>
            <Button variant="ghost" onClick={onCancel} disabled={phase.kind === "activating"}>
              Not yet
            </Button>
          </div>
        </div>
      )}
      {phase.kind === "failed" && (
        <div className="text-[13px]">
          <div className="font-semibold text-neg">Not applied: one thing needs fixing first</div>
          <div className="mt-0.5 text-[12.5px] text-muted">{phase.message}</div>
          {phase.questions.length > 0 && (
            <ul className="mt-1.5 list-disc pl-5 text-[12.5px] text-ink">
              {phase.questions.map((q) => (
                <li key={q.id}>{q.question}</li>
              ))}
            </ul>
          )}
          <div className="mt-2 flex gap-2">
            <OwnerButton variant="primary" size="sm" onClick={onApply}>
              Try again
            </OwnerButton>
            {phase.questions.length > 0 && (
              <Link href="/interview">
                <Button size="sm">Answer it →</Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
