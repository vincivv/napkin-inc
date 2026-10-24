// item_seller TEMPLATE: the business-independent half of a Configuration, factored out of the M1
// hand-written fixtures/maya/configuration.json. It holds NO business facts (no prices, costs, stock,
// rates or places): those come only from the owner-confirmed BusinessSpec in compiler/index.ts.
//
// What lives here: chart of accounts, registers, document types (fields, derived fields, checks,
// posting rules, approval flow), role permissions, agent tool sets and escalation rules, reports.
// test/compiler.test.ts asserts these stay identical to the fixture, so the two cannot drift.

import type { Configuration, DocumentType } from "@napkin/schema";

type Account = Configuration["chartOfAccounts"][number];
type Register = Configuration["registers"][number];
type FieldDef = Configuration["catalogs"][number]["fields"][number];
type Role = Configuration["roles"][number];
type AgentDef = Configuration["agents"][number];

export const TEMPLATE_ID = "item_seller@1";

export const DOCUMENTS: readonly DocumentType[] = [
  {
    id: "sale",
    name: "Sale",
    approval: { creatorRoles: ["storefront", "shopkeeper", "owner"], approverRoles: ["system", "bookkeeper", "owner"], cannotApproveOwn: true, postOn: "payment" },
    fields: [
      { name: "orderId", type: "string", required: true },
      { name: "customerRef", type: "string" },
      { name: "discountRate", type: "rate", required: true },
      { name: "couponCode", type: "string" },
    ],
    lineFields: [
      { name: "productId", type: "string", required: true },
      { name: "qty", type: "qty", required: true },
      { name: "unitPrice", type: "money", required: true },
      { name: "unitCost", type: "money", required: true },
      { name: "stockItem", type: "string" },
      { name: "stockUnits", type: "qty", required: true },
    ],
    derived: [
      { name: "gross", scope: "line", expr: "line.qty * line.unitPrice" },
      { name: "discount", scope: "line", expr: "round2(line.gross * doc.discountRate)" },
      { name: "net", scope: "line", expr: "line.gross - line.discount" },
      { name: "tax", scope: "line", expr: "round2(line.net * policy.taxRate)" },
      { name: "cost", scope: "line", expr: "line.qty * line.unitCost" },
      { name: "units", scope: "line", expr: "line.qty * line.stockUnits" },
      { name: "total", scope: "doc", expr: "sum(line.net + line.tax)" },
      { name: "costTotal", scope: "doc", expr: "sum(line.cost)" },
    ],
    checks: [
      { id: "qty_positive", scope: "line", assert: "line.qty >= 1", message: "quantity must be at least 1" },
      {
        id: "discount_cap",
        scope: "doc",
        assert: "doc.discountRate >= 0 && doc.discountRate <= policy.maxDiscount",
        message: "total discount exceeds the maximum discount policy",
      },
      {
        id: "margin_floor",
        scope: "line",
        assert: "line.net >= line.cost * (1 + policy.marginFloor)",
        message: "price after discounts is below cost plus the margin floor",
      },
    ],
    postingRules: [
      { id: "sale.revenue", scope: "line", target: { kind: "account", code: "4000" }, side: "credit", amountExpr: "line.gross", memo: "sales revenue" },
      {
        id: "sale.discount",
        scope: "line",
        target: { kind: "account", code: "4100" },
        side: "debit",
        amountExpr: "line.discount",
        memo: "discounts given",
      },
      {
        id: "sale.receivable",
        scope: "line",
        target: { kind: "account", code: "1200" },
        side: "debit",
        amountExpr: "line.net + line.tax",
        memo: "customer owes",
      },
      { id: "sale.tax", scope: "line", target: { kind: "account", code: "2100" }, side: "credit", amountExpr: "line.tax", memo: "sales tax collected" },
      { id: "sale.cogs", scope: "line", target: { kind: "account", code: "5000" }, side: "debit", amountExpr: "line.cost", memo: "cost of goods sold" },
      {
        id: "sale.inventory",
        scope: "line",
        target: { kind: "account", code: "1300" },
        side: "credit",
        amountExpr: "line.cost",
        memo: "inventory used",
      },
      {
        id: "sale.stock_out",
        scope: "line",
        target: { kind: "register", id: "stock", dims: { item: "line.stockItem" } },
        side: "out",
        amountExpr: "line.cost",
        qtyExpr: "line.units",
        when: "line.units > 0",
      },
      {
        id: "sale.by_product",
        scope: "line",
        target: { kind: "register", id: "sales", dims: { product: "line.productId" } },
        side: "in",
        amountExpr: "line.net",
        qtyExpr: "line.qty",
      },
    ],
  },
  {
    id: "payment_received",
    name: "Payment received",
    approval: {
      creatorRoles: ["system"],
      approverRoles: ["system"],
      cannotApproveOwn: false,
      postOn: "create",
      note: "processor events are machine-originated and auto-post; dedupe by processor event id",
    },
    fields: [
      { name: "orderId", type: "string", required: true },
      { name: "amount", type: "money", required: true },
      { name: "processorRef", type: "string", required: true },
    ],
    lineFields: [],
    derived: [],
    checks: [{ id: "amount_positive", scope: "doc", assert: "doc.amount > 0", message: "payment amount must be positive" }],
    postingRules: [
      {
        id: "pay.clearing",
        scope: "doc",
        target: { kind: "account", code: "1010" },
        side: "debit",
        amountExpr: "doc.amount",
        memo: "card payment into Stripe clearing",
      },
      {
        id: "pay.receivable",
        scope: "doc",
        target: { kind: "account", code: "1200" },
        side: "credit",
        amountExpr: "doc.amount",
        memo: "customer paid",
      },
    ],
  },
  {
    id: "processor_fee",
    name: "Processor fee",
    approval: { creatorRoles: ["system"], approverRoles: ["system"], cannotApproveOwn: false, postOn: "create" },
    fields: [
      { name: "orderId", type: "string", required: true },
      { name: "fee", type: "money", required: true },
      { name: "processorRef", type: "string", required: true },
    ],
    lineFields: [],
    derived: [],
    checks: [{ id: "fee_nonneg", scope: "doc", assert: "doc.fee >= 0", message: "fee cannot be negative" }],
    postingRules: [
      { id: "fee.expense", scope: "doc", target: { kind: "account", code: "5100" }, side: "debit", amountExpr: "doc.fee", memo: "Stripe fee" },
      {
        id: "fee.clearing",
        scope: "doc",
        target: { kind: "account", code: "1010" },
        side: "credit",
        amountExpr: "doc.fee",
        memo: "fee withheld by Stripe",
      },
    ],
  },
  {
    id: "refund",
    name: "Refund",
    approval: {
      creatorRoles: ["support", "shopkeeper", "owner"],
      approverRoles: ["bookkeeper", "owner"],
      cannotApproveOwn: true,
      postOn: "approve",
      note: "saleNet, saleTotal, saleCost, hoursSinceSale and refundedSoFar are filled by the platform from the referenced sale, never by the caller",
    },
    fields: [
      { name: "orderId", type: "string", required: true },
      { name: "amount", type: "money", required: true },
      { name: "reason", type: "string" },
      { name: "saleTotal", type: "money", required: true },
      { name: "saleNet", type: "money", required: true },
      { name: "saleCost", type: "money", required: true },
      { name: "refundedSoFar", type: "money", required: true },
      { name: "hoursSinceSale", type: "number", required: true },
    ],
    lineFields: [],
    derived: [
      { name: "refundedAfter", scope: "doc", expr: "doc.refundedSoFar + doc.amount" },
      { name: "retained", scope: "doc", expr: "doc.saleNet - doc.refundedAfter" },
    ],
    checks: [
      { id: "refund_positive", scope: "doc", assert: "doc.amount > 0", message: "refund amount must be positive" },
      { id: "refund_window", scope: "doc", assert: "doc.hoursSinceSale <= policy.refundWindowHours", message: "the refund window has passed" },
      { id: "refund_not_over", scope: "doc", assert: "doc.refundedAfter <= doc.saleTotal", message: "refunds cannot exceed what was paid" },
      {
        id: "refund_full_or_floor",
        scope: "doc",
        assert: "doc.refundedAfter == doc.saleTotal || doc.retained >= doc.saleCost * (1 + policy.marginFloor)",
        message: "a partial refund cannot take the sale below cost plus the margin floor; refund in full instead",
      },
    ],
    postingRules: [
      {
        id: "refund.contra",
        scope: "doc",
        target: { kind: "account", code: "4200" },
        side: "debit",
        amountExpr: "doc.amount",
        memo: "refund to customer",
      },
      {
        id: "refund.clearing",
        scope: "doc",
        target: { kind: "account", code: "1010" },
        side: "credit",
        amountExpr: "doc.amount",
        memo: "refund paid from Stripe clearing",
      },
    ],
  },
  {
    id: "stock_receipt",
    name: "Stock receipt",
    approval: { creatorRoles: ["owner", "bookkeeper"], approverRoles: ["owner", "bookkeeper"], cannotApproveOwn: true, postOn: "approve" },
    fields: [{ name: "supplier", type: "string" }],
    lineFields: [
      { name: "stockItem", type: "string", required: true },
      { name: "qty", type: "qty", required: true },
      { name: "unitCost", type: "money", required: true },
    ],
    derived: [{ name: "value", scope: "line", expr: "line.qty * line.unitCost" }],
    checks: [{ id: "qty_positive", scope: "line", assert: "line.qty >= 1", message: "quantity must be at least 1" }],
    postingRules: [
      {
        id: "receipt.inventory",
        scope: "line",
        target: { kind: "account", code: "1300" },
        side: "debit",
        amountExpr: "line.value",
        memo: "stock received",
      },
      {
        id: "receipt.payable",
        scope: "line",
        target: { kind: "account", code: "2000" },
        side: "credit",
        amountExpr: "line.value",
        memo: "owed to supplier",
      },
      {
        id: "receipt.stock_in",
        scope: "line",
        target: { kind: "register", id: "stock", dims: { item: "line.stockItem" } },
        side: "in",
        amountExpr: "line.value",
        qtyExpr: "line.qty",
      },
    ],
  },
  {
    id: "opening_balance",
    name: "Opening stock",
    approval: {
      creatorRoles: ["owner", "system"],
      approverRoles: ["owner", "system"],
      cannotApproveOwn: false,
      postOn: "create",
      note: "initial stock contributed by the owner",
    },
    fields: [],
    lineFields: [
      { name: "stockItem", type: "string", required: true },
      { name: "qty", type: "qty", required: true },
      { name: "unitCost", type: "money", required: true },
    ],
    derived: [{ name: "value", scope: "line", expr: "line.qty * line.unitCost" }],
    checks: [],
    postingRules: [
      { id: "open.inventory", scope: "line", target: { kind: "account", code: "1300" }, side: "debit", amountExpr: "line.value" },
      { id: "open.equity", scope: "line", target: { kind: "account", code: "3000" }, side: "credit", amountExpr: "line.value" },
      {
        id: "open.stock_in",
        scope: "line",
        target: { kind: "register", id: "stock", dims: { item: "line.stockItem" } },
        side: "in",
        amountExpr: "line.value",
        qtyExpr: "line.qty",
      },
    ],
  },
  {
    id: "payout",
    name: "Payout to bank",
    approval: {
      creatorRoles: ["system", "bookkeeper"],
      approverRoles: ["system", "owner"],
      cannotApproveOwn: true,
      postOn: "approve",
      note: "simulated in Stripe test mode",
    },
    fields: [{ name: "amount", type: "money", required: true }, { name: "processorRef", type: "string" }],
    lineFields: [],
    derived: [],
    checks: [{ id: "amount_positive", scope: "doc", assert: "doc.amount > 0", message: "payout must be positive" }],
    postingRules: [
      { id: "payout.bank", scope: "doc", target: { kind: "account", code: "1000" }, side: "debit", amountExpr: "doc.amount" },
      { id: "payout.clearing", scope: "doc", target: { kind: "account", code: "1010" }, side: "credit", amountExpr: "doc.amount" },
    ],
  },
];

export const CHART_OF_ACCOUNTS: readonly Account[] = [
  { code: "1000", name: "Cash (bank)", type: "asset" },
  { code: "1010", name: "Stripe clearing", type: "asset" },
  { code: "1200", name: "Receivables", type: "asset" },
  { code: "1300", name: "Inventory", type: "asset" },
  { code: "2000", name: "Payables", type: "liability" },
  { code: "2100", name: "Sales tax payable", type: "liability" },
  { code: "3000", name: "Owner equity", type: "equity" },
  { code: "4000", name: "Sales revenue", type: "revenue" },
  { code: "4100", name: "Discounts given", type: "contra_revenue" },
  { code: "4200", name: "Refunds", type: "contra_revenue" },
  { code: "5000", name: "Cost of goods sold", type: "expense" },
  { code: "5100", name: "Processor fees", type: "expense" },
];

export const REGISTERS: readonly Register[] = [
  { id: "stock", name: "Stock", kind: "balance", dimensions: ["item"], resources: ["qty", "amount"], allowNegative: false },
  { id: "sales", name: "Sales by product", kind: "turnover", dimensions: ["product"], resources: ["qty", "amount"], allowNegative: true },
];

export const PRODUCT_FIELDS: readonly FieldDef[] = [
  { name: "name", type: "string" },
  { name: "kind", type: "string" },
  { name: "price", type: "money" },
  { name: "cost", type: "money" },
  { name: "stockItem", type: "string" },
  { name: "stockUnits", type: "qty" },
  { name: "description", type: "string" },
];
export const STOCK_ITEM_FIELDS: readonly FieldDef[] = [{ name: "name", type: "string" }, { name: "unitCost", type: "money" }];
export const ROLE_PERMISSIONS: Record<RoleId, readonly string[]> = {
  owner: ["*"],
  system: [
    "document.create:sale",
    "document.post:sale",
    "document.create:payment_received",
    "document.create:processor_fee",
    "document.create:payout",
    "document.create:opening_balance",
    "outbox.*",
    "decision.write",
  ],
  storefront: ["catalog.read", "order.create", "document.create:sale"],
  shopkeeper: ["catalog.read", "document.create:sale", "quote", "inbox.open", "decision.write"],
  support: ["catalog.read", "order.read", "document.create:refund", "inbox.open", "decision.write"],
  bookkeeper: [
    "ledger.read",
    "document.post:refund",
    "document.post:stock_receipt",
    "document.create:stock_receipt",
    "document.create:payout",
    "inbox.open",
    "decision.write",
    "reconcile",
  ],
};
export const REPORTS: readonly string[] = ["trial_balance", "pnl", "stock", "receivables", "payables", "cash_flow", "margin_by_item"];

export type RoleId = "owner" | "system" | "storefront" | "shopkeeper" | "support" | "bookkeeper";
export const ROLE_ORDER: readonly RoleId[] = ["owner", "system", "storefront", "shopkeeper", "support", "bookkeeper"];

/** Catalog ids and the line keys the platform reads them by (platform/src/core.ts productCatalog/openingLines). */
export const PRODUCTS_CATALOG = { id: "products", name: "Products", lineKey: "productId" } as const;
export const STOCK_ITEMS_CATALOG = { id: "stock_items", name: "Stock items", lineKey: "stockItem" } as const;

/**
 * Platform rules, not business facts (documented in docs/PLAN.md):
 *  - D5: at most one coupon per order; the TOTAL discount is capped by policies.maxDiscount.
 *  - backorders are off: the stock register may never go negative (invariant 3). Turning them on would be
 *    a looser rule and needs an explicit owner decision, which the BusinessSpec has no field for yet.
 */
export const PLATFORM_POLICY = { couponsPerOrderWhenAllowed: 1, backordersAllowed: false } as const;

export const STOREFRONT_PAGES: readonly string[] = ["catalog", "cart", "order"];
export const STOREFRONT_QR = { business: true, perItem: true } as const;

/** Neutral default theme; an LLM may PROPOSE a better one (validated, optional). */
export const DEFAULT_THEME = { primary: "#1f2937", accent: "#2563eb", background: "#ffffff", text: "#111827" } as const;

/** Money limits per role. Values come from the compiler options (owner-provided), never invented here. */
export interface RoleLimits {
  /** support / bookkeeper refund ceiling in cents. 0 = every refund goes to the owner. */
  maxRefundCents: { support: number; bookkeeper: number };
}

/** Roles with their limits. shopkeeper.maxDiscount mirrors the business's own maxDiscount policy. */
export function roles(maxDiscount: string, limits: RoleLimits): Role[] {
  const lim: Record<RoleId, Role["limits"]> = {
    owner: {},
    system: {},
    storefront: {},
    shopkeeper: { maxDiscount },
    support: { maxRefundCents: limits.maxRefundCents.support },
    bookkeeper: { maxRefundCents: limits.maxRefundCents.bookkeeper },
  };
  return ROLE_ORDER.map((id) => ({ id, permissions: [...ROLE_PERMISSIONS[id]], cannotApproveOwn: true, limits: lim[id] }));
}

/** Agent tool sets and escalation rules are fixed; only goal WORDING may be proposed by an LLM. */
export interface AgentTemplate {
  id: "shopkeeper" | "support" | "bookkeeper";
  defaultGoals: readonly string[];
  tools: readonly string[];
  escalationRules: readonly string[];
}

export const AGENT_TEMPLATES: readonly AgentTemplate[] = [
  {
    id: "shopkeeper",
    defaultGoals: ["sell the menu", "answer menu questions", "never sell below the margin floor"],
    tools: ["menu_lookup", "quote", "create_order", "escalate"],
    escalationRules: ["any discount request above policy", "any request to change prices or policies", "anything not covered by a precedent"],
  },
  {
    id: "support",
    defaultGoals: ["answer order status", "handle refunds within policy"],
    tools: ["order_status", "request_refund", "escalate"],
    escalationRules: ["refund outside the window", "refund above limit", "complaints"],
  },
  {
    id: "bookkeeper",
    defaultGoals: ["keep the books balanced", "reconcile Stripe", "approve refunds within policy"],
    tools: ["ledger_read", "approve_refund", "reconcile", "escalate"],
    escalationRules: ["any reconciliation mismatch", "anything unusual"],
  },
];

export function agents(roleList: readonly Role[], goals: Partial<Record<AgentTemplate["id"], string[]>> = {}): AgentDef[] {
  return AGENT_TEMPLATES.map((a) => ({
    id: a.id,
    role: a.id,
    goals: [...(goals[a.id] ?? a.defaultGoals)],
    tools: [...a.tools],
    limits: { ...(roleList.find((r) => r.id === a.id)?.limits ?? {}) },
    escalationRules: [...a.escalationRules],
  }));
}

/** Deep copies, so a compile can never mutate the template. */
export const documents = (): DocumentType[] => structuredClone(DOCUMENTS) as DocumentType[];
export const chartOfAccounts = (): Account[] => structuredClone(CHART_OF_ACCOUNTS) as Account[];
export const registers = (): Register[] => structuredClone(REGISTERS) as Register[];
