// Shared data contracts. zod schemas are the source of truth; TS types are inferred and
// JSON Schemas are emitted from them (pnpm --filter @napkin/schema jsonschema).

import { z } from "zod";

// ---------- primitives ----------
/** Exact decimal as a string ("3.00", "0.2"). Never a JS float in money paths. */
export const Decimal = z.string().regex(/^-?\d+(\.\d+)?$/, "exact decimal string");
export const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:@-]+$/);

// ---------- Fact<T> ----------
export const Provenance = z.enum(["owner_said", "paper", "inferred"]);
export type Provenance = z.infer<typeof Provenance>;

export const FactSource = z.object({
  kind: z.enum(["photo", "voice", "chat", "phone"]),
  ref: z.string(),
  /** photo region the fact was read from, normalized 0..1 (approximate, from the vision model) */
  region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).optional(),
  quote: z.string().optional(),
});

export const Fact = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    provenance: Provenance,
    confidence: z.number().min(0).max(1),
    source: FactSource,
    confirmed: z.boolean(),
  });
export type Fact<T> = { value: T; provenance: Provenance; confidence: number; source: z.infer<typeof FactSource>; confirmed: boolean };

/** A fact may drive a money decision only if the owner confirmed it, or it was read from paper and confirmed. */
export function usableForMoney(f: Fact<unknown>): boolean {
  return f.confirmed && f.provenance !== "inferred";
}

// ---------- BusinessSpec ----------
const FStr = Fact(z.string());
const FDec = Fact(Decimal);
const FBool = Fact(z.boolean());

export const PricedOption = z.object({ name: FStr, price: FDec, cost: FDec });

export const Offering = z.object({
  id: Id,
  name: FStr,
  description: FStr.optional(),
  variants: z.array(PricedOption.extend({ id: Id, stockUnits: FDec.optional() })).min(1),
  addOns: z.array(PricedOption.extend({ id: Id })),
  stockTracked: FBool,
  initialStock: Fact(z.number().int().min(0)).optional(),
});

export const OpenQuestion = z.object({
  id: Id,
  fieldPath: z.string(),
  question: z.string(),
  impactScore: z.number().min(0),
  moneyRelevant: z.boolean(),
  status: z.enum(["open", "asked", "answered", "dismissed"]),
  candidates: z.array(z.string()).optional(),
  answer: z.string().optional(),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

export const SpecExample = z.object({
  kind: z.enum(["sale", "refund", "purchase"]),
  inputs: z.record(z.string(), z.unknown()),
  expectedPostings: z.array(z.object({ account: z.string(), side: z.enum(["debit", "credit"]), amount: Decimal })),
  source: FactSource,
});

export const BusinessSpec = z.object({
  business: z.object({ name: FStr, oneLiner: FStr, community: FStr, location: FStr, hours: FStr, timezone: FStr }),
  pattern: z.literal("item_seller"),
  offerings: z.array(Offering).min(1),
  policies: z.object({
    currency: Fact(z.literal("USD")),
    taxRate: FDec,
    marginFloorPct: FDec,
    refundWindowHours: FDec,
    refundMethod: FStr,
    maxDiscountPct: FDec,
    couponsAllowed: FBool,
    paymentMethods: Fact(z.array(z.literal("card"))),
  }),
  operations: z.object({
    fulfillment: Fact(z.enum(["pickup", "delivery"])),
    pickupLocation: FStr,
    suppliers: z.array(z.object({ name: FStr, items: Fact(z.array(z.string())) })),
  }),
  examples: z.array(SpecExample),
  openQuestions: z.array(OpenQuestion),
});
export type BusinessSpec = z.infer<typeof BusinessSpec>;

// ---------- Configuration ----------
const Scalar = z.union([z.string(), z.number()]);
const FieldDef = z.object({ name: z.string(), type: z.enum(["number", "string", "money", "rate", "qty"]), required: z.boolean().optional() });
const Scope = z.enum(["doc", "line"]);

export const PostingRule = z.object({
  id: Id,
  scope: Scope,
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("account"), code: z.string() }),
    z.object({ kind: z.literal("register"), id: Id, dims: z.record(z.string(), z.string()).optional() }),
  ]),
  side: z.enum(["debit", "credit", "in", "out"]),
  amountExpr: z.string(),
  qtyExpr: z.string().optional(),
  when: z.string().optional(),
  memo: z.string().optional(),
});

export const DocumentType = z.object({
  id: Id,
  name: z.string(),
  approval: z.object({
    creatorRoles: z.array(Id),
    approverRoles: z.array(Id),
    cannotApproveOwn: z.boolean(),
    /** when the platform posts it: on create (machine docs), on approve, or on payment (sales) */
    postOn: z.enum(["create", "approve", "payment"]),
    note: z.string().optional(),
  }),
  fields: z.array(FieldDef),
  lineFields: z.array(FieldDef),
  derived: z.array(z.object({ name: z.string(), scope: Scope, expr: z.string() })),
  checks: z.array(z.object({ id: Id, scope: Scope, assert: z.string(), message: z.string() })),
  postingRules: z.array(PostingRule),
});
export type DocumentType = z.infer<typeof DocumentType>;

export const Catalog = z.object({
  id: Id,
  name: z.string(),
  lineKey: z.string(),
  fields: z.array(FieldDef),
  entries: z.array(z.object({ id: Id, data: z.record(z.string(), z.union([Scalar, z.boolean(), z.null()])) })),
});

export const Register = z.object({
  id: Id,
  name: z.string(),
  kind: z.enum(["balance", "turnover"]),
  dimensions: z.array(z.string()),
  resources: z.array(z.string()),
  allowNegative: z.boolean(),
});

export const Account = z.object({ code: z.string(), name: z.string(), type: z.enum(["asset", "liability", "equity", "revenue", "contra_revenue", "expense"]) });

export const Role = z.object({
  id: Id,
  permissions: z.array(z.string()),
  cannotApproveOwn: z.boolean(),
  limits: z.record(z.string(), Scalar),
});

export const AgentDef = z.object({
  id: Id,
  role: Id,
  goals: z.array(z.string()),
  tools: z.array(z.string()),
  limits: z.record(z.string(), Scalar),
  escalationRules: z.array(z.string()),
});

export const ProofResult = z.object({
  status: z.enum(["proved", "failed", "skipped"]),
  durationMs: z.number().optional(),
  details: z.array(
    z.object({
      subject: z.string(), // e.g. "sale" or "sale/cookie_box6"
      status: z.enum(["proved", "failed"]),
      counterexample: z.record(z.string(), z.string()).optional(),
      message: z.string().optional(),
      suggestedFix: z.string().optional(),
    }),
  ),
});

export const ProofReport = z.object({
  balanceProof: ProofResult,
  discountProof: ProofResult,
  flowCheck: ProofResult,
  synthesisLog: z.array(z.string()),
  generatedAt: z.string(),
  solver: z.string().optional(),
});
export type ProofReport = z.infer<typeof ProofReport>;

export const Configuration = z.object({
  id: z.string(),
  businessId: Id,
  version: z.number().int().min(1),
  pattern: z.literal("item_seller"),
  source: z.string().optional(),
  _unconfirmed: z.object({ note: z.string(), paths: z.array(z.string()) }).optional(),
  business: z.object({ name: z.string(), slug: z.string().regex(/^[a-z0-9-]+$/), oneLiner: z.string(), community: z.string().optional(), pickupLocation: z.string(), hours: z.string(), timezone: z.string() }),
  catalogs: z.array(Catalog),
  initialStock: z.record(z.string(), z.number().int().min(0)).optional(),
  chartOfAccounts: z.array(Account),
  registers: z.array(Register),
  policies: z.object({
    currency: z.literal("USD"),
    taxRate: Decimal,
    marginFloor: Decimal,
    refundWindowHours: Decimal,
    refundMethod: z.string(),
    maxDiscount: Decimal,
    couponsAllowed: z.boolean(),
    maxCouponsPerOrder: z.number().int().min(0),
    backordersAllowed: z.boolean(),
    paymentMethods: z.array(z.literal("card")),
    fulfillment: z.enum(["pickup", "delivery"]),
  }),
  documents: z.array(DocumentType),
  roles: z.array(Role),
  agents: z.array(AgentDef),
  storefront: z.object({
    theme: z.object({ primary: z.string(), accent: z.string(), background: z.string(), text: z.string(), emoji: z.string().optional(), font: z.string().optional() }),
    headline: z.string(),
    tagline: z.string(),
    pages: z.array(z.string()),
    qr: z.object({ business: z.boolean(), perItem: z.boolean() }),
  }),
  reports: z.array(z.string()),
  proofReport: ProofReport.optional(),
});
export type Configuration = z.infer<typeof Configuration>;

// ---------- DecisionRecord ----------
export const DecisionRecord = z.object({
  id: z.string(),
  actor: z.object({ kind: z.enum(["agent", "owner", "system"]), id: z.string() }),
  action: z.string(),
  documentRef: z.string().nullable(),
  ruleIds: z.array(z.string()),
  evidenceRefs: z.array(z.string()),
  inputsHash: z.string(),
  outcome: z.enum(["allowed", "refused", "escalated", "executed", "failed"]),
  reason: z.string(),
  wouldChangeIf: z.string().nullable(),
  timestamp: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

// ---------- validation helpers ----------
export class ContractError extends Error {
  constructor(
    readonly contract: string,
    readonly issues: z.core.$ZodIssue[],
  ) {
    super(`${contract} invalid: ${issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    this.name = "ContractError";
  }
}

function validator<T extends z.ZodType>(name: string, schema: T) {
  return (x: unknown): z.infer<T> => {
    const r = schema.safeParse(x);
    if (!r.success) throw new ContractError(name, r.error.issues);
    return r.data;
  };
}

export const parseBusinessSpec = validator("BusinessSpec", BusinessSpec);
export const parseConfiguration = validator("Configuration", Configuration);
export const parseDecisionRecord = validator("DecisionRecord", DecisionRecord);
export const parseProofReport = validator("ProofReport", ProofReport);

export * from "./semantic";
export * from "./storefront-design";
