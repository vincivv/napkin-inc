"use client";

import Link from "next/link";
import { useState } from "react";
import { useData } from "@/data/context";
import type { InboxItemRow, OwnerStatementRow } from "@/data/types";
import { Badge, Button, Card, Empty, ErrorNote, Loading, OwnerButton, PageHeader, RelTime, StatusBadge, errText } from "@/components/ui";
import { describePath, valueAtPath } from "@/lib/config";
import { newestFirst, refHref } from "@/lib/hooks";

function prettyContext(json: string): string {
  try {
    const v = JSON.parse(json);
    if (v && typeof v === "object" && Object.keys(v).length === 0) return "";
    return JSON.stringify(v, null, 2);
  } catch {
    return json;
  }
}

function InboxCard({ item }: { item: InboxItemRow }) {
  const { actions, isOwner } = useData();
  const [answer, setAnswer] = useState("");
  const [precedent, setPrecedent] = useState(false);
  const [rule, setRule] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const ref = refHref(item.documentRef);
  const ctx = prettyContext(item.contextJson);
  const open = item.status === "open";
  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.status} />
        <span className="font-medium">{item.fromRole}</span>
        <span className="text-faint">asks</span>
        <span className="flex-1" />
        <RelTime ts={item.createdAt} />
      </div>
      <div className="mt-1 text-[13.5px]">{item.question}</div>
      {ref && (
        <Link href={ref.href} className="mt-1 inline-block text-[12px] text-accent-ink hover:underline">
          {ref.label} →
        </Link>
      )}
      {ctx && <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-surface-2 p-2 font-mono text-[11.5px] text-muted">{ctx}</pre>}
      {!open && <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13px]"><span className="text-faint">Your answer: </span>{item.answer}</div>}
      {open && (
        <div className="mt-3 space-y-2">
          <textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} placeholder="Your answer" disabled={!isOwner} className="w-full rounded-md border border-line bg-surface px-2 py-1.5 text-[13px] disabled:opacity-50" />
          <label className="flex items-center gap-2 text-[12.5px] text-muted">
            <input type="checkbox" checked={precedent} onChange={(e) => setPrecedent(e.target.checked)} disabled={!isOwner} />
            Make this a precedent ({item.fromRole} will follow it next time)
          </label>
          {precedent && <input value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Rule in one sentence (defaults to your answer)" className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[13px]" />}
          <div className="flex items-center gap-2">
            <OwnerButton
              variant="primary"
              disabled={busy || !answer.trim()}
              onClick={async () => {
                setBusy(true);
                setErr(undefined);
                try {
                  await actions.answerInbox(item.id, answer.trim(), precedent, precedent ? rule.trim() || answer.trim() : "", "{}");
                } catch (e) {
                  setErr(errText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Sending…" : "Send answer"}
            </OwnerButton>
          </div>
          <ErrorNote error={err} />
        </div>
      )}
    </div>
  );
}

function StatementCard({ s }: { s: OwnerStatementRow }) {
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
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={s.status} />
        <Badge tone={phone ? "warn" : "neutral"}>{s.channel}</Badge>
        {phone && s.status === "queued" && <Badge tone="warn">needs your confirmation</Badge>}
        <span className="flex-1" />
        <RelTime ts={s.createdAt} />
      </div>
      <div className="mt-1 text-[13.5px]">“{s.text}”</div>
      {diff.length > 0 && (
        <div className="mt-2 space-y-1 rounded-md bg-surface-2 p-2 text-[12.5px]">
          {diff.map((d, i) => (
            <div key={i}>
              <span className="text-muted">{describePath(config?.config, d.path)}:</span> <span className="num line-through opacity-60">{String(d.from ?? valueAtPath(config?.config, d.path) ?? "—")}</span> → <span className="num font-semibold">{String(d.to ?? "—")}</span>
            </div>
          ))}
        </div>
      )}
      {s.status === "queued" && (
        <div className="mt-3 flex items-center gap-2">
          <OwnerButton variant="primary" disabled={!!busy} onClick={() => decide(true)}>
            {busy === "confirm" ? "Confirming…" : "Confirm"}
          </OwnerButton>
          <OwnerButton variant="danger" disabled={!!busy} onClick={() => decide(false)}>
            Reject
          </OwnerButton>
        </div>
      )}
      <ErrorNote error={err} />
    </div>
  );
}

export default function InboxPage() {
  const { snapshot, session } = useData();
  if (session.mode === "live" && !session.ready) return <Loading />;
  const items = newestFirst(snapshot.inbox, (i) => i.createdAt.microsSinceUnixEpoch, (i) => i.id);
  const open = items.filter((i) => i.status === "open");
  const done = items.filter((i) => i.status !== "open");
  const stm = newestFirst(snapshot.ownerStatements, (s) => s.createdAt.microsSinceUnixEpoch, (s) => s.id);
  const queued = stm.filter((s) => s.status === "queued");
  const decided = stm.filter((s) => s.status !== "queued");
  return (
    <>
      <PageHeader title="Inbox" subtitle="Questions your staff could not settle, and instructions waiting for your confirmation." />
      <div className="space-y-4">
        <Card id="statements" title={`Owner statements waiting (${queued.length})`} pad={false}>
          {queued.length === 0 ? <Empty compact title="Nothing waiting" hint="Instructions given by phone stay here until you confirm them." /> : <div className="divide-y divide-line">{queued.map((s) => <StatementCard key={String(s.id)} s={s} />)}</div>}
        </Card>
        <Card title={`Open questions (${open.length})`} pad={false}>
          {open.length === 0 ? <Empty compact title="No open questions" hint="Agents escalate here when a request is outside policy." /> : <div className="divide-y divide-line">{open.map((i) => <InboxCard key={String(i.id)} item={i} />)}</div>}
        </Card>
        {(done.length > 0 || decided.length > 0 || snapshot.precedents.length > 0) && (
          <Card title="History" pad={false}>
            <div className="divide-y divide-line">
              {done.map((i) => <InboxCard key={`i${i.id}`} item={i} />)}
              {decided.map((s) => <StatementCard key={`s${s.id}`} s={s} />)}
            </div>
            {snapshot.precedents.length > 0 && (
              <div className="border-t border-line px-4 py-3 text-[12.5px]">
                <div className="mb-1 font-medium text-muted">Precedents agents follow</div>
                <ul className="list-disc pl-5">
                  {snapshot.precedents.map((p) => (
                    <li key={String(p.id)}><span className="font-medium">{p.agentRole}:</span> {p.rule}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
