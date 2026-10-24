// What the staff's tools DO once the guard has allowed them. Every effect goes to the platform as the
// agent's own identity (role fixed server-side). Reads compute facts with deterministic code: quotes use
// the platform's own posting engine (ledger-core) on catalog prices; orders go through the storefront's
// checkout path (src/payments/checkout.ts), so pricing exists in one place.

import { computeDocument, Rational } from "@napkin/ledger-core";
import type { Configuration } from "@napkin/schema";
import { fixed2 } from "../compiler";
import { docDef, postingContext, productCatalog, saleInput } from "../compiler/dryrun";
import type { GuardDecision } from "../guards";
import { ledgerRead, reconcile, type BookSet } from "./books";
import type { StaffRole } from "./types";

export interface SaleArgs {
  lines: { productId: string; qty: number }[];
  discounts: { source: "manual" | "coupon"; code?: string | undefined; rate: string }[];
  customerName?: string | undefined;
}

export interface OrderStatusView {
  orderId: string;
  status: string;
  totalCents: string;
  paidCents: string;
  refundedCents: string;
  channel: string;
  paidAt?: string | null;
}

export interface StaffBackend {
  /** platform identity (hex) for role@business when the brain holds it */
  identity(role: StaffRole, businessId: string): string | undefined;
  createOrder(input: { businessId: string; lines: SaleArgs["lines"]; customerName: string; discountRate: string; couponCode: string }): Promise<{ orderId: string; totalCents: string; payUrl: string; simulated: boolean }>;
  orderStatus(businessId: string, orderId: string): OrderStatusView | undefined;
  requestRefund(role: StaffRole, businessId: string, a: { orderId: string; amountCents: number; reason: string }): Promise<{ documentId: string | undefined }>;
  approveRefund(role: StaffRole, businessId: string, documentId: string): Promise<void>;
  openInbox(role: StaffRole, businessId: string, i: { question: string; documentRef: string; contextJson: string }): Promise<void>;
  /** the live books of a business */
  books(businessId: string): Promise<BookSet>;
}

export interface ToolContext {
  role: StaffRole;
  businessId: string;
  config: Configuration;
  backend: StaffBackend;
  /** a provided book set replaces the live ledger for ledger_read / reconcile (red-team planted books) */
  books?: BookSet | undefined;
}

export class ToolError extends Error {
  override name = "ToolError";
}

export type ToolImpl = (args: unknown, decision: GuardDecision) => Promise<unknown>;

export function menu(cfg: Configuration, productId?: string) {
  return productCatalog(cfg)
    .entries.filter((e) => !productId || e.id === productId)
    .map((e) => ({ productId: e.id, name: String(e.data["name"] ?? e.id), kind: String(e.data["kind"] ?? ""), price: String(e.data["price"]), description: String(e.data["description"] ?? "") }));
}

const totalRate = (a: SaleArgs) => a.discounts.reduce((s, d) => s.add(Rational.parse(d.rate)), Rational.ZERO);

/** The exact sale the platform would compute (catalog prices, the config's own derived fields). */
export function quote(cfg: Configuration, a: SaleArgs) {
  const rate = totalRate(a);
  const envs = computeDocument(docDef(cfg, "sale"), saleInput(cfg, a.lines, rate.toJSON()), postingContext(cfg));
  const names = new Map(menu(cfg).map((m) => [m.productId, m.name]));
  return {
    currency: cfg.policies.currency,
    lines: a.lines.map((l, i) => {
      const c = envs.computed.lines[i]!;
      return { productId: l.productId, name: names.get(l.productId) ?? l.productId, qty: l.qty, gross: fixed2(c["gross"]!), discount: fixed2(c["discount"]!), net: fixed2(c["net"]!), tax: fixed2(c["tax"]!) };
    }),
    discountRate: rate.toDecimal(4),
    total: fixed2(envs.computed.doc["total"]!),
  };
}

/** Tool implementations for one agent turn. Only reachable through wrapTool (guard first). */
export function toolImpls(ctx: ToolContext): Record<string, ToolImpl> {
  const { backend, businessId, role, config } = ctx;
  return {
    menu_lookup: async (a) => ({ menu: menu(config, (a as { productId?: string }).productId) }),
    quote: async (a) => quote(config, a as SaleArgs),
    create_order: async (raw) => {
      const a = raw as SaleArgs;
      const name = a.customerName?.trim();
      if (!name) throw new ToolError("customerName is required: ask the customer for a first name, then call create_order again");
      // There is no coupon table in the configuration, so no coupon code can be verified. Safer: none is honored.
      if (a.discounts.some((d) => d.source === "coupon")) throw new ToolError("coupon codes cannot be verified (the business has no coupon list); no order was created. Escalate to the owner if the customer insists.");
      const coupon = "";
      const q = quote(config, a);
      const r = await backend.createOrder({ businessId, lines: a.lines, customerName: name.slice(0, 60), discountRate: totalRate(a).toDecimal(4), couponCode: coupon });
      return { orderId: r.orderId, total: q.total, totalCents: r.totalCents, payUrl: r.payUrl, simulatedPayment: r.simulated, lines: q.lines };
    },
    order_status: async (a) => {
      const orderId = (a as { orderId: string }).orderId;
      const s = backend.orderStatus(businessId, orderId);
      if (!s) throw new ToolError(`no order ${orderId} for this business`);
      return s;
    },
    request_refund: async (a) => {
      const r = a as { orderId: string; amountCents: number; reason?: string };
      const out = await backend.requestRefund(role, businessId, { orderId: r.orderId, amountCents: r.amountCents, reason: (r.reason ?? "").slice(0, 500) });
      return { status: "refund_requested", documentId: out.documentId ?? null, note: "a refund draft exists; a different role (bookkeeper or owner) must approve it before money moves" };
    },
    approve_refund: async (a) => {
      const id = (a as { documentId: string }).documentId;
      await backend.approveRefund(role, businessId, id);
      return { status: "refund_posted", documentId: id, note: "the refund is posted; the processor refund is queued in the outbox" };
    },
    escalate: async (a, d) => {
      const e = a as { question: string; documentRef?: string };
      await backend.openInbox(role, businessId, { question: e.question, documentRef: e.documentRef ?? "", contextJson: JSON.stringify({ tool: "escalate", inputsHash: d.inputsHash }) });
      return { status: "escalated_to_owner", note: "an owner inbox item is open; the owner decides" };
    },
    ledger_read: async (a) => ledgerRead(ctx.books ?? (await backend.books(businessId)), (a as { account?: string }).account),
    reconcile: async () => reconcile(ctx.books ?? (await backend.books(businessId))),
  };
}
