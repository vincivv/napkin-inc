// How an order reads in a list: who, what they bought ("2 × Pack of 5"), how it was paid, and a short time.
// Pure; the list component does the React side.

import type { CustomerOrderRow, DocumentRow } from "@/data/types";
import { formatCents } from "./money";
import { dayIn, fieldMap } from "./reports";

/** "2 × Pack of 5, 1 × Sea salt" from the order's sale document; "" when there is none yet. */
export function orderItems(sale: Pick<DocumentRow, "lines"> | undefined, nameOf: (productId: string) => string): string {
  if (!sale) return "";
  const qty = new Map<string, number>();
  for (const line of sale.lines) {
    const f = fieldMap(line.values);
    const id = f["productId"];
    if (!id) continue;
    qty.set(id, (qty.get(id) ?? 0) + (Number(f["qty"]) || 0));
  }
  return [...qty].map(([id, n]) => `${n} × ${nameOf(id)}`).join(", ");
}

/** "paid by card", "awaiting payment", "refunded $3.00 of $15.00"… */
export function paymentWords(o: Pick<CustomerOrderRow, "status" | "paidCents" | "refundedCents" | "totalCents">): string {
  switch (o.status) {
    case "pending_payment":
      return "awaiting payment";
    case "cancelled":
      return "cancelled";
    case "refunded":
      return "refunded";
    case "partially_refunded":
      return `refunded ${formatCents(o.refundedCents)} of ${formatCents(o.totalCents)}`;
    default:
      // Payments come in through Stripe checkout, so a paid order was paid by card.
      return o.paidCents > 0n ? "paid by card" : "paid";
  }
}

/** First letter of the customer's name for the avatar; "?" when there is no name. */
export function initial(name: string): string {
  const c = name.trim().charAt(0);
  return c ? c.toUpperCase() : "?";
}

/** "4:30pm" today, then "Yesterday", "Fri" this week, else "Oct 12" (the order page has the full time). */
export function shortTime(micros: bigint, timeZone: string, nowMicros: bigint): string {
  const d = new Date(Number(micros / 1000n));
  const fmt = (opts: Intl.DateTimeFormatOptions) => {
    try {
      return new Intl.DateTimeFormat("en-US", { ...opts, timeZone }).format(d);
    } catch {
      return new Intl.DateTimeFormat("en-US", opts).format(d);
    }
  };
  const clock = fmt({ hour: "numeric", minute: "2-digit" }).replace(/\s?([AP])M$/i, (_m, ap: string) => `${ap.toLowerCase()}m`);
  const day = dayIn(micros, timeZone);
  const today = dayIn(nowMicros, timeZone);
  if (day === today) return clock;
  const daysAgo = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000);
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo > 1 && daysAgo < 7) return fmt({ weekday: "short" });
  return fmt({ month: "short", day: "numeric" });
}
