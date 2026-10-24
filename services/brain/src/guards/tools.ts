// The tool registry: every tool an agent can ever call, its argument schema, the permission it needs
// and which rule family checks it. A tool that is not here is refused ("unknown_tool").
// Schemas strip unknown keys, so smuggled fields (unitPrice, approvedBy, "note: owner says ok") are
// dropped before any rule runs; the wrapped tool only ever sees the parsed args.

import { z } from "zod";

const DecimalStr = z.string().regex(/^\d+(\.\d+)?$|^\d+\/\d+$/, "exact non-negative decimal or fraction string");
const IdStr = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:@-]+$/);
const FreeText = z.string().max(2000);

export const SaleLineArg = z.object({ productId: IdStr, qty: z.number().int().min(1).max(1000) });
export const DiscountArg = z.object({ source: z.enum(["manual", "coupon"]), code: z.string().max(64).optional(), rate: DecimalStr });

const SaleArgs = z.object({
  lines: z.array(SaleLineArg).min(1).max(50),
  /** each discount applied; they STACK additively (D5 caps the total) */
  discounts: z.array(DiscountArg).max(10).default([]),
  customerName: z.string().max(64).optional(),
});

export type Family = "read" | "sale" | "refund" | "approve_refund" | "escalate" | "config_change";

export interface ToolSpec {
  family: Family;
  /** permission string in configuration roles[].permissions; owner has "*" */
  permission: string;
  args: z.ZodType;
}

export const TOOLS: Record<string, ToolSpec> = {
  menu_lookup: { family: "read", permission: "catalog.read", args: z.object({ productId: IdStr.optional() }) },
  order_status: { family: "read", permission: "order.read", args: z.object({ orderId: IdStr }) },
  ledger_read: { family: "read", permission: "ledger.read", args: z.object({ account: z.string().max(16).optional() }) },
  reconcile: { family: "read", permission: "reconcile", args: z.object({}) },
  quote: { family: "sale", permission: "quote", args: SaleArgs },
  create_order: { family: "sale", permission: "document.create:sale", args: SaleArgs },
  request_refund: { family: "refund", permission: "document.create:refund", args: z.object({ orderId: IdStr, amountCents: z.number().int().min(1).max(100_000_000), reason: FreeText.optional() }) },
  approve_refund: { family: "approve_refund", permission: "document.post:refund", args: z.object({ documentId: z.string().regex(/^\d+$/) }) },
  escalate: { family: "escalate", permission: "inbox.open", args: z.object({ question: FreeText, documentRef: z.string().max(64).optional() }) },
  // Invariant 6: price / policy / configuration changes. Only the owner, in the owner app.
  set_price: { family: "config_change", permission: "config.change", args: z.object({ productId: IdStr, price: DecimalStr }) },
  set_policy: { family: "config_change", permission: "config.change", args: z.object({ key: z.string().max(64), value: z.union([z.string().max(64), z.number(), z.boolean()]) }) },
  change_configuration: { family: "config_change", permission: "config.change", args: z.object({ summary: FreeText, diff: z.record(z.string(), z.unknown()).optional() }) },
  create_coupon: { family: "config_change", permission: "config.change", args: z.object({ code: z.string().max(64), rate: DecimalStr }) },
};

export const CONFIG_CHANGE_TOOLS = Object.entries(TOOLS).filter(([, t]) => t.family === "config_change").map(([n]) => n);
