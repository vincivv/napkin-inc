"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useData } from "@/data/context";
import { useAccount } from "@/data/account";
import { Badge, Button, cx } from "./ui";
import { booksCheck } from "@/lib/reports";
import { stockAlerts } from "@/lib/stock";
import { safeGet, safeSet } from "@/data/env";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  badge?: (d: ReturnType<typeof useData>) => number;
  m2?: boolean;
}

const I = {
  dash: <path d="M3 3h6v8H3zM11 3h6v5h-6zM11 10h6v7h-6zM3 13h6v4H3z" />,
  orders: <path d="M4 5h12M4 10h12M4 15h8" />,
  stock: <path d="M10 2.5 17 6v8l-7 3.5L3 14V6zM3 6l7 3.5L17 6M10 9.5v8" />,
  rules: <path d="M3 3h7l7 7-7 7-7-7zM6.5 6.5h.01" />,
  docs: <path d="M6 2.5h6l3 3V17.5H6zM12 2.5v3h3M8.5 9.5h4M8.5 12.5h4" />,
  regs: <path d="M3 4h14v12H3zM3 8h14M8 8v8" />,
  expenses: <path d="M5 2.5h10v15l-2-1.3-1.7 1.3-1.3-1.3-1.3 1.3L7 16.2l-2 1.3zM7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" />,
  reports: <path d="M4 16V9M8.5 16V5M13 16v-4M17 16H3" />,
  inbox: <path d="M3 11.5 5 4h10l2 7.5V16H3zM3 11.5h4l1 2h4l1-2h4" />,
  audit: <path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6.5V10l2.5 1.5" />,
  intake: <path d="M4 6h3l1.5-2h3L13 6h3v10H4zM10 8.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z" />,
  interview: <path d="M4 4h12v9H9l-3 3v-3H4z" />,
  build: <path d="M11 3 4 11h5l-1 6 7-8h-5z" />,
  store: <path d="M3.5 8 5 3.5h10L16.5 8M3.5 8v8.5h13V8M3.5 8c0 1.4 1 2.5 2.2 2.5S8 9.4 8 8c0 1.4 1 2.5 2 2.5s2-1.1 2-2.5c0 1.4 1 2.5 2.3 2.5s2.2-1.1 2.2-2.5M8 16.5v-4h4v4" />,
};

const NAV: { section: string; items: NavItem[] }[] = [
  { section: "", items: [{ href: "/", label: "Dashboard", icon: I.dash }] },
  {
    section: "Operations",
    items: [
      { href: "/storefront", label: "Storefront", icon: I.store },
      { href: "/orders", label: "Orders", icon: I.orders, badge: (d) => d.snapshot.orders.filter((o) => o.status === "paid").length },
      { href: "/stock", label: "Stock", icon: I.stock, badge: (d) => stockAlerts(d.snapshot.registerBalances, d.config?.config) },
      { href: "/rules", label: "Prices & rules", icon: I.rules },
      { href: "/inbox", label: "Inbox", icon: I.inbox, badge: (d) => d.snapshot.inbox.filter((i) => i.status === "open").length + d.snapshot.ownerStatements.filter((s) => s.status === "queued").length },
    ],
  },
  {
    section: "Books",
    items: [
      { href: "/documents", label: "Documents", icon: I.docs, badge: (d) => d.snapshot.documents.filter((x) => x.status === "draft").length },
      { href: "/expenses", label: "Expenses", icon: I.expenses },
      { href: "/registers", label: "Registers", icon: I.regs },
      { href: "/reports", label: "Reports", icon: I.reports },
      { href: "/audit", label: "Audit log", icon: I.audit },
    ],
  },
  {
    section: "Set up",
    items: [
      { href: "/intake", label: "Intake", icon: I.intake },
      { href: "/interview", label: "Interview", icon: I.interview },
      { href: "/build", label: "Build", icon: I.build },
    ],
  },
];

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" className="size-[18px] shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {children}
    </svg>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const data = useData();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const books = booksCheck(data.snapshot.journalLines);

  return (
    <div className="flex min-h-dvh bg-canvas">
      {/* sidebar */}
      <aside className={cx("fixed inset-y-0 left-0 z-40 flex w-[248px] flex-col border-r border-line bg-surface transition-transform md:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <div className="grid size-7 place-items-center rounded-md bg-ink text-[13px] font-bold text-canvas">N</div>
          <div className="min-w-0 truncate text-[15px] font-semibold tracking-tight">{data.snapshot.business?.name ?? data.config?.config?.business.name ?? data.snapshot.businessId}</div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {NAV.map((g) => (
            <div key={g.section} className="mb-5">
              {g.section && <div className="px-2.5 pb-1.5 text-[12.5px] font-medium text-faint">{g.section}</div>}
              {g.items.map((it) => {
                const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
                const n = it.badge?.(data) ?? 0;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={cx(
                      "flex h-9 items-center gap-3 rounded-md px-2.5 text-[15px] transition-colors",
                      active ? "bg-surface-2 font-medium text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
                      it.m2 && !active && "opacity-60",
                    )}
                  >
                    <Icon>{it.icon}</Icon>
                    <span className="flex-1 truncate">{it.label}</span>
                    {n > 0 && <span className="num rounded-full bg-surface-2 px-2 text-[12px] font-medium text-ink ring-1 ring-line">{n}</span>}
                    {it.m2 && <span className="text-[10px] text-faint">M2</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
        <SidebarFooter />
      </aside>
      {open && <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setOpen(false)} />}

      {/* main */}
      <div className="flex min-w-0 flex-1 flex-col md:pl-[248px]">
        <header className="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-line bg-canvas/85 px-4 backdrop-blur md:px-8">
          <button className="-ml-1 rounded p-1 text-muted hover:bg-surface-2 md:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M3 6h14M3 10h14M3 14h14" />
            </svg>
          </button>
          <ConnectionPill />
          <Link href="/" className={cx("hidden items-center gap-1.5 text-[13px] sm:flex", books.balanced ? "text-pos" : "font-semibold text-neg")} title="Sum of all journal-line debits vs credits">
            <span className={cx("size-1.5 rounded-full", books.balanced ? "bg-pos" : "bg-neg")} />
            {books.balanced ? "Books balanced" : "BOOKS OUT OF BALANCE"}
          </Link>
          <div className="flex-1" />
          <SignInChip />
          <ThemeSwitch />
        </header>
        <Banners />
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 py-8 md:px-10">{children}</main>
      </div>
    </div>
  );
}

function ConnectionPill() {
  const { session } = useData();
  if (session.mode === "preview") return <Badge tone="warn">Preview · fake data</Badge>;
  const m: Record<string, [string, string]> = {
    connected: ["bg-pos", session.ready ? "Live" : "Syncing…"],
    connecting: ["bg-warn animate-pulse", "Connecting…"],
    disconnected: ["bg-warn animate-pulse", "Reconnecting…"],
    error: ["bg-neg", "Offline"],
  };
  const [dot, label] = m[session.status] ?? ["bg-faint", session.status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-muted" title={`${session.uri} · database ${session.dbName}`}>
      <span className={cx("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function SignInChip() {
  const { isOwner, session, preview } = useData();
  if (isOwner)
    return preview ? (
      <button className="text-[13px] text-faint hover:text-ink" onClick={preview.signOut}>
        Sign out
      </button>
    ) : null;
  return <span className="text-[12px] text-faint">{session.role ? `Signed in as ${session.role}` : session.ready ? "Unlocking owner access…" : ""}</span>;
}

function Banners() {
  const { session, preview } = useData();
  return (
    <>
      {preview && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-warn/25 bg-warn-soft px-4 py-2 text-[12.5px] text-warn md:px-6">
          <span className="font-semibold">Preview mode</span>
          <span className="min-w-0 flex-1">Invented customers, orders and fees, posted through the real ledger engine with the Maya fixture. Nothing is sent to SpacetimeDB.</span>
          <Button size="sm" variant="secondary" onClick={preview.simulateSale}>
            Simulate a sale
          </Button>
          <Button size="sm" variant="ghost" onClick={preview.exit}>
            Exit preview
          </Button>
        </div>
      )}
      {session.mode === "live" && session.status !== "connected" && (
        <div className={cx("border-b px-4 py-2 text-[12.5px] md:px-6", session.status === "error" ? "border-neg/25 bg-neg-soft text-neg" : "border-line bg-surface-2 text-muted")}>
          {session.status === "error" ? (
            <>
              Can’t reach SpacetimeDB at <code className="font-mono">{session.uri}</code> (database <code className="font-mono">{session.dbName}</code>). {session.error ?? ""} It retries on its own;{" "}
              <button className="underline" onClick={() => window.location.reload()}>
                reload
              </button>{" "}
              to try now.
            </>
          ) : (
            <>
              Connecting to <code className="font-mono">{session.uri}</code> · database <code className="font-mono">{session.dbName}</code>…
            </>
          )}
        </div>
      )}
    </>
  );
}

function SidebarFooter() {
  const { account, signOut } = useAccount();
  if (!account) return null;
  return (
    <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3 text-[13px]">
      <span className="min-w-0 truncate text-muted" title={account.email}>
        {account.email}
      </span>
      <button onClick={() => void signOut()} className="shrink-0 rounded px-2 py-1 text-faint hover:bg-surface-2 hover:text-ink">
        Sign out
      </button>
    </div>
  );
}

/** Light/dark slider (sun ↔ moon). Starts from the saved choice, else the system setting. */
function ThemeSwitch() {
  const [dark, setDark] = useState<boolean>();
  useEffect(() => {
    const t = safeGet("local", "napkin-owner:theme");
    setDark(t === "dark" || (t !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches));
  }, []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    safeSet("local", "napkin-owner:theme", next ? "dark" : "light");
    document.documentElement.dataset.theme = next ? "dark" : "light";
  };
  const icon = "size-3.5";
  return (
    <button
      role="switch"
      aria-checked={!!dark}
      aria-label="Dark mode"
      title={dark ? "Switch to light" : "Switch to dark"}
      onClick={toggle}
      className="relative inline-flex h-8 w-[60px] shrink-0 items-center justify-between rounded-full border border-line bg-surface-2 px-2 text-faint transition-colors hover:border-line-strong"
    >
      <svg viewBox="0 0 20 20" className={icon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
        <circle cx="10" cy="10" r="3.2" />
        <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
      </svg>
      <svg viewBox="0 0 20 20" className={icon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z" />
      </svg>
      <span
        className={cx(
          "absolute top-[3px] grid size-6 place-items-center rounded-full bg-surface text-ink shadow-sm ring-1 ring-line transition-transform duration-200",
          dark === undefined && "opacity-0",
          dark ? "translate-x-[27px]" : "translate-x-[-5px]",
        )}
        style={{ left: 6 }}
      >
        {dark ? (
          <svg viewBox="0 0 20 20" className={icon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 12.2A6.5 6.5 0 0 1 7.8 4a6.5 6.5 0 1 0 8.2 8.2z" />
          </svg>
        ) : (
          <svg viewBox="0 0 20 20" className={icon} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden>
            <circle cx="10" cy="10" r="3.2" />
            <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M4.7 15.3 6 14M14 6l1.3-1.3" />
          </svg>
        )}
      </span>
    </button>
  );
}
