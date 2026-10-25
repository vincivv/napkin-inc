"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useData } from "@/data/context";
import type { InboxItemRow } from "@/data/types";
import { ErrorNote, OwnerButton, RelTime, cx, errText } from "@/components/ui";
import { docLabel, refHref, useDocMap } from "@/lib/hooks";
import { isBooksReview, parseQuestion, roleLabel, roleShort } from "@/lib/inbox";
import { RichText } from "./RichText";

function RelatedLink({ docRef }: { docRef: string }) {
  const docs = useDocMap();
  const { names } = useData();
  const ref = refHref(docRef);
  if (!ref) return null;
  const m = /^\/documents\/(\d+)$/.exec(ref.href);
  const d = m ? docs.get(BigInt(m[1]!)) : undefined;
  return (
    <Link href={ref.href} className="text-[13px] text-accent-ink hover:underline">
      Open {d ? docLabel(d, names) : ref.label} →
    </Link>
  );
}

/** The question itself: headline, then one issue per row. */
export function QuestionBody({ question, compact }: { question: string; compact?: boolean }) {
  const q = parseQuestion(question);
  return (
    <div>
      <div className={cx("font-semibold text-ink", compact ? "text-[14px]" : "text-[15.5px] leading-snug")}>
        <RichText text={q.headline} />
      </div>
      {q.body && (
        <p className="mt-1.5 text-[14px] leading-relaxed text-muted">
          <RichText text={q.body} />
        </p>
      )}
      {q.points.length > 0 && (
        <ol className={cx("divide-y divide-line overflow-hidden rounded-lg border border-line", compact ? "mt-2" : "mt-3")}>
          {q.points.map((p, i) => (
            <li key={i} className="flex gap-3 bg-surface px-3.5 py-2.5 text-[14px] leading-relaxed">
              <span className="num mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[12px] font-medium text-muted">{i + 1}</span>
              <span className="min-w-0 text-ink">
                <RichText text={p} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

const QUICK = [
  { label: "Looks right", text: "These look right to me. No changes needed." },
  { label: "This is a mistake, I'll fix it", text: "This is a mistake. I'll fix it myself, please don't change anything yet." },
];

/** One open question (plus any earlier copies of the same question) with the answer box. */
export function QuestionCard({ item, earlier = [] }: { item: InboxItemRow; earlier?: InboxItemRow[] }) {
  const { actions, isOwner } = useData();
  const [answer, setAnswer] = useState("");
  const [precedent, setPrecedent] = useState(false);
  const [rule, setRule] = useState("");
  const [alsoEarlier, setAlsoEarlier] = useState(true);
  // The reply box stays folded until the owner picks a quick answer or chooses to write one.
  const [composing, setComposing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const box = useRef<HTMLTextAreaElement>(null);
  const parsedQ = parseQuestion(item.question);
  const isList = parsedQ.points.length > 0;
  const who = roleShort(item.fromRole);
  const review = isBooksReview(item.fromRole, item.question, item.contextJson);
  const n = earlier.length;
  const earlierWords = review ? `${n} earlier ${n === 1 ? "review" : "reviews"}` : `${n} earlier ${n === 1 ? "copy" : "copies"}`;

  useEffect(() => {
    if (composing) box.current?.focus();
  }, [composing]);

  const send = async () => {
    const a = answer.trim();
    if (!a) return;
    setBusy(true);
    setErr(undefined);
    try {
      await actions.answerInbox(item.id, a, precedent, precedent ? rule.trim() || a : "", "{}");
      if (alsoEarlier) for (const e of earlier) await actions.answerInbox(e.id, a, false, "", "{}");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="px-5 py-5">
      <div className="mb-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
        <span className="size-1.5 rounded-full bg-warn" aria-hidden />
        <span className="font-medium text-ink">{roleLabel(item.fromRole)}</span>
        <span className="text-faint">asked</span>
        <span className="text-faint">
          <RelTime ts={item.createdAt} />
        </span>
        {n > 0 && <span className="rounded-full bg-surface-2 px-2 py-px text-[12px] text-muted">{review ? `latest of ${n + 1} reviews` : `asked ${n + 1} times`}</span>}
      </div>

      <QuestionBody question={item.question} />

      {item.documentRef && (
        <div className="mt-2">
          <RelatedLink docRef={item.documentRef} />
        </div>
      )}

      {earlier.length > 0 && (
        <details className="mt-3 text-[13px]">
          <summary className="cursor-pointer select-none text-muted hover:text-ink">Show the {earlierWords}</summary>
          <div className="mt-2 space-y-3 border-l-2 border-line pl-3">
            {earlier.map((e) => (
              <div key={String(e.id)}>
                <div className="mb-1 text-[12px] text-faint">
                  <RelTime ts={e.createdAt} />
                </div>
                <QuestionBody question={e.question} compact />
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="mt-4 rounded-lg bg-surface-2 px-4 py-3">
        <div className="text-[13px] font-medium text-ink">What we need from you</div>
        <div className="mt-0.5 text-[13.5px] text-muted">{parsedQ.todo ? parsedQ.todo.charAt(0).toUpperCase() + parsedQ.todo.slice(1) : (isList ? `Reply to confirm these are fine, or tell ${who} what's wrong.` : `Reply with your decision and ${who} will act on it.`)}</div>

        <div className="mt-3 flex flex-wrap gap-2">
          {isList && QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              disabled={!isOwner || busy}
              onClick={() => {
                setAnswer(q.text);
                setComposing(true);
              }}
              className={cx("rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:opacity-45", answer === q.text && "border-ink")}
            >
              {q.label}
            </button>
          ))}
          {!composing && (
            <button
              type="button"
              disabled={!isOwner || busy}
              onClick={() => setComposing(true)}
              className={cx("rounded-full px-3 py-1 text-[13px] transition-colors disabled:cursor-not-allowed disabled:opacity-45", isList ? "text-muted hover:text-ink" : "border border-line bg-surface text-ink hover:border-line-strong")}
            >
              {isList ? "Write my own answer" : "Write your answer"}
            </button>
          )}
        </div>

        {composing && (
          <>
            <textarea
              ref={box}
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              rows={3}
              placeholder={`Write your answer to ${who}…`}
              disabled={!isOwner}
              className="mt-3 w-full rounded-md border border-line bg-surface px-3 py-2 text-[14px] text-ink placeholder:text-faint disabled:opacity-50"
            />

            <label className="mt-2 flex items-center gap-2 text-[13px] text-muted">
              <input type="checkbox" checked={precedent} onChange={(e) => setPrecedent(e.target.checked)} disabled={!isOwner} />
              Remember this answer for next time
            </label>
            {precedent && (
              <input
                value={rule}
                onChange={(e) => setRule(e.target.value)}
                placeholder="The rule in one sentence (leave empty to use your answer)"
                className="mt-2 h-9 w-full rounded-md border border-line bg-surface px-3 text-[13.5px] placeholder:text-faint"
              />
            )}
            {earlier.length > 0 && (
              <label className="mt-2 flex items-center gap-2 text-[13px] text-muted">
                <input type="checkbox" checked={alsoEarlier} onChange={(e) => setAlsoEarlier(e.target.checked)} disabled={!isOwner} />
                Also close the {earlierWords} with this answer
              </label>
            )}

            <div className="mt-3 flex items-center gap-2">
              <OwnerButton variant="primary" disabled={busy || !answer.trim()} onClick={send}>
                {busy ? "Sending…" : "Send answer"}
              </OwnerButton>
            </div>
          </>
        )}
        <ErrorNote error={err} />
      </div>
    </article>
  );
}

/** A closed question in the Answered list: what was asked, what you said. */
export function AnsweredRow({ item }: { item: InboxItemRow }) {
  return (
    <div className="px-5 py-4">
      <div className="mb-1.5 flex flex-wrap items-center gap-2 text-[12.5px] text-faint">
        <span className="font-medium text-muted">{roleLabel(item.fromRole)}</span>
        <RelTime ts={item.createdAt} />
      </div>
      <QuestionBody question={item.question} compact />
      {item.documentRef && (
        <div className="mt-1.5">
          <RelatedLink docRef={item.documentRef} />
        </div>
      )}
      <div className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-[13.5px]">
        <span className="text-faint">You answered: </span>
        <span className="text-ink">{item.answer || "—"}</span>
      </div>
    </div>
  );
}
