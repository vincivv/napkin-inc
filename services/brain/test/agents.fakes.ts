// Fakes for the agent tests: a scripted LLM, the guard's platform port, and a recording StaffBackend.
// The Maya fixture's costs are PLACEHOLDERS (see its _unconfirmed block); used here only as TEST data.

import { parseConfiguration, type Configuration } from "@napkin/schema";
import maya from "../../../fixtures/maya/configuration.json";
import type { DecisionWrite, DocumentMeta, GuardPlatformPort, PrecedentRow, RefundFacts } from "../src/guards";
import type { StaffBackend } from "../src/agents/backend";
import type { BookSet } from "../src/agents/books";
import type { AgentLlm, AgentRequest, AgentResponse, ContentBlock, StaffRole } from "../src/agents/types";

export const cfg: Configuration = parseConfiguration(maya);

export class FakeGuardPort implements GuardPlatformPort {
  decisions: { asRole: string; d: DecisionWrite }[] = [];
  inbox: { asRole: string; question: string; documentRef: string }[] = [];
  statements: { text: string }[] = [];
  precedentRows: PrecedentRow[] = [];
  facts = new Map<string, RefundFacts>();
  docs = new Map<string, DocumentMeta>();
  config: Configuration | undefined = cfg;
  activeConfiguration() { return this.config ? { configId: "1", config: this.config } : undefined; }
  precedents() { return this.precedentRows; }
  refundFacts(_b: string, orderId: string) { return this.facts.get(orderId); }
  documentMeta(_b: string, id: string) { return this.docs.get(id); }
  async recordDecision(asRole: string, d: DecisionWrite) { this.decisions.push({ asRole, d }); }
  async openInbox(asRole: string, i: { question: string; documentRef: string }) { this.inbox.push({ asRole, question: i.question, documentRef: i.documentRef }); }
  async queueOwnerStatement(s: { text: string }) { this.statements.push(s); }
}

export type Mutation =
  | { kind: "order"; businessId: string; lines: { productId: string; qty: number }[]; discountRate: string; customerName: string; couponCode: string }
  | { kind: "refund"; role: StaffRole; orderId: string; amountCents: number }
  | { kind: "approve"; role: StaffRole; documentId: string }
  | { kind: "inbox"; role: StaffRole; question: string };

export class FakeBackend implements StaffBackend {
  mutations: Mutation[] = [];
  books_: BookSet = { label: "fake live books", documents: [], periods: [], processorStatement: [], statementSource: "fake" };
  failNext: Error | undefined;
  identity(role: StaffRole) { return `id-${role}`; }
  async createOrder(i: { businessId: string; lines: { productId: string; qty: number }[]; customerName: string; discountRate: string; couponCode: string }) {
    this.check();
    this.mutations.push({ kind: "order", ...i });
    const orderId = `MC-T${this.mutations.length}`;
    return { orderId, totalCents: "0", payUrl: `http://localhost:3002/${i.businessId}/order/${orderId}?simulate=1`, simulated: true };
  }
  orderStatus(_b: string, orderId: string) {
    return orderId === "MC-A1" ? { orderId, status: "paid", totalCents: "4000", paidCents: "4000", refundedCents: "0", channel: "storefront" } : undefined;
  }
  async requestRefund(role: StaffRole, _b: string, a: { orderId: string; amountCents: number }) { this.check(); this.mutations.push({ kind: "refund", role, orderId: a.orderId, amountCents: a.amountCents }); return { documentId: "77" }; }
  async approveRefund(role: StaffRole, _b: string, documentId: string) { this.check(); this.mutations.push({ kind: "approve", role, documentId }); }
  async openInbox(role: StaffRole, _b: string, i: { question: string }) { this.check(); this.mutations.push({ kind: "inbox", role, question: i.question }); }
  async books() { return this.books_; }
  private check() {
    const e = this.failNext;
    this.failNext = undefined;
    if (e) throw e;
  }
}

/** A $40.00 paid sale (2 boxes + 3 singles + 1 sea salt at the fixture's TEST prices), 1 hour old. */
export const ORDER_40: RefundFacts = { orderId: "MC-A1", saleTotal: "40", saleNet: "40", saleCost: "61/5", refundedSoFarCents: 0n, hoursSinceSale: "1" };

let ids = 0;
export const toolUse = (name: string, input: unknown, id = `toolu_${++ids}`): ContentBlock => ({ type: "tool_use", id, name, input, caller: { type: "direct" } } as unknown as ContentBlock);
export const text = (t: string): ContentBlock => ({ type: "text", text: t, citations: null } as unknown as ContentBlock);
export const thinking = (t: string, signature: string): ContentBlock => ({ type: "thinking", thinking: t, signature } as ContentBlock);

export const resp = (content: ContentBlock[], stop_reason: AgentResponse["stop_reason"] = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn"): AgentResponse => ({ content, stop_reason, stop_details: null });

/** Scripted model: returns the next response; records every request (messages deep-copied as JSON). */
export class ScriptedLlm implements AgentLlm {
  requests: (AgentRequest & { snapshot: string })[] = [];
  constructor(private readonly script: (AgentResponse | ((req: AgentRequest, i: number) => AgentResponse))[]) {}
  async create(req: AgentRequest): Promise<AgentResponse> {
    const i = this.requests.length;
    this.requests.push({ ...req, snapshot: JSON.stringify(req.messages) });
    const step = this.script[i] ?? resp([text("(script ended)")]);
    return typeof step === "function" ? step(req, i) : step;
  }
}
