// Guard contract. Every agent tool call is checked against the ACTIVE configuration + precedents
// before it runs. The decision is a pure function of STRUCTURED inputs: free text (provenance.text,
// reasons, notes) is recorded for the owner but never read by a rule, so injected instructions have
// no path to change an outcome.

import type { Configuration } from "@napkin/schema";

export const SOURCES = ["owner_app", "owner_phone_verified", "customer", "order_note", "web_page", "agent"] as const;
export type Source = (typeof SOURCES)[number];

export interface GuardCall {
  /** role as the platform knows it (owner | system | storefront | shopkeeper | support | bookkeeper), identity hex */
  actor: { role: string; identity: string };
  businessId: string;
  tool: string;
  args: unknown;
  /** where the instruction behind this call came from; text is evidence only */
  provenance: { source: Source; text?: string };
}

export type Outcome = "allowed" | "refused" | "escalated";

export interface MaxAllowed {
  /** exact fraction, e.g. "49/75" (or an integer string) */
  discountRate?: string;
  /** the same value as a decimal for display (may end in "…") */
  discountRateDecimal?: string;
  /** the largest rate the platform accepts (whole basis points, its rate domain) that is <= discountRate, e.g. "0.6533" */
  discountRateBasisPoints?: string;
  refundCents?: string;
}

export interface GuardDecision {
  allow: boolean;
  outcome: Outcome;
  ruleIds: string[];
  reason: string;
  maxAllowed?: MaxAllowed;
  wouldChangeIf: string | null;
  /** the args after schema parsing (unknown keys dropped); the only args a wrapped tool ever sees */
  checkedArgs?: unknown;
  evidenceRefs: string[];
  inputsHash: string;
  /** set by the engine for escalations */
  escalation?: { kind: "inbox"; question: string } | { kind: "owner_statement"; text: string; diff: unknown };
}

export interface PrecedentRow {
  id: string;
  agentRole: string;
  rule: string;
  conditionJson: string;
}

/** Facts about an order's posted sale, computed by deterministic code from the stored sale document. */
export interface RefundFacts {
  orderId: string;
  saleTotal: string;
  saleNet: string;
  saleCost: string;
  refundedSoFarCents: bigint;
  hoursSinceSale: string;
}

export interface DocumentMeta {
  id: string;
  docType: string;
  status: string;
  createdByRole: string;
  createdByIdentity: string;
  totalCents: bigint;
}

/** Everything a rule may read. Loaded by the engine, passed to the pure evaluator. */
export interface GuardWorld {
  configId: string;
  config: Configuration;
  precedents: PrecedentRow[];
  refundFacts?: RefundFacts | undefined;
  document?: DocumentMeta | undefined;
}
