"use client";

import Link from "next/link";
import { useCallback } from "react";
import { useData } from "@/data/context";
import { docLabel, useDocMap } from "@/lib/hooks";
import { humanize, splitDocRefs } from "@/lib/inbox";

/** Account code -> name from the active chart of accounts; undefined for codes it does not have. */
export function useAccountName(): (code: string) => string | undefined {
  const { names } = useData();
  return useCallback((code: string) => (names.accountType(code) ? names.account(code) : undefined), [names]);
}

/** Agent text with plain-word account names and [doc N] turned into links named after the document. */
export function RichText({ text }: { text: string }) {
  const docs = useDocMap();
  const { names } = useData();
  const accountName = useAccountName();
  const parts = splitDocRefs(humanize(text, accountName));
  return (
    <>
      {parts.map((p, i) => {
        if ("text" in p) return <span key={i}>{p.text}</span>;
        const d = docs.get(BigInt(p.doc));
        return (
          <Link key={i} href={`/documents/${p.doc}`} className="font-medium text-accent-ink underline decoration-line underline-offset-2 hover:decoration-current">
            {d ? docLabel(d, names) : `document ${p.doc}`}
          </Link>
        );
      })}
    </>
  );
}
