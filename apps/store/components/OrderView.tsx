"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useTable } from "spacetimedb/react";
import { tables } from "@napkin/stdb-bindings";
import { simulatePayment } from "@/lib/brain";
import { useCart } from "@/lib/cart";
import { decimalToCents, formatCents } from "@/lib/money";
import type { Product, StoreInfo } from "@/lib/model";
import { useStore, useStoreHref } from "@/lib/store-data";
import { StoreGate } from "./StoreShell";
import { StatusScreen } from "./ui";

export type OrderSnapshot = {
  id: string;
  businessId: string;
  status: string;
  totalCents: bigint;
  paidCents: bigint;
  refundedCents: bigint;
  customerName: string;
  createdAt: Date | null;
  paidAt: Date | null;
};
type OrderLine = { productId: string; qty: string; unitPrice: string };

const PAID_LIKE = new Set(["paid", "ready", "picked_up"]);

export function OrderView({ orderId, simulate }: { orderId: string; simulate: boolean }) {
  const { preview } = useStore();
  return preview ? <FixtureOrder orderId={orderId} simulate={simulate} /> : <LiveOrder orderId={orderId} simulate={simulate} />;
}

function LiveOrder({ orderId, simulate }: { orderId: string; simulate: boolean }) {
  const { slug } = useStore();
  const [orderRows, orderReady] = useTable(tables.customerOrder.where((r) => r.id.eq(orderId)));
  const row = orderRows[0];
  const saleId = row?.saleDocumentId ?? 0n;
  const [docRows] = useTable(tables.document.where((r) => r.id.eq(saleId)), { enabled: saleId > 0n });
  const order: OrderSnapshot | null = useMemo(
    () =>
      row
        ? {
            id: row.id,
            businessId: row.businessId,
            status: row.status,
            totalCents: row.totalCents,
            paidCents: row.paidCents,
            refundedCents: row.refundedCents,
            customerName: row.customerName,
            createdAt: row.createdAt.toDate(),
            paidAt: row.paidAt ? row.paidAt.toDate() : null,
          }
        : null,
    [row],
  );
  const { lines, discountRate } = useMemo((): { lines: OrderLine[]; discountRate: string } => {
    const doc = docRows[0];
    if (!doc) return { lines: [], discountRate: "0" };
    return {
      lines: doc.lines.map((l) => {
        const v: Record<string, string> = {};
        for (const fv of l.values) v[fv.name] = fv.value;
        return { productId: v.productId ?? "", qty: v.qty ?? "", unitPrice: v.unitPrice ?? "" };
      }),
      discountRate: doc.fields.find((f) => f.name === "discountRate")?.value ?? "0",
    };
  }, [docRows]);

  if (!orderReady) return <OrderSkeleton />;
  if (!order || order.businessId !== slug) {
    return (
      <StatusScreen emoji="🧾" title="Order not found">
        <p>
          We can&apos;t find order <span className="font-mono">{orderId}</span> yet. If you just paid, keep this page open; it updates by
          itself.
        </p>
      </StatusScreen>
    );
  }
  return <OrderScreen order={order} lines={lines} discountRate={discountRate} simulate={simulate} onSimulate={() => simulatePayment(order.id)} />;
}

/**
 * Subtotal, discount and tax for the receipt. The platform priced the order (total = sum of net + tax per line);
 * the discount is recomputed per line the same way (rounded to the cent) and tax is what remains, so the rows
 * always add up to the platform's total exactly.
 */
function breakdown(lines: OrderLine[], discountRate: string, totalCents: bigint): { subtotal: bigint; discount: bigint; tax: bigint } | null {
  let subtotal = 0n;
  let discount = 0n;
  const rate = Number(discountRate);
  for (const l of lines) {
    const unit = decimalToCents(l.unitPrice);
    if (unit === null || !/^\d+$/.test(l.qty)) return null;
    const gross = unit * BigInt(l.qty);
    subtotal += gross;
    if (rate > 0) discount += BigInt(Math.round(Number(gross) * rate));
  }
  return { subtotal, discount, tax: totalCents - subtotal + discount };
}

/** Preview only: a fake order so the states can be designed without a platform. ?status=paid etc. */
function FixtureOrder({ orderId, simulate }: { orderId: string; simulate: boolean }) {
  const [status, setStatus] = useState("pending_payment");
  useEffect(() => {
    const s = new URLSearchParams(window.location.search).get("status");
    if (s) setStatus(s);
  }, []);
  const { slug } = useStore();
  const order: OrderSnapshot = {
    id: orderId,
    businessId: slug,
    status,
    totalCents: 1600n,
    paidCents: PAID_LIKE.has(status) ? 1600n : 0n,
    refundedCents: status === "refunded" ? 1600n : 0n,
    customerName: "Sam",
    createdAt: new Date(),
    paidAt: null,
  };
  const lines: OrderLine[] = [
    { productId: "cookie_box6", qty: "1", unitPrice: "15.00" },
    { productId: "sea_salt", qty: "1", unitPrice: "1.00" },
  ];
  return (
    <OrderScreen
      order={order}
      lines={lines}
      simulate={simulate}
      onSimulate={async () => {
        await new Promise((r) => setTimeout(r, 600));
        setStatus("paid");
      }}
    />
  );
}

function OrderSkeleton() {
  return (
    <div className="mx-auto max-w-md animate-pulse px-5 pt-12" aria-label="Loading order">
      <div className="mx-auto h-24 w-24 rounded-full bg-ink/8" />
      <div className="mx-auto mt-6 h-8 w-2/3 rounded-xl bg-ink/8" />
      <div className="mt-8 h-56 rounded-tile bg-ink/6" />
    </div>
  );
}

function OrderScreen({
  order,
  lines,
  discountRate = "0",
  simulate,
  onSimulate,
}: {
  order: OrderSnapshot;
  lines: OrderLine[];
  discountRate?: string;
  simulate: boolean;
  onSimulate: () => Promise<void>;
}) {
  return (
    <StoreGate>
      {({ info, products }) => <OrderBody order={order} lines={lines} discountRate={discountRate} simulate={simulate} onSimulate={onSimulate} info={info} products={products} />}
    </StoreGate>
  );
}

const STEPS = [
  { key: "pending_payment", label: "Placed" },
  { key: "paid", label: "Paid" },
  { key: "ready", label: "Ready" },
  { key: "picked_up", label: "Picked up" },
];

function OrderBody({
  order,
  lines,
  discountRate,
  simulate,
  onSimulate,
  info,
  products,
}: {
  order: OrderSnapshot;
  lines: OrderLine[];
  discountRate: string;
  simulate: boolean;
  onSimulate: () => Promise<void>;
  info: StoreInfo;
  products: Product[];
}) {
  const href = useStoreHref();
  const { clear } = useCart();
  const paidLike = PAID_LIKE.has(order.status);
  const [celebrate, setCelebrate] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);

  useEffect(() => {
    if (paidLike) {
      clear();
      setCelebrate(true);
    }
  }, [paidLike, clear]);

  const stepIndex = STEPS.findIndex((s) => s.key === order.status);
  const name = order.customerName.trim();
  const head = headlineFor(order.status, name);
  const cur = info.currency;
  const sums = lines.length > 0 ? breakdown(lines, discountRate, order.totalCents) : null;

  return (
    <div className="mx-auto max-w-md px-4 pt-8">
      {celebrate && order.status === "paid" ? <Confetti emoji={info.theme.emoji} /> : null}

      <div className="text-center">
        <StatusBadge status={order.status} emoji={info.theme.emoji} />
        <h1 className="mt-5 ds-display text-4xl font-black leading-tight text-brand">{head.title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-ink/75">{head.body}</p>
      </div>

      {stepIndex >= 0 ? (
        <ol className="mt-7 grid grid-cols-4 gap-1" aria-label="Order progress">
          {STEPS.map((s, i) => {
            const done = i <= stepIndex;
            return (
              <li key={s.key} className="flex flex-col items-center gap-1.5 text-center">
                <span
                  className={`h-2 w-full rounded-full transition-colors duration-700 ${done ? "bg-brand" : "bg-ink/10"}`}
                  aria-hidden
                />
                <span className={`text-xs font-semibold ${i === stepIndex ? "text-brand" : done ? "text-ink/70" : "text-muted"}`}>{s.label}</span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {simulate && order.status === "pending_payment" ? (
        <div className="mt-6 rounded-card border-2 border-dashed border-ink/30 bg-card p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-ink/70">Dev simulator</p>
          <p className="mt-1 text-sm text-ink/75">
            No Stripe key is configured yet, so no card form is shown. This button tells the platform a test payment succeeded. No money moves.
          </p>
          <button
            type="button"
            disabled={simBusy}
            onClick={async () => {
              setSimBusy(true);
              setSimError(null);
              try {
                await onSimulate();
              } catch (e) {
                setSimError(e instanceof Error ? e.message : String(e));
              } finally {
                setSimBusy(false);
              }
            }}
            className="mt-3 h-12 w-full rounded-full bg-ink font-semibold text-paper active:scale-[0.98] disabled:opacity-60"
          >
            {simBusy ? "Simulating…" : "Simulate test payment"}
          </button>
          {simError ? (
            <p role="alert" className="mt-2 text-sm font-medium text-brand-deep">
              {simError}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="card-shadow mt-7 overflow-hidden rounded-tile border border-line bg-card">
        <div className="flex items-center justify-between border-b border-dashed border-line px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Order</p>
            <p className="font-mono text-2xl font-bold tracking-wider">{order.id}</p>
          </div>
          {name ? (
            <div className="text-right">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted">Name</p>
              <p className="ds-display text-xl font-semibold">{name}</p>
            </div>
          ) : null}
        </div>
        {lines.length > 0 ? (
          <ul className="space-y-2 px-5 py-4 text-[0.95rem]">
            {lines.map((l, i) => {
              const p = products.find((x) => x.id === l.productId);
              const unit = decimalToCents(l.unitPrice);
              const q = /^\d+$/.test(l.qty) ? BigInt(l.qty) : null;
              return (
                <li key={i} className="flex justify-between gap-3">
                  <span>
                    <span className="tabular-nums text-muted">{l.qty} ×</span> {p?.name ?? l.productId}
                  </span>
                  <span className="tabular-nums">{unit !== null && q !== null ? formatCents(unit * q, cur) : l.unitPrice}</span>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="space-y-1 border-t border-line bg-paper/50 px-5 py-4">
          {sums && (sums.discount > 0n || sums.tax !== 0n) ? (
            <>
              <Row label="Subtotal" value={formatCents(sums.subtotal, cur)} />
              {sums.discount > 0n ? <Row label="Discount" value={`−${formatCents(sums.discount, cur)}`} /> : null}
              {sums.tax !== 0n ? <Row label="Tax" value={formatCents(sums.tax, cur)} /> : null}
            </>
          ) : null}
          <Row label="Total" value={formatCents(order.totalCents, cur)} strong />
          {order.paidCents > 0n ? <Row label="Paid (test card)" value={formatCents(order.paidCents, cur)} /> : null}
          {order.refundedCents > 0n ? <Row label="Refunded" value={`−${formatCents(order.refundedCents, cur)}`} /> : null}
        </div>
      </div>

      {info.pickupLocation || info.hours ? (
        <div className="mt-5 rounded-tile border border-line bg-card p-5 text-[0.95rem]">
          <p className="ds-display text-lg font-semibold text-brand">Pickup</p>
          {info.pickupLocation ? <p className="mt-1">{info.pickupLocation}</p> : null}
          {info.hours ? <p className="text-muted">{info.hours}</p> : null}
        </div>
      ) : null}

      <div className="mt-6 text-center">
        <Link href={href()} className="text-sm font-semibold text-brand underline underline-offset-4">
          Back to {info.name}
        </Link>
      </div>
    </div>
  );
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between">
      <span className={strong ? "font-semibold" : "text-sm text-muted"}>{label}</span>
      <span className={`tabular-nums ${strong ? "ds-display text-2xl font-bold" : "text-sm"}`}>{value}</span>
    </div>
  );
}

function headlineFor(status: string, name: string): { title: string; body: string } {
  const who = name ? `, ${name}` : "";
  switch (status) {
    case "pending_payment":
      return { title: "Almost there", body: "Waiting for your payment. This page updates by itself as soon as it goes through." };
    case "paid":
      return { title: `Thank you${who}!`, body: "Your order is paid. Show this screen when you pick it up." };
    case "ready":
      return { title: "Ready for pickup", body: "Your order is ready. Show this screen when you pick it up." };
    case "picked_up":
      return { title: "Enjoy!", body: "This order has been picked up." };
    case "refunded":
      return { title: "Refunded", body: "This order was refunded (Stripe test mode, no real money)." };
    case "partially_refunded":
      return { title: "Partly refunded", body: "Part of this order was refunded (Stripe test mode, no real money)." };
    case "cancelled":
      return { title: "Cancelled", body: "This order was cancelled." };
    default:
      return { title: "Order status", body: `Status: ${status}` };
  }
}

function StatusBadge({ status, emoji }: { status: string; emoji: string }) {
  if (PAID_LIKE.has(status)) {
    return (
      <div className="pop relative mx-auto grid h-28 w-28 place-items-center rounded-full bg-brand text-on-brand shadow-[0_18px_40px_-18px_var(--brand-primary)]">
        <svg width="56" height="56" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path className="check-path" d="M5 12.5l4.2 4.2L19 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="absolute -right-1 -top-1 grid h-11 w-11 place-items-center rounded-full bg-accent text-2xl" aria-hidden>
          {emoji}
        </span>
        <span className="sr-only">Paid</span>
      </div>
    );
  }
  if (status === "pending_payment") {
    return (
      <div className="relative mx-auto grid h-28 w-28 place-items-center rounded-full bg-tint">
        <span className="absolute inset-0 animate-spin rounded-full border-4 border-transparent border-t-brand [animation-duration:1.6s]" aria-hidden />
        <span className="text-5xl" aria-hidden>
          {emoji}
        </span>
      </div>
    );
  }
  return (
    <div className="mx-auto grid h-28 w-28 place-items-center rounded-full bg-ink/8 text-5xl" aria-hidden>
      🧾
    </div>
  );
}

function Confetti({ emoji }: { emoji: string }) {
  const bits = Array.from({ length: 22 }, (_, i) => {
    const left = (i * 37) % 100;
    const size = 18 + ((i * 13) % 22);
    const delay = ((i * 7) % 10) / 12;
    const dur = 2.2 + ((i * 11) % 10) / 8;
    const drift = ((i * 29) % 80) - 40;
    const spin = ((i % 2 ? 1 : -1) * (180 + ((i * 53) % 360))).toString();
    const glyph = i % 3 === 0 ? "✦" : emoji;
    return (
      <span
        key={i}
        className="confetti"
        aria-hidden
        style={
          {
            left: `${left}%`,
            fontSize: `${size}px`,
            color: i % 2 ? "var(--brand-accent)" : "var(--brand-primary)",
            "--delay": `${delay}s`,
            "--dur": `${dur}s`,
            "--drift": `${drift}px`,
            "--spin": `${spin}deg`,
          } as CSSProperties
        }
      >
        {glyph}
      </span>
    );
  });
  return <>{bits}</>;
}
