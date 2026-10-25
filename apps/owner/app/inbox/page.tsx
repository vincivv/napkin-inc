"use client";

import { useMemo } from "react";
import { useData } from "@/data/context";
import type { InboxItemRow } from "@/data/types";
import { Card, Empty, Loading, PageHeader } from "@/components/ui";
import { AnsweredRow, QuestionCard } from "@/components/inbox/QuestionCard";
import { StatementCard } from "@/components/inbox/StatementCard";
import { newestFirst } from "@/lib/hooks";
import { roleLabel, similarityKey } from "@/lib/inbox";

/** Open questions grouped so the same question asked again shows once (newest first, with its earlier copies). */
function groupSimilar(open: InboxItemRow[]): { item: InboxItemRow; earlier: InboxItemRow[] }[] {
  const groups = new Map<string, { item: InboxItemRow; earlier: InboxItemRow[] }>();
  for (const i of open) {
    const k = similarityKey(i.fromRole, i.question);
    const g = groups.get(k);
    if (g) g.earlier.push(i);
    else groups.set(k, { item: i, earlier: [] });
  }
  return [...groups.values()];
}

function Count({ n }: { n: number }) {
  return <span className="num ml-1.5 rounded-full bg-surface-2 px-2 py-px text-[12px] font-medium text-muted">{n}</span>;
}

export default function InboxPage() {
  const { snapshot, session } = useData();
  const items = useMemo(() => newestFirst(snapshot.inbox, (i) => i.createdAt.microsSinceUnixEpoch, (i) => i.id), [snapshot.inbox]);
  const stm = useMemo(() => newestFirst(snapshot.ownerStatements, (s) => s.createdAt.microsSinceUnixEpoch, (s) => s.id), [snapshot.ownerStatements]);
  if (session.mode === "live" && !session.ready) return <Loading />;
  const open = items.filter((i) => i.status === "open");
  const groups = groupSimilar(open);
  const done = items.filter((i) => i.status !== "open");
  const queued = stm.filter((s) => s.status === "queued");
  const decided = stm.filter((s) => s.status !== "queued");
  const answeredCount = done.length + decided.length;

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle={
          open.length + queued.length === 0
            ? "You're all caught up. Your AI staff will ask here when they need a decision from you."
            : "Your AI staff need a decision from you on the items below. Nothing changes until you answer."
        }
      />
      <div className="space-y-6">
        <Card
          title={
            <span className="inline-flex items-center">
              Questions for you
              <Count n={groups.length} />
            </span>
          }
          pad={false}
        >
          {groups.length === 0 ? (
            <Empty compact title="No open questions" hint="When your AI staff hit something outside your rules, they ask you here." />
          ) : (
            <div className="divide-y divide-line">
              {groups.map((g) => (
                <QuestionCard key={String(g.item.id)} item={g.item} earlier={g.earlier} />
              ))}
            </div>
          )}
        </Card>

        {queued.length > 0 ? (
          <Card
            id="statements"
            title={
              <span className="inline-flex items-center">
                Phone instructions to confirm
                <Count n={queued.length} />
              </span>
            }
            pad={false}
          >
            <div className="divide-y divide-line">
              {queued.map((s) => (
                <StatementCard key={String(s.id)} s={s} />
              ))}
            </div>
          </Card>
        ) : (
          <div id="statements" className="px-1 text-[13px] text-faint">
            No phone instructions waiting. Anything you tell your assistant by phone shows up here for you to confirm.
          </div>
        )}

        {(answeredCount > 0 || snapshot.precedents.length > 0) && (
          <details className="group rounded-xl border border-line bg-surface">
            <summary className="flex cursor-pointer select-none items-center gap-2 px-5 py-3 text-[14px] font-semibold text-ink">
              <span className="text-faint transition-transform group-open:rotate-90">›</span>
              Answered
              <Count n={answeredCount} />
            </summary>
            <div className="divide-y divide-line border-t border-line">
              {done.map((i) => (
                <AnsweredRow key={`i${i.id}`} item={i} />
              ))}
              {decided.map((s) => (
                <StatementCard key={`s${s.id}`} s={s} />
              ))}
            </div>
            {snapshot.precedents.length > 0 && (
              <div className="border-t border-line px-5 py-4">
                <div className="mb-2 text-[13px] font-medium text-ink">Answers your staff remember</div>
                <ul className="space-y-1.5 text-[13.5px]">
                  {snapshot.precedents.map((p) => (
                    <li key={String(p.id)} className="flex gap-2">
                      <span className="shrink-0 text-muted">{roleLabel(p.agentRole)}:</span>
                      <span className="text-ink">{p.rule}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </details>
        )}
      </div>
    </>
  );
}
