"use client";

// "Ask your books": the owner asks the Bookkeeper a question in plain words. It answers from ledger_read and
// reconcile (read-only tools), citing documents as [doc N]; cited documents its tools actually returned become
// links, and any it named without reading are flagged rather than linked.

import Link from "next/link";
import { useState, type FormEvent, type ReactNode } from "react";
import { useData } from "@/data/context";
import { brain } from "@/lib/brain";
import { useDocMap } from "@/lib/hooks";
import { Button, ErrorNote, errText } from "./ui";

const SUGGESTIONS = ["How much did I make this week?", "Which item sells best?", "Do my books reconcile?"];

type Answer = { question: string; answer: string; refs: string[]; unverifiedRefs: string[] };

export function AskBooks({ businessId }: { businessId: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const [last, setLast] = useState<Answer>();

  async function ask(question: string) {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(undefined);
    try {
      const r = await brain.ask(businessId, q);
      setLast({ question: q, ...r });
      setText("");
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask(text);
  };

  return (
    <div>
      <form onSubmit={submit} className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          placeholder="e.g. what were my fees this month?"
          aria-label="Question for your bookkeeper"
          className="h-9 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-[14px] text-ink outline-none focus:border-accent"
        />
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {busy ? "Reading the books…" : "Ask"}
        </Button>
      </form>
      {!last && !busy && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SUGGESTIONS.map((s) => (
            <button key={s} type="button" onClick={() => void ask(s)} className="rounded-full border border-line px-2.5 py-1 text-[12px] text-muted hover:bg-surface-2">
              {s}
            </button>
          ))}
        </div>
      )}
      <ErrorNote error={err} />
      {last && (
        <div className="mt-3 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-[13.5px] leading-relaxed">
          <div className="mb-1 text-[12px] text-faint">You asked: {last.question}</div>
          <Answer text={last.answer} verified={new Set(last.refs)} />
          {last.unverifiedRefs.length > 0 && (
            <div className="mt-2 text-[12px] text-warn">
              It also named {last.unverifiedRefs.map((r) => `doc ${r}`).join(", ")} without reading {last.unverifiedRefs.length > 1 ? "them" : "it"}; check before relying on that part.
            </div>
          )}
          <div className="mt-2 text-[11.5px] text-faint">Read-only: the Bookkeeper can look at your ledger but can't change it.</div>
        </div>
      )}
    </div>
  );
}

/** The answer's light markdown: paragraphs, "- " bullet lists and **bold**. */
function Answer({ text, verified }: { text: string; verified: Set<string> }) {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const item = /^[-*•]\s+(.*)$/.exec(line);
    const prev = blocks.at(-1);
    if (item) {
      if (prev?.list) prev.lines.push(item[1]!);
      else blocks.push({ list: true, lines: [item[1]!] });
    } else if (prev && !prev.list && prev.lines.length) prev.lines.push(line);
    else blocks.push({ list: false, lines: [line] });
  }
  const inline = (t: string) =>
    t.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? <strong key={i}>{<WithDocLinks text={part} verified={verified} />}</strong> : <WithDocLinks key={i} text={part} verified={verified} />));
  return (
    <div className="space-y-2">
      {blocks
        .filter((b) => b.lines.length)
        .map((b, i) =>
          b.list ? (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {b.lines.map((l, j) => (
                <li key={j}>{inline(l)}</li>
              ))}
            </ul>
          ) : (
            <p key={i}>{inline(b.lines.join(" "))}</p>
          ),
        )}
    </div>
  );
}

/** Renders "[doc 12]" as a link to document 12 when the Bookkeeper's tools returned it, otherwise as plain text. */
function WithDocLinks({ text, verified }: { text: string; verified: Set<string> }) {
  const docs = useDocMap();
  const { names } = useData();
  const parts: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(/\[doc ([A-Za-z0-9_-]{1,64})\]/g)) {
    parts.push(text.slice(at, m.index));
    const id = m[1]!;
    const doc = /^\d+$/.test(id) ? docs.get(BigInt(id)) : undefined;
    parts.push(
      doc && verified.has(id) ? (
        <Link key={m.index} href={`/documents/${id}`} className="text-accent-ink hover:underline">
          {names.docType(doc.docType)} #{doc.number}
        </Link>
      ) : (
        <span key={m.index} className="text-faint">
          {m[0]}
        </span>
      ),
    );
    at = m.index + m[0].length;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
