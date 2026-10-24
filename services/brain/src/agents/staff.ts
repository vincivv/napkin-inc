// The three AI staff. One entry point per use:
//   message()  customer chat with the Shopkeeper / Support (or the Bookkeeper), in-memory conversations
//   ask()      the owner asks the Bookkeeper a question; the answer cites ledger entries
//   audit()    the Bookkeeper audits a PROVIDED book set and reports findings with document refs
//
// The role and business are parameters of the call, fixed by the server route. The tools offered are the
// agent's configured list ∩ the guard registry (TOOLS) ∩ the implemented tools, and every call goes
// through wrapTool(guard) (napkin) or the BaselineGuard (red-team baseline only).

import { Guard, TOOLS, type GuardPlatformPort } from "../guards";
import { toolImpls, type StaffBackend } from "./backend";
import { BaselineGuard } from "./baseline";
import { parseFindings, type BookSet, type Finding } from "./books";
import { AGENT_MODEL } from "./llm";
import { runAgentTurn } from "./loop";
import { buildSystemPrompt, quoteUntrusted } from "./prompt";
import type { AgentLlm, AgentTurnResult, MessageParam, Mode, StaffRole } from "./types";

export class StaffError extends Error {
  override name = "StaffError";
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
  ) {
    super(message);
  }
}

/** In-memory conversations. Each history is append-only; turns of one conversation run one at a time. */
export class ConversationStore {
  private readonly map = new Map<string, { history: MessageParam[]; tail: Promise<unknown> }>();
  constructor(private readonly max = 500) {}

  history(key: string): MessageParam[] | undefined {
    return this.map.get(key)?.history;
  }

  run<T>(key: string, fn: (history: MessageParam[]) => Promise<T>): Promise<T> {
    let c = this.map.get(key);
    if (!c) {
      if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value!);
      c = { history: [], tail: Promise.resolve() };
      this.map.set(key, c);
    }
    const conv = c;
    const next = conv.tail.then(() => fn(conv.history));
    conv.tail = next.catch(() => undefined);
    return next;
  }
}

export interface StaffDeps {
  llm: AgentLlm;
  /** config, precedents and DecisionRecords (the same port the guard reads) */
  guardPort: GuardPlatformPort;
  backend: StaffBackend;
  model?: string;
  maxIterations?: number;
  conversations?: ConversationStore;
}

const ASK_TOOLS = ["ledger_read", "reconcile", "escalate"];
const AUDIT_TOOLS = ["ledger_read", "reconcile"];

export interface MessageInput {
  role: StaffRole;
  businessId: string;
  conversationId: string;
  text: string;
  mode?: Mode;
}

export class Staff {
  readonly conversations: ConversationStore;
  private readonly guard: Guard;
  private readonly baseline: BaselineGuard;

  constructor(private readonly deps: StaffDeps) {
    this.conversations = deps.conversations ?? new ConversationStore();
    this.guard = new Guard(deps.guardPort);
    this.baseline = new BaselineGuard(deps.guardPort);
  }

  private async world(role: StaffRole, businessId: string) {
    await this.deps.guardPort.ready?.();
    const active = this.deps.guardPort.activeConfiguration(businessId);
    if (!active) throw new StaffError(409, `business ${businessId} has no active configuration`);
    const agent = active.config.agents.find((a) => a.role === role);
    if (!agent) throw new StaffError(404, `the configuration has no ${role} agent`);
    return { config: active.config, agent, precedents: this.deps.guardPort.precedents(businessId) };
  }

  private async turn(o: { role: StaffRole; businessId: string; mode: Mode; history: MessageParam[]; text: string; quoted: string; restrict?: string[]; books?: BookSet; audit?: boolean; maxTokens?: number }): Promise<AgentTurnResult> {
    const { config, agent, precedents } = await this.world(o.role, o.businessId);
    const impls = toolImpls({ role: o.role, businessId: o.businessId, config, backend: this.deps.backend, books: o.books });
    const offered = agent.tools.filter((t) => Object.hasOwn(TOOLS, t) && Object.hasOwn(impls, t) && (!o.restrict || o.restrict.includes(t)));
    return runAgentTurn(
      {
        history: o.history,
        system: buildSystemPrompt(config, o.role, precedents, { audit: o.audit ?? false }),
        offered,
        impls,
        actor: { role: o.role, identity: this.deps.backend.identity(o.role, o.businessId) ?? `unheld:${o.role}@${o.businessId}` },
        businessId: o.businessId,
        source: "customer",
        rawText: o.text,
        userContent: o.quoted,
      },
      {
        llm: this.deps.llm,
        guard: o.mode === "baseline" ? this.baseline : this.guard,
        recorder: this.deps.guardPort,
        model: this.deps.model ?? AGENT_MODEL,
        ...(this.deps.maxIterations ? { maxIterations: this.deps.maxIterations } : {}),
        ...(o.maxTokens ? { maxTokens: o.maxTokens } : {}),
        effort: "medium",
      },
    );
  }

  /** A customer (or staff) chat turn. Conversations are keyed by mode, business, role and conversationId. */
  message(m: MessageInput): Promise<AgentTurnResult> {
    const mode = m.mode ?? "napkin";
    const key = `${mode}|${m.businessId}|${m.role}|${m.conversationId}`;
    // Chat callers are unauthenticated, so the Bookkeeper's chat gets read tools + escalate only (no approve_refund).
    const restrict = m.role === "bookkeeper" ? ASK_TOOLS : undefined;
    return this.conversations.run(key, (history) => this.turn({ role: m.role, businessId: m.businessId, mode, history, text: m.text, quoted: quoteUntrusted(m.text, "customer_message"), ...(restrict ? { restrict } : {}) }));
  }

  /** The owner asks the Bookkeeper. Read-only tools; refs are only ids that appeared in the tool output. */
  async ask(a: { businessId: string; question: string }): Promise<AgentTurnResult & { answer: string; refs: string[]; unverifiedRefs: string[] }> {
    const r = await this.turn({ role: "bookkeeper", businessId: a.businessId, mode: "napkin", history: [], text: a.question, quoted: quoteUntrusted(a.question, "owner_question"), restrict: ASK_TOOLS });
    const seen = new Set<string>();
    for (const c of r.toolCalls) collectDocIds(c.result, seen);
    const cited = [...new Set([...r.reply.matchAll(/\[doc ([A-Za-z0-9_-]{1,64})\]/g)].map((m) => m[1]!))];
    return { ...r, answer: r.reply, refs: cited.filter((id) => seen.has(id)), unverifiedRefs: cited.filter((id) => !seen.has(id)) };
  }

  /** The Bookkeeper audits a provided book set. DecisionRecords go to `businessId` (mode picks it). */
  async audit(books: BookSet, opts: { businessId: string; mode?: Mode }): Promise<AgentTurnResult & { findings: Finding[] }> {
    const r = await this.turn({
      role: "bookkeeper",
      businessId: opts.businessId,
      mode: opts.mode ?? "napkin",
      history: [],
      text: `audit ${books.label}`,
      quoted: `Audit the provided books (${books.label}). Use ledger_read and reconcile, then report your findings in the required format.`,
      restrict: AUDIT_TOOLS,
      books,
      audit: true,
      maxTokens: 32000,
    });
    return { ...r, findings: parseFindings(r.reply) };
  }
}

function collectDocIds(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) for (const x of v) collectDocIds(x, out);
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Array.isArray(o["journal"]) && typeof o["id"] === "string") out.add(o["id"]);
    if (typeof o["document"] === "string") out.add(o["document"]);
    for (const x of Object.values(o)) collectDocIds(x, out);
  }
}
