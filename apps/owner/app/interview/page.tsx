"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useData } from "@/data/context";
import { Badge, Button, Card, Empty, ErrorNote, errText, Loading, PageHeader, cx } from "@/components/ui";
import { Confidence, ProvenanceBadge } from "@/components/facts";
import { brain, BrainError, type NextResponse, type PendingStatement, type ReviewResponse, type SpecResponse } from "@/lib/brain";

export default function InterviewPage() {
  const { snapshot } = useData();
  const businessId = snapshot.businessId;
  const [spec, setSpec] = useState<SpecResponse | undefined>();
  const [next, setNext] = useState<NextResponse | undefined>();
  const [review, setReview] = useState<ReviewResponse | undefined>();
  const [statements, setStatements] = useState<PendingStatement[]>([]);
  const [loading, setLoading] = useState(true);
  const [noSpec, setNoSpec] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [answer, setAnswer] = useState("");
  const [said, setSaid] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [s, n, st, rv] = await Promise.all([brain.spec(businessId), brain.next(businessId), brain.statements(businessId), brain.review(businessId).catch(() => undefined)]);
      setSpec(s);
      setNext(n);
      setReview(rv);
      setStatements(st.statements);
      setNoSpec(false);
    } catch (e) {
      if (e instanceof BrainError && e.status === 404) setNoSpec(true);
      else setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [businessId]);
  useEffect(() => void refresh(), [refresh]);
  // phone statements are confirmed in the Inbox; poll so the result shows up here
  useEffect(() => {
    if (!statements.some((s) => s.channel === "phone" && s.status === "pending")) return;
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [statements, refresh]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      setAnswer("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  if (noSpec)
    return (
      <>
        <PageHeader title="Interview" />
        <Card><Empty title="Nothing to ask about yet" hint={<>Start with <Link href="/intake" className="text-accent underline">Intake</Link>: a photo or a few words about your business.</>} /></Card>
      </>
    );

  const q = next?.question;
  const pendingApp = statements.filter((s) => s.status === "pending");
  const money = (spec?.facts ?? []).filter((f) => f.moneyRelevant);
  const blocked = new Set(spec?.blockers.map((b) => b.path));
  const doneCount = money.filter((f) => !blocked.has(f.path)).length;

  return (
    <>
      <PageHeader title="Interview" subtitle="One question at a time, the most important first. Nothing I guessed is used for money until you confirm it." />
      <ErrorNote error={error} />
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {review && review.items.length > 1 && <ReviewCard review={review} busy={busy} onConfirm={(ids) => act(() => brain.confirmMany(businessId, ids))} />}
          <Card title={q ? `Question · ${next!.remaining} left` : "Question"}>
            {!q ? (
              <Empty compact title="No open questions" hint={next?.moneyReady ? "Everything that touches money is confirmed." : "Nothing left to ask."} />
            ) : (
              <div key={q.id}>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  <Badge tone={q.moneyRelevant ? "accent" : "neutral"}>{q.moneyRelevant ? "affects money" : "nice to know"}</Badge>
                  <Badge title="moneyImpact × (1 − confidence)">impact {q.impactScore.toFixed(2)}</Badge>
                </div>
                <p className="text-[16px] font-medium leading-snug text-ink">{q.phrased}</p>
                {q.phrased !== q.question && <p className="mt-1 text-[11.5px] text-faint">Plain version: {q.question}</p>}
                {q.current && !q.candidates && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-[12.5px]">
                    <span className="text-muted">What I have:</span>
                    <b className="text-ink">{q.current.display || "nothing"}</b>
                    {q.current.confidence > 0 && <span className="text-muted">·</span>}
                    {q.current.confidence > 0 && <ProvenanceBadge f={{ path: q.fieldPath, label: "", display: q.current.display, missing: false, moneyRelevant: true, moneyImpact: 1, fact: { value: q.current.display, ...q.current } }} />}
                    {q.current.confidence > 0 && <Confidence f={{ path: "", label: "", display: "", missing: false, moneyRelevant: true, moneyImpact: 1, fact: { value: "", ...q.current } }} />}
                    {q.current.source.quote && q.current.confidence > 0 && <span className="italic text-faint">“{q.current.source.quote}”</span>}
                  </div>
                )}
                {q.candidates && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {q.candidates.map((c) => <Button key={c} disabled={busy} onClick={() => act(() => brain.answer(businessId, q.id, { answer: c }))}>{c}</Button>)}
                  </div>
                )}
                <form
                  className="mt-3 flex flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (answer.trim()) void act(() => brain.answer(businessId, q.id, { answer: answer.trim() }));
                  }}
                >
                  <input autoFocus value={answer} onChange={(e) => setAnswer(e.target.value)} placeholder="Type your answer" className="h-9 min-w-[200px] flex-1 rounded-md border border-line-strong bg-surface px-3 text-[14px] text-ink outline-none focus:border-accent" />
                  <Button type="submit" variant="primary" disabled={busy || !answer.trim()}>Save answer</Button>
                  {q.current && q.current.confidence > 0 && !q.candidates && <Button disabled={busy} onClick={() => act(() => brain.answer(businessId, q.id, { confirm: true }))}>Yes, that&apos;s right</Button>}
                  {!q.moneyRelevant && <Button variant="ghost" disabled={busy} onClick={() => act(() => brain.dismiss(businessId, q.id))}>Skip</Button>}
                </form>
              </div>
            )}
          </Card>

          <Card title="Something changed? Tell me">
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (said.trim()) void act(async () => { await brain.statement(businessId, said.trim(), "app"); setSaid(""); });
              }}
            >
              <input value={said} onChange={(e) => setSaid(e.target.value)} placeholder='e.g. "no discounts this week"' className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink outline-none focus:border-accent" />
              <Button type="submit" disabled={busy || !said.trim()}>Propose change</Button>
            </form>
            <p className="mt-1.5 text-[11.5px] text-faint">I will show you exactly what would change. Nothing is applied until you confirm.</p>
            <div className="mt-3 space-y-3">
              {pendingApp.map((s) => <StatementCard key={s.id} s={s} busy={busy} onDecide={(c) => act(() => brain.decide(businessId, s.id, c))} />)}
              {statements.filter((s) => s.status !== "pending").slice(0, 4).map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2 border-t border-line pt-2 text-[12px] text-muted">
                  <span className="truncate">“{s.text}”</span>
                  <Badge tone={s.status === "applied" ? "pos" : "neutral"}>{s.status}</Badge>
                </div>
              ))}
            </div>
          </Card>
        </div>

        <Card
          title="Money-ready checklist"
          pad={false}
          actions={<Badge tone={spec?.moneyReady ? "pos" : "warn"}>{spec?.moneyReady ? "money-ready" : `${doneCount}/${money.length} confirmed`}</Badge>}
        >
          {spec?.moneyReady && <div className="border-b border-line bg-pos-soft px-4 py-2.5 text-[12.5px] text-pos">Every fact that touches money is confirmed by you. The build can go ahead.</div>}
          <ul className="divide-y divide-line">
            {money.map((f) => {
              const ok = !blocked.has(f.path);
              return (
                <li key={f.path} className="flex items-center gap-3 px-4 py-2">
                  <span className={cx("grid size-4 shrink-0 place-items-center rounded-full text-[10px] text-white", ok ? "bg-pos" : "bg-line-strong")}>{ok ? "✓" : ""}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12.5px] text-ink">{f.label}</div>
                    <div className="truncate text-[11.5px] text-faint">{f.missing ? "not known yet" : f.display}</div>
                  </div>
                  {!ok && <ProvenanceBadge f={f} />}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}

function StatementCard({ s, busy, onDecide }: { s: PendingStatement; busy: boolean; onDecide(confirm: boolean): void }) {
  return (
    <div className="rounded-md border border-line-strong p-3">
      <div className="text-[12.5px] text-muted">You said: “{s.text}” <Badge>{s.channel}</Badge></div>
      {s.diff.changes.length === 0 ? <p className="mt-2 text-[12.5px] text-muted">I could not map that to anything I can change.</p> : (
        <ul className="mt-2 space-y-1">
          {s.diff.changes.map((c) => (
            <li key={c.path} className="text-[13px]">
              <span className="text-muted">{c.label}:</span> <s className="text-faint">{c.beforeText}</s> → <b className="text-ink">{c.afterText}</b>
            </li>
          ))}
        </ul>
      )}
      {s.diff.unparsed.length > 0 && <p className="mt-1 text-[12px] text-warn">Not understood: {s.diff.unparsed.join("; ")}</p>}
      {s.diff.note && <p className="mt-1 text-[12px] text-muted">Note: {s.diff.note}</p>}
      {s.channel === "app" ? (
        <div className="mt-2 flex gap-2">
          <Button variant="primary" size="sm" disabled={busy || s.diff.changes.length === 0} onClick={() => onDecide(true)}>Confirm change</Button>
          <Button size="sm" disabled={busy} onClick={() => onDecide(false)}>Reject</Button>
        </div>
      ) : (
        <p className="mt-2 text-[12px] text-muted">Given by phone: confirm it in the <Link href="/inbox#statements" className="text-accent underline">Inbox</Link>.</p>
      )}
    </div>
  );
}

/**
 * The review list: values the owner typed or that were read from the paper, shown with their quote. The
 * owner ticks the ones that are right and confirms them in one step. Guesses never appear here.
 */
function ReviewCard({ review, busy, onConfirm }: { review: ReviewResponse; busy: boolean; onConfirm: (ids: string[]) => void }) {
  const [off, setOff] = useState<Set<string>>(new Set());
  const picked = review.items.filter((i) => !off.has(i.id));
  const toggle = (id: string) => setOff((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  return (
    <Card title={`Check what I have · ${review.items.length}`}>
      <p className="mb-2 text-[12.5px] text-muted">These came from your own words or your napkin. Untick anything that&apos;s wrong (I&apos;ll ask about it), then confirm the rest in one go.</p>
      <ul className="max-h-[340px] divide-y divide-line overflow-y-auto rounded-md border border-line">
        {review.items.map((i) => (
          <li key={i.id}>
            <label className="flex cursor-pointer items-start gap-2.5 px-3 py-2 hover:bg-surface-2">
              <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={!off.has(i.id)} onChange={() => toggle(i.id)} />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-[13px] text-muted">{i.label}</span>
                  <b className="text-[13px] text-ink">{i.display}</b>
                  {i.moneyRelevant && <Badge tone="accent">money</Badge>}
                </span>
                {i.quote && <span className="block truncate text-[11.5px] italic text-faint">{i.provenance === "paper" ? "on the napkin" : "you said"}: “{i.quote}”</span>}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11.5px] text-faint">{review.needAnswers > 0 ? `${review.needAnswers} more need a typed answer below.` : "Nothing else to answer after this."}</span>
        <Button variant="primary" disabled={busy || picked.length === 0} onClick={() => onConfirm(picked.map((i) => i.id))}>
          Confirm {picked.length} {picked.length === 1 ? "fact" : "facts"}
        </Button>
      </div>
    </Card>
  );
}
