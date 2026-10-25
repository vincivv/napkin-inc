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

/**
 * Everyday expenses (rent, supplies, wages, utilities...). A posting rule's target account is a constant, so
 * the category picks its account through a NUMERIC line field: line.account holds the expense account code,
 * one debit rule per code fires `when line.account == <code>`, and the expense_account check refuses any
 * other value. An expense can therefore only ever debit these accounts and credit the paying side
 * (doc.paidFrom: 1000 paid now, 2000 owed to the supplier). With the checks skipped (red-team baseline) a
 * foreign code still matches no debit rule, so the posting is unbalanced and refused (invariant 1).
 */
export const EXPENSE_CATEGORIES = [
  { code: "6000", name: "Rent", category: "rent" },
  { code: "6100", name: "Supplies", category: "supplies" },
  { code: "6200", name: "Wages", category: "wages" },
  { code: "6300", name: "Utilities", category: "utilities" },
  { code: "6900", name: "Other expenses", category: "other" },
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["category"];
/** The paying side of an expense: doc.paidFrom holds one of these account codes. */
export const EXPENSE_PAID_FROM = [
  { code: "1000", ruleId: "expense.cash", memo: "paid now" },
  { code: "2000", ruleId: "expense.payable", memo: "owed to supplier" },
] as const;

const anyOf = (ref: string, codes: readonly { code: string }[]) => codes.map((c) => `${ref} == ${c.code}`).join(" || ");

const EXPENSE: DocumentType = {
  id: "expense",
  name: "Expense",
  approval: {
    creatorRoles: ["owner"],
    approverRoles: ["owner"],
    cannotApproveOwn: false,
    postOn: "create",
    note: "recorded by the owner only (AI staff never), optionally pre-filled from a receipt photo the owner checks; line.account is the expense account code, doc.paidFrom is 1000 (paid now) or 2000 (owed to the supplier)",
  },
  fields: [
    { name: "vendor", type: "string" },
    { name: "date", type: "string", required: true },
    { name: "paidFrom", type: "number", required: true },
    { name: "receiptRef", type: "string" },
  ],
  lineFields: [
    { name: "account", type: "number", required: true },
    { name: "amount", type: "money", required: true },
    { name: "description", type: "string" },
  ],
  derived: [{ name: "total", scope: "doc", expr: "sum(line.amount)" }],
  checks: [
    { id: "amount_positive", scope: "line", assert: "line.amount > 0", message: "each expense amount must be positive" },
    {
      id: "expense_account",
      scope: "line",
      assert: anyOf("line.account", EXPENSE_CATEGORIES),
      message: `an expense can only be booked to an expense account (${EXPENSE_CATEGORIES.map((c) => `${c.code} ${c.name}`).join(", ")})`,
    },
    { id: "total_positive", scope: "doc", assert: "doc.total > 0", message: "an expense needs at least one amount" },
    { id: "paid_from", scope: "doc", assert: anyOf("doc.paidFrom", EXPENSE_PAID_FROM), message: "an expense is either paid now (1000) or owed to the supplier (2000)" },
  ],
  postingRules: [
    ...EXPENSE_CATEGORIES.map((c) => ({
      id: `expense.${c.category}`,
      scope: "line" as const,
      target: { kind: "account" as const, code: c.code },
      side: "debit" as const,
      amountExpr: "line.amount",
      when: `line.account == ${c.code}`,
      memo: c.name.toLowerCase(),
    })),
    ...EXPENSE_PAID_FROM.map((p) => ({
      id: p.ruleId,
      scope: "doc" as const,
      target: { kind: "account" as const, code: p.code },
      side: "credit" as const,
      amountExpr: "doc.total",
      when: `doc.paidFrom == ${p.code}`,
      memo: p.memo,
    })),
  ],
};

/**
 * The owner changes stock by hand: "Stock added" (a delivery, a fresh batch) and "Stock removed" (spoiled,
 * broken, given away, a recount). Owner-only, post on create, like an expense: the platform still refuses
 * removing more than is on hand (the stock register never goes negative). An addition is paid now (1000),
 * owed to the supplier (2000) or put in by the owner personally (3000); a removal is written off to 5200.
 */
export const STOCK_ADDED_PAID_FROM = [
  { code: "1000", ruleId: "added.cash", memo: "paid now" },
  { code: "2000", ruleId: "added.payable", memo: "owed to supplier" },
  { code: "3000", ruleId: "added.owner", memo: "put in by the owner" },
] as const;
export const STOCK_WRITE_OFF = { code: "5200", name: "Stock written off" } as const;

const STOCK_LINE_FIELDS: DocumentType["lineFields"] = [
  { name: "stockItem", type: "string", required: true },
  { name: "qty", type: "qty", required: true },
  { name: "unitCost", type: "money", required: true },
];
const STOCK_LINE_CHECKS: DocumentType["checks"] = [
  { id: "qty_positive", scope: "line", assert: "line.qty >= 1", message: "quantity must be at least 1" },
  { id: "cost_nonneg", scope: "line", assert: "line.unitCost >= 0", message: "unit cost cannot be negative" },
];
const ownerOnly = (note: string): DocumentType["approval"] => ({ creatorRoles: ["owner"], approverRoles: ["owner"], cannotApproveOwn: false, postOn: "create", note });

const STOCK_ADDED: DocumentType = {
  id: "stock_added",
  name: "Stock added",
  approval: ownerOnly("the owner adds stock by hand (a delivery, a fresh batch); doc.paidFrom is 1000 paid now, 2000 owed to the supplier or 3000 put in by the owner"),
  fields: [
    { name: "supplier", type: "string" },
    { name: "paidFrom", type: "number", required: true },
  ],
  lineFields: STOCK_LINE_FIELDS,
  derived: [{ name: "value", scope: "line", expr: "line.qty * line.unitCost" }],
  checks: [
    ...STOCK_LINE_CHECKS,
    { id: "paid_from", scope: "doc", assert: anyOf("doc.paidFrom", STOCK_ADDED_PAID_FROM), message: "added stock is paid now (1000), owed to the supplier (2000) or put in by the owner (3000)" },
  ],
  postingRules: [
    { id: "added.inventory", scope: "line", target: { kind: "account", code: "1300" }, side: "debit", amountExpr: "line.value", memo: "stock added" },
    ...STOCK_ADDED_PAID_FROM.map((p) => ({
      id: p.ruleId,
      scope: "line" as const,
      target: { kind: "account" as const, code: p.code },
      side: "credit" as const,
      amountExpr: "line.value",
      when: `doc.paidFrom == ${p.code}`,
      memo: p.memo,
    })),
    { id: "added.stock_in", scope: "line", target: { kind: "register", id: "stock", dims: { item: "line.stockItem" } }, side: "in", amountExpr: "line.value", qtyExpr: "line.qty" },
  ],
};

const STOCK_REMOVED: DocumentType = {
  id: "stock_removed",
  name: "Stock removed",
  approval: ownerOnly("the owner takes stock out by hand (spoiled, broken, given away, a recount); written off at its unit cost"),
  fields: [{ name: "reason", type: "string", required: true }],
  lineFields: STOCK_LINE_FIELDS,
  derived: [{ name: "value", scope: "line", expr: "line.qty * line.unitCost" }],
  checks: STOCK_LINE_CHECKS,
  postingRules: [
    { id: "removed.write_off", scope: "line", target: { kind: "account", code: STOCK_WRITE_OFF.code }, side: "debit", amountExpr: "line.value", memo: "stock written off" },
    { id: "removed.inventory", scope: "line", target: { kind: "account", code: "1300" }, side: "credit", amountExpr: "line.value", memo: "stock removed" },
    { id: "removed.stock_out", scope: "line", target: { kind: "register", id: "stock", dims: { item: "line.stockItem" } }, side: "out", amountExpr: "line.value", qtyExpr: "line.qty" },
  ],
};

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
  EXPENSE,
  STOCK_ADDED,
  STOCK_REMOVED,
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
  { code: STOCK_WRITE_OFF.code, name: STOCK_WRITE_OFF.name, type: "expense" },
  ...EXPENSE_CATEGORIES.map((c) => ({ code: c.code, name: c.name, type: "expense" as const })),
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
