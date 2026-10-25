"use client";

import { useState } from "react";
import { useData } from "@/data/context";
import type { OwnerStatementRow } from "@/data/types";
import { Badge, ErrorNote, OwnerButton, RelTime, errText } from "@/components/ui";
import { describePath, valueAtPath } from "@/lib/config";

const STATUS: Record<string, { label: string; tone: "warn" | "pos" | "neg" | "neutral" }> = {
  queued: { label: "Waiting for you", tone: "warn" },
  confirmed: { label: "Confirmed", tone: "pos" },
  applied: { label: "Applied", tone: "pos" },
  rejected: { label: "Rejected", tone: "neg" },
};

/** An instruction the owner gave (usually by phone) that waits for a confirm/reject here. */
export function StatementCard({ s }: { s: OwnerStatementRow }) {
  const { actions, config } = useData();
  const [busy, setBusy] = useState<"confirm" | "reject">();
  const [err, setErr] = useState<string>();
  let diff: { path: string; from?: unknown; to?: unknown }[] = [];
  try {
    const v = JSON.parse(s.diffJson);
    if (Array.isArray(v)) diff = v;
  } catch {
    /* free-text only */
  }
  const phone = s.channel === "phone";
  const queued = s.status === "queued";
  const st = STATUS[s.status] ?? { label: s.status.replace(/_/g, " "), tone: "neutral" as const };
  const decide = async (confirm: boolean) => {
    setBusy(confirm ? "confirm" : "reject");
    setErr(undefined);
    try {
      await actions.decideOwnerStatement(s.id, confirm);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <article className="px-5 py-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[13px]">
        <span className="font-medium text-ink">{phone ? "You said on the phone" : `You said (${s.channel})`}</span>
        <span className="text-faint">
          <RelTime ts={s.createdAt} />
        </span>
        <span className="flex-1" />
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="text-[14.5px] leading-relaxed text-ink">“{s.text}”</div>
      {diff.length > 0 && (
        <div className="mt-3 rounded-lg border border-line">
          <div className="border-b border-line px-3.5 py-2 text-[12.5px] font-medium text-muted">{queued ? "This will change" : "Changes"}</div>
          <ul className="divide-y divide-line text-[13.5px]">
            {diff.map((d, i) => (
              <li key={i} className="flex flex-wrap items-baseline gap-x-2 px-3.5 py-2">
                <span className="text-muted">{describePath(config?.config, d.path)}</span>
                <span className="num text-faint line-through">{String(d.from ?? valueAtPath(config?.config, d.path) ?? "—")}</span>
                <span className="text-faint">→</span>
                <span className="num font-semibold text-ink">{String(d.to ?? "—")}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {queued && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <OwnerButton variant="primary" disabled={!!busy} onClick={() => decide(true)}>
            {busy === "confirm" ? "Confirming…" : "Yes, do it"}
          </OwnerButton>
          <OwnerButton variant="danger" disabled={!!busy} onClick={() => decide(false)}>
            {busy === "reject" ? "Rejecting…" : "No, cancel it"}
          </OwnerButton>
          <span className="text-[12.5px] text-faint">Nothing changes until you confirm.</span>
        </div>
      )}
      <ErrorNote error={err} />
    </article>
  );
}
