"use client";
// "Ask the shop": customer chat with the AI Shopkeeper (menu, quotes, orders) and Support (order status,
// refunds). The assistant talks; every action it takes goes through the brain's guards and the platform,
// and the guard's verdict is shown under the reply. Nothing here can change a price or a policy.

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { sendChat, type ChatToolCall, type StaffRole } from "@/lib/brain";
import type { Product } from "@/lib/model";
import { useStore } from "@/lib/store-data";

type Msg = { from: "you" | "shop"; text: string; calls?: ChatToolCall[]; error?: boolean };

const ROLES: { role: StaffRole; label: string; hello: string; suggestions: string[] }[] = [
  {
    role: "shopkeeper",
    label: "Shop",
    hello: "Hi! I can tell you what's in stock, quote an order and set it up for you to pay.",
    suggestions: [], // built from this shop's own menu (see shopSuggestions)
  },
  {
    role: "support",
    label: "Order help",
    hello: "Hi! Give me your order number and I can check its status or help with a refund.",
    suggestions: ["Where is my order?", "I want a refund"],
  },
];

/** Starters that fit this shop: one real item to order, plus the menu and the "try to get a deal" question. */
function shopSuggestions(products: Product[]): string[] {
  const first = products.find((p) => !p.isAddon);
  return ["What do you have today?", ...(first ? [`One ${first.name}, please`] : []), "Can I get a discount?"];
}

function conversationId(slug: string, role: StaffRole): string {
  const key = `napkin.chat.${slug}.${role}`;
  try {
    const have = window.sessionStorage.getItem(key);
    if (have) return have;
    const id = `web-${Math.random().toString(36).slice(2, 12)}`;
    window.sessionStorage.setItem(key, id);
    return id;
  } catch {
    return `web-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export function ChatWidget() {
  const { state, slug, preview } = useStore();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState(0);
  const [threads, setThreads] = useState<Msg[][]>([[], []]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const role = ROLES[tab]!;
  const msgs = threads[tab]!;

  useEffect(() => {
    void end.current?.scrollIntoView({ block: "end" });
  }, [msgs.length, busy, open]);

  if (state.status !== "ready" || preview || pathname.endsWith("/qr")) return null;
  const suggestions = role.role === "shopkeeper" ? shopSuggestions(state.products) : role.suggestions;

  async function send(t: string) {
    const q = t.trim();
    if (!q || busy) return;
    const at = tab;
    setText("");
    setThreads((th) => th.map((m, i) => (i === at ? [...m, { from: "you", text: q }] : m)));
    setBusy(true);
    try {
      const r = await sendChat(ROLES[at]!.role, { businessId: slug, conversationId: conversationId(slug, ROLES[at]!.role), text: q });
      setThreads((th) => th.map((m, i) => (i === at ? [...m, { from: "shop", text: r.reply || "…", calls: r.toolCalls }] : m)));
    } catch (e) {
      setThreads((th) => th.map((m, i) => (i === at ? [...m, { from: "shop", text: e instanceof Error ? e.message : String(e), error: true }] : m)));
    } finally {
      setBusy(false);
    }
  }

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(text);
  };

  return (
    <div className="no-print">
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="btn btn-primary fixed bottom-24 right-4 z-30 !min-h-12 shadow-[0_12px_30px_-12px_rgb(0_0_0/0.5)] md:bottom-6 md:right-6"
          aria-label="Chat with the shop"
        >
          <ChatIcon /> <span className="hidden sm:inline">Ask the shop</span>
        </button>
      ) : (
        <div className="fade fixed inset-x-3 bottom-3 z-40 flex max-h-[80dvh] flex-col overflow-hidden rounded-card border border-line bg-paper shadow-2xl md:inset-x-auto md:bottom-6 md:right-6 md:h-[600px] md:w-[400px]" role="dialog" aria-label="Chat with the shop">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div>
              <p className="font-semibold leading-tight">Ask the shop</p>
              <p className="text-xs text-muted">AI assistant · checked by the shop&apos;s rules</p>
            </div>
            <button type="button" onClick={() => setOpen(false)} className="grid h-9 w-9 place-items-center rounded-full text-2xl leading-none text-muted hover:bg-surface" aria-label="Close chat">
              ×
            </button>
          </div>
          <div className="flex gap-1 border-b border-line px-3 py-2">
            {ROLES.map((r, i) => (
              <button
                key={r.role}
                type="button"
                onClick={() => setTab(i)}
                className={`rounded-btn px-3 py-1.5 text-sm font-medium ${i === tab ? "bg-ink text-paper" : "text-muted hover:bg-surface"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
            <Bubble from="shop">{role.hello}</Bubble>
            {msgs.map((m, i) => (
              <div key={i}>
                <Bubble from={m.from} error={m.error}>
                  <Linkified text={m.text} />
                </Bubble>
                {m.calls && m.calls.length > 0 ? <Checks calls={m.calls} /> : null}
              </div>
            ))}
            {busy ? (
              <Bubble from="shop">
                <span className="inline-flex gap-1" aria-label="Typing">
                  <Dot d={0} />
                  <Dot d={150} />
                  <Dot d={300} />
                </span>
              </Bubble>
            ) : null}
            {msgs.length === 0 && !busy ? (
              <div className="flex flex-wrap gap-2 pt-1">
                {suggestions.map((s) => (
                  <button key={s} type="button" onClick={() => void send(s)} className="rounded-btn border border-line-strong px-3 py-1.5 text-sm hover:bg-surface">
                    {s}
                  </button>
                ))}
              </div>
            ) : null}
            <div ref={end} />
          </div>
          <form onSubmit={onSubmit} className="flex gap-2 border-t border-line p-3">
            <input value={text} onChange={(e) => setText(e.target.value.slice(0, 1000))} placeholder="Type a message" className="input !h-11" aria-label="Message" />
            <button type="submit" disabled={busy || !text.trim()} className="btn btn-primary !min-h-11 !px-4">
              Send
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function Bubble({ from, error, children }: { from: Msg["from"]; error?: boolean; children: ReactNode }) {
  const you = from === "you";
  return (
    <div className={`flex ${you ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] whitespace-pre-wrap rounded-card px-3.5 py-2.5 text-[0.93rem] leading-snug ${
          you ? "bg-brand text-on-brand" : error ? "border border-line-strong text-muted" : "bg-surface"
        }`}
      >
        {children}
      </div>
    </div>
  );
}

const PAY_URL = /(https?:\/\/[^\s)*]+)/g;

/** The reply as text: links become links (an order page reads "Pay for this order"), **bold** becomes bold. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(PAY_URL);
  return (
    <>
      {parts.map((p, i) =>
        /^https?:\/\//.test(p) ? (
          <a key={i} href={p} className="break-all font-semibold underline underline-offset-2">
            {/\/(order|p)\//.test(p) ? "Pay for this order" : p}
          </a>
        ) : (
          <span key={i}>{p.split(/\*\*(.+?)\*\*/g).map((s, j) => (j % 2 ? <strong key={j}>{s}</strong> : s))}</span>
        ),
      )}
    </>
  );
}

const TOOL_LABEL: Record<string, string> = {
  menu_lookup: "Checked the live menu",
  quote: "Priced it from the catalog",
  create_order: "Created the order",
  escalate: "Asked the owner",
  order_status: "Looked up the order",
  request_refund: "Refund request",
};

/** What the assistant tried to do, and what the shop's rules (guards) said. */
function Checks({ calls }: { calls: ChatToolCall[] }) {
  return (
    <ul className="mt-1.5 space-y-1 pl-1">
      {calls.map((c, i) => {
        const ok = c.decision.allow;
        const escalated = c.decision.outcome === "escalated" || c.tool === "escalate";
        const pay = c.tool === "create_order" && ok && c.result && typeof c.result === "object" ? (c.result as { payUrl?: unknown }).payUrl : undefined;
        return (
          <li key={i} className="text-xs text-muted">
            <span className={`mr-1.5 inline-block rounded-btn px-1.5 py-0.5 font-semibold ${ok && !escalated ? "bg-surface" : escalated ? "bg-tint text-ink" : "bg-ink text-paper"}`}>
              {ok && !escalated ? "✓ allowed" : escalated ? "→ owner" : "✕ refused by rules"}
            </span>
            {TOOL_LABEL[c.tool] ?? c.tool}
            {!ok && c.decision.reason ? <span className="block pl-1 pt-0.5 opacity-80">{c.decision.reason}</span> : null}
            {typeof pay === "string" ? (
              <a href={pay} className="btn btn-primary mt-2 !min-h-10 w-full">
                Pay for this order
              </a>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function Dot({ d }: { d: number }) {
  return <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: `${d}ms` }} />;
}

function ChatIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 5h16v11H9l-5 4z" />
    </svg>
  );
}
