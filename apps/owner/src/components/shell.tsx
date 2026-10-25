"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useData } from "@/data/context";
import { useAccount } from "@/data/account";
import { Badge, Button, cx, shortId } from "./ui";
import { booksCheck } from "@/lib/reports";
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
  docs: <path d="M6 2.5h6l3 3V17.5H6zM12 2.5v3h3M8.5 9.5h4M8.5 12.5h4" />,
  regs: <path d="M3 4h14v12H3zM3 8h14M8 8v8" />,
  expenses: <path d="M5 2.5h10v15l-2-1.3-1.7 1.3-1.3-1.3-1.3 1.3L7 16.2l-2 1.3zM7.5 6.5h5M7.5 9.5h5M7.5 12.5h3" />,
  reports: <path d="M4 16V9M8.5 16V5M13 16v-4M17 16H3" />,
  decisions: <path d="M10 3v4M10 13v4M5 10H3M17 10h-2M6 6l1.5 1.5M12.5 12.5 14 14M6 14l1.5-1.5M12.5 7.5 14 6" />,
  inbox: <path d="M3 11.5 5 4h10l2 7.5V16H3zM3 11.5h4l1 2h4l1-2h4" />,
  audit: <path d="M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6.5V10l2.5 1.5" />,
  proof: <path d="M10 2.5 16 5v5c0 3.5-2.6 6.4-6 7.5-3.4-1.1-6-4-6-7.5V5zM7.5 10l2 2 3.5-4" />,
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
      { href: "/inbox", label: "Inbox", icon: I.inbox, badge: (d) => d.snapshot.inbox.filter((i) => i.status === "open").length + d.snapshot.ownerStatements.filter((s) => s.status === "queued").length },
      { href: "/decisions", label: "Decisions", icon: I.decisions },
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
  { section: "Trust", items: [{ href: "/proof", label: "Proof report", icon: I.proof }] },
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
    <svg viewBox="0 0 20 20" className="size-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
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
      <aside className={cx("fixed inset-y-0 left-0 z-40 flex w-[228px] flex-col border-r border-line bg-surface transition-transform md:translate-x-0", open ? "translate-x-0" : "-translate-x-full")}>
        <div className="flex h-12 items-center gap-2 border-b border-line px-4">
          <div className="grid size-6 place-items-center rounded-md bg-ink text-[12px] font-bold text-canvas">N</div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">{data.snapshot.business?.name ?? data.config?.config?.business.name ?? data.snapshot.businessId}</div>
            <div className="text-[11px] text-faint">Napkin back office</div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV.map((g) => (
            <div key={g.section} className="mb-3">
              {g.section && <div className="px-2 pb-1 text-[11px] font-medium text-faint">{g.section}</div>}
              {g.items.map((it) => {
                const active = it.href === "/" ? pathname === "/" : pathname.startsWith(it.href);
                const n = it.badge?.(data) ?? 0;
                return (
                  <Link
                    key={it.href}
                    href={it.href}
                    className={cx(
                      "flex h-8 items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors",
                      active ? "bg-surface-2 font-medium text-ink" : "text-muted hover:bg-surface-2 hover:text-ink",
                      it.m2 && !active && "opacity-60",
                    )}
                  >
                    <Icon>{it.icon}</Icon>
                    <span className="flex-1 truncate">{it.label}</span>
                    {n > 0 && <span className="num rounded bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-ink">{n}</span>}
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
      <div className="flex min-w-0 flex-1 flex-col md:pl-[228px]">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-line bg-canvas/85 px-4 backdrop-blur md:px-6">
          <button className="-ml-1 rounded p-1 text-muted hover:bg-surface-2 md:hidden" onClick={() => setOpen(true)} aria-label="Open navigation">
            <svg viewBox="0 0 20 20" className="size-5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
              <path d="M3 6h14M3 10h14M3 14h14" />
            </svg>
          </button>
          <ConnectionPill />
          <Link href="/" className={cx("hidden items-center gap-1.5 text-[12px] sm:flex", books.balanced ? "text-pos" : "font-semibold text-neg")} title="Sum of all journal-line debits vs credits">
            <span className={cx("size-1.5 rounded-full", books.balanced ? "bg-pos" : "bg-neg")} />
            {books.balanced ? "Books balanced" : "BOOKS OUT OF BALANCE"}
          </Link>
          <div className="flex-1" />
          <SignInChip />
        </header>
        <Banners />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-4 py-5 md:px-6">{children}</main>
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
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted" title={`${session.uri} · database ${session.dbName}`}>
      <span className={cx("size-1.5 rounded-full", dot)} />
      {label}
    </span>
  );
}

function SignInChip() {
  const { isOwner, session, preview } = useData();
  if (isOwner)
    return (
      <span className="inline-flex items-center gap-2">
        <Badge tone="pos">Owner</Badge>
        {preview && (
          <button className="text-[12px] text-faint hover:text-ink" onClick={preview.signOut}>
            Sign out
          </button>
        )}
      </span>
    );
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
  const { session } = useData();
  const { account, signOut } = useAccount();
  const [theme, setTheme] = useState<"system" | "light" | "dark">("system");
  useEffect(() => {
    const t = safeGet("local", "napkin-owner:theme");
    if (t === "light" || t === "dark") setTheme(t);
  }, []);
  const cycle = () => {
    const next = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    setTheme(next);
    safeSet("local", "napkin-owner:theme", next === "system" ? null : next);
    if (next === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = next;
  };
  return (
    <div className="space-y-2 border-t border-line p-3 text-[12px]">
      {account && (
        <div className="flex items-center justify-between gap-2">
          <span className="min-w-0 truncate text-muted" title={account.email}>{account.email}</span>
          <button onClick={() => void signOut()} className="shrink-0 rounded px-1.5 py-0.5 text-faint hover:bg-surface-2 hover:text-ink">
            Sign out
          </button>
        </div>
      )}
      <div className="flex items-center justify-between text-faint">
        <span title={session.identityHex}>id {shortId(session.identityHex)}</span>
        <button onClick={cycle} className="rounded px-1.5 py-0.5 hover:bg-surface-2 hover:text-ink" title="Theme">
          {theme === "system" ? "Auto" : theme === "dark" ? "Dark" : "Light"}
        </button>
      </div>
    </div>
  );
}
