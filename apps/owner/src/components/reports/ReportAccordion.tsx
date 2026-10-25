"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { cx } from "@/components/ui";

export interface ReportSection {
  id: string;
  title: string;
  description: ReactNode;
  /** Key number shown on the collapsed row, e.g. "$12.40 owed". */
  summary?: ReactNode;
  /** Controls (selects, CSV buttons) shown in a toolbar at the top of the open panel. */
  actions?: ReactNode;
  children: ReactNode;
}

/** Open sections live in the URL hash as a comma list (#tax,cash), so links like /reports#pnl open that report. */
function readHash(valid: Set<string>): Set<string> {
  if (typeof window === "undefined") return new Set();
  const raw = decodeURIComponent(window.location.hash.replace(/^#/, ""));
  return new Set(raw.split(",").map((s) => s.trim()).filter((s) => valid.has(s)));
}

export function useOpenSections(ids: readonly string[]) {
  const key = ids.join(",");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const valid = new Set(key.split(","));
    const sync = (scroll: boolean) => {
      const next = readHash(valid);
      setOpen(next);
      const first = [...next][0];
      if (!scroll || !first) return;
      // The page may still be loading data; retry briefly until the row exists.
      let tries = 0;
      const go = () => {
        const el = document.getElementById(first);
        if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
        else if (tries++ < 40) setTimeout(go, 100);
      };
      requestAnimationFrame(go);
    };
    sync(true);
    const onHash = () => sync(true);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [key]);
  const write = useCallback((next: Set<string>) => {
    setOpen(next);
    const order = key.split(",").filter((id) => next.has(id));
    const url = `${window.location.pathname}${window.location.search}${order.length ? `#${order.join(",")}` : ""}`;
    window.history.replaceState(window.history.state, "", url);
  }, [key]);
  const toggle = useCallback(
    (id: string) => {
      const next = new Set(open);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      write(next);
    },
    [open, write],
  );
  return { open, toggle, setAll: (on: boolean) => write(on ? new Set(key.split(",")) : new Set()) };
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden className={cx("shrink-0 text-faint transition-transform duration-150", open && "rotate-180")}>
      <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ReportAccordion({ sections, open, onToggle }: { sections: ReportSection[]; open: Set<string>; onToggle: (id: string) => void }) {
  return (
    <div className="rounded-lg border border-line bg-surface shadow-card">
      {sections.map((s, i) => {
        const isOpen = open.has(s.id);
        const last = i === sections.length - 1;
        return (
          <section key={s.id} id={s.id} className={cx("scroll-mt-4", !last && "border-b border-line")}>
            <h2>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={`${s.id}-panel`}
                onClick={() => onToggle(s.id)}
                className={cx(
                  "flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-line",
                  i === 0 && "rounded-t-lg",
                  last && !isOpen && "rounded-b-lg",
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-medium text-ink">{s.title}</span>
                  <span className="block truncate text-[12px] text-muted">{s.description}</span>
                  {s.summary != null && <span className="mt-0.5 block text-[12px] text-ink sm:hidden">{s.summary}</span>}
                </span>
                {s.summary != null && <span className="hidden shrink-0 text-right text-[12.5px] text-ink sm:block">{s.summary}</span>}
                <Chevron open={isOpen} />
              </button>
            </h2>
            {isOpen && (
              <div id={`${s.id}-panel`} role="region" aria-label={s.title} className="border-t border-line">
                {s.actions && <div className="flex flex-wrap items-center justify-end gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[12px]">{s.actions}</div>}
                {s.children}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
