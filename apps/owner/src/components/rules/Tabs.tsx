"use client";

import type { ReactNode } from "react";
import { cx } from "@/components/ui";

/** Understated underline tabs (Vercel style). */
export function Tabs<K extends string>({ value, onChange, tabs }: { value: K; onChange(k: K): void; tabs: { key: K; label: ReactNode; count?: number }[] }) {
  return (
    <div role="tablist" className="mb-6 flex gap-6 border-b border-line">
      {tabs.map((t) => {
        const on = t.key === value;
        return (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={on}
            onClick={() => onChange(t.key)}
            className={cx(
              "-mb-px flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-2.5 pt-1 text-[13.5px] transition-colors",
              on ? "border-ink font-medium text-ink" : "border-transparent text-muted hover:text-ink",
            )}
          >
            {t.label}
            {t.count !== undefined && <span className={cx("num text-[12px]", on ? "text-muted" : "text-faint")}>{t.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
