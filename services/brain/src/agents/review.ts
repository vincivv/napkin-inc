// Automatic Bookkeeper review: the owner hears about problems in the books without asking first.
//
//   trigger (timer, or new documents posted, debounced) -> reconcile (deterministic) -> findings
//   -> nothing found: done | same findings already reported: done | new: ONE owner inbox item
//
// Findings and their wording are computed by code from the reconcile facts (no model call, so nothing is
// invented). The inbox item is opened through the guarded `escalate` tool as the business's own
// bookkeeper identity, so the guard checks it and writes a DecisionRecord exactly like an agent call.
// Dedupe: a fingerprint of the findings is kept in memory per business and stored in the inbox item's
// contextJson; an open item with the same fingerprint means "already reported".
// Off unless started (server.ts starts it; tests never do unless they build a scheduler themselves).

import { createHash } from "node:crypto";
import type { Configuration } from "@napkin/schema";
import { productCatalog } from "../compiler/dryrun";
import { Guard, wrapTool, type GuardDecision, type GuardPlatformPort } from "../guards";
import { log } from "../log";
import type { StaffBackend } from "./backend";
import { reconcile, type BookSet } from "./books";

/** One problem, already worded for the owner. `key` identifies the problem (not its details) for dedupe. */
export interface ReviewFinding {
  key: string;
  text: string;
  docs: string[];
}

export type ReviewOutcome =
  | { status: "skipped"; reason: string }
  | { status: "clean" }
  | { status: "duplicate"; fingerprint: string }
  | { status: "reported"; fingerprint: string; question: string; outcome: GuardDecision["outcome"] }
  | { status: "not_allowed"; fingerprint: string; reason: string };

/** the live backend reads at most this many documents; above it, totals over all history are not trusted */
const DOC_WINDOW = 300;
const MAX_POINTS = 8;
const MAX_QUESTION = 2000; // the escalate tool's question limit

const PROCESSOR_DOCS: Record<string, string> = { payment_received: "card payment", processor_fee: "Stripe fee", refund: "refund", payout: "payout to the bank" };
const STATEMENT_WORDS: Record<string, string> = { payment_succeeded: "card payment", fee: "Stripe fee", refund_succeeded: "refund", payout: "payout" };

const money = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
const cite = (id: string) => `[doc ${id}]`;

function words(cfg: Configuration) {
  const docName = (docType: string) => {
    const n = (cfg.documents.find((d) => d.id === docType)?.name ?? docType.replace(/_/g, " ")).toLowerCase();
    return `${/^[aeiou]/.test(n) ? "an" : "a"} ${n}`;
  };
  const account = (code: string) => cfg.chartOfAccounts.find((a) => a.code === code)?.name ?? "an account";
  const stockCat = cfg.catalogs.find((c) => c.lineKey === "stockItem");
  const stockName = (item: string) => String(stockCat?.entries.find((e) => e.id === item)?.data["name"] ?? item.replace(/_/g, " "));
  let products: { name: string; item: string; units: string }[] = [];
  try {
    products = productCatalog(cfg).entries.map((e) => ({ name: String(e.data["name"] ?? e.id), item: String(e.data["stockItem"] ?? ""), units: String(e.data["stockUnits"] ?? "") }));
  } catch {
    /* no product catalog: no per-product wording */
  }
  return { docName, account, stockName, products };
}

/** Deterministic findings from the reconcile facts, in plain words (names, not account numbers or field names). */
export function reviewFindings(books: BookSet, cfg: Configuration): ReviewFinding[] {
  const facts = reconcile(books);
  const w = words(cfg);
  const byId = new Map(books.documents.map((d) => [d.id, d]));
  const name = (id: string) => (byId.get(id) ? ` (${w.docName(byId.get(id)!.docType)})` : "");
  // the newest documents only: whole-history comparisons (statement, Stripe balance, stock) would be wrong
  const partial = books.documents.length >= DOC_WINDOW;
  const out: ReviewFinding[] = [];

  for (const u of facts.unbalancedDocuments) {
    out.push({ key: `unbalanced:${u.document}`, docs: [u.document], text: `${cite(u.document)}${name(u.document)} does not add up: its two sides are ${money(u.debitCents)} and ${money(u.creditCents)}, and they must be equal.` });
  }

  const several = new Set(facts.severalDocumentsForOneStatementEvent.map((m) => m.eventId));
  for (const m of facts.severalDocumentsForOneStatementEvent) {
    const ids = m.documents.map((d) => d.id);
    out.push({ key: `several:${m.eventId}`, docs: ids, text: `Stripe reported one ${STATEMENT_WORDS[m.kind] ?? "event"} of ${money(m.statementCents)}${m.orderId ? ` for order ${m.orderId}` : ""}, but the books record it ${ids.length} times: ${ids.map(cite).join(", ")}. One of them is probably a duplicate.` });
  }
  for (const m of facts.amountDifferences) {
    if (several.has(m.eventId)) continue;
    for (const d of m.documents.filter((x) => x.amountCents !== m.statementCents)) {
      out.push({ key: `amount:${m.eventId}:${d.id}`, docs: [d.id], text: `Stripe reported a ${STATEMENT_WORDS[m.kind] ?? "payment"} of ${money(m.statementCents)}${m.orderId ? ` for order ${m.orderId}` : ""}, but ${cite(d.id)} records ${money(d.amountCents ?? 0)}.` });
    }
  }
  for (const d of facts.processorDocumentsWithoutStatementEvent) {
    out.push({ key: `nostmt:${d.document}`, docs: [d.document], text: `${cite(d.document)} records a ${PROCESSOR_DOCS[d.docType] ?? "processor entry"} of ${money(d.amountCents ?? 0)} that Stripe never reported.` });
  }
  if (!partial) {
    for (const m of facts.statementWithoutDocument) {
      const sale = m.orderId ? books.documents.find((d) => d.docType === "sale" && (d.fields["orderId"] === m.orderId || d.externalRef === m.orderId || d.externalRef === `order:${m.orderId}`)) : undefined;
      out.push({ key: `nodoc:${m.eventId}`, docs: sale ? [sale.id] : [], text: `Stripe reported a ${STATEMENT_WORDS[m.kind] ?? "payment"} of ${money(m.statementCents)}${m.orderId ? ` for order ${m.orderId}` : ""}, but the books have no record of it${sale ? ` (the order's sale is ${cite(sale.id)})` : ""}.` });
    }
    // a Stripe balance that differs with no processor mismatch: something else was posted to it
    if (facts.clearing1010.differenceCents !== 0 && out.every((f) => !/^(several|amount|nostmt|nodoc):/.test(f.key))) {
      const others = books.documents.filter((d) => (d.status === "posted" || d.status === "reversed") && !PROCESSOR_DOCS[d.docType] && d.journal.some((j) => j.account === "1010"));
      for (const d of others) {
        out.push({ key: `clearing:${d.id}`, docs: [d.id], text: `${cite(d.id)}${name(d.id)} changed the ${w.account("1010")} balance, which only Stripe itself should change; the books now differ from Stripe by ${money(facts.clearing1010.differenceCents)}.` });
      }
    }
    // cash that is below zero: money was paid out of Cash but nothing coming in is recorded
    const CASH = "1000";
    const cashCents = books.documents.reduce((t, d) => t + d.journal.filter((j) => j.account === CASH).reduce((u, j) => u + j.debitCents - j.creditCents, 0), 0);
    if (cashCents < 0) {
      const paidOut = books.documents
        .map((d) => ({ id: d.id, out: d.journal.filter((j) => j.account === CASH).reduce((u, j) => u + j.creditCents - j.debitCents, 0) }))
        .filter((x) => x.out > 0)
        .sort((a, b) => b.out - a.out)
        .slice(0, 3);
      out.push({
        key: "cash:negative",
        docs: paidOut.map((x) => x.id),
        text: `${w.account(CASH)} is at ${money(cashCents)}: ${paidOut.map((x) => `${cite(x.id)}${name(x.id)} paid ${money(x.out)}`).join(", ")} out of it, but no money coming in is recorded. If you paid with your own money, record it as paid out of your own pocket; if you put money into the business, record that deposit.`,
      });
    }
    // stock that is below zero now (not stock that dipped and was restocked)
    for (const b of facts.stockBalances.filter((s) => s.qty < 0)) {
      const at = facts.stockWentNegativeAt.filter((x) => x.item === b.item);
      const first = at[0]?.document;
      const last = at[at.length - 1]?.document;
      const item = /^stock:item=(.+)$/.exec(b.item)?.[1];
      const label = item ? w.stockName(item) : b.item.replace(/[:=,]/g, " ");
      const takes = item ? w.products.filter((p) => p.item === item && /^\d+$/.test(p.units) && p.units !== "0").map((p) => `each ${p.name} sale takes ${p.units} from it`) : [];
      const docs = [...new Set([first, last].filter((x): x is string => Boolean(x)))];
      out.push({
        key: `stock:${b.item}:${first ?? ""}`,
        docs,
        text: `${label} stock is below zero: the books show ${b.qty} left${last ? ` after ${cite(last)}` : ""}${first && first !== last ? `, and it first went below zero at ${cite(first)}` : ""}.${takes.length ? ` In your prices & rules, ${takes.join(" and ")}.` : ""} Either record the stock you actually have, or fix how much each sale takes.`,
      });
    }
  }
  for (const p of facts.closedPeriods) {
    if (!p.closedAt) continue;
    for (const d of books.documents.filter((x) => x.period === p.month && x.postedAt && x.postedAt > p.closedAt!)) {
      out.push({ key: `closed:${d.id}`, docs: [d.id], text: `${cite(d.id)}${name(d.id)} was posted into ${p.month} after that month was closed.` });
    }
  }
  return out;
}

export const fingerprint = (fs: ReviewFinding[]) => createHash("sha256").update(JSON.stringify(fs.map((f) => f.key).sort())).digest("hex").slice(0, 24);

/** The owner's inbox text: a one-sentence headline, numbered points on new lines, then what to do. */
export function reviewQuestion(fs: ReviewFinding[]): string {
  const head = `My automatic check of the books found ${fs.length === 1 ? "one thing" : `${fs.length} things`} that need${fs.length === 1 ? "s" : ""} your attention.`;
  const tail = "What to do: open each document named above in the owner app, fix or reverse the wrong ones, and reply here when done (or tell me why it is correct as it is).";
  for (let n = Math.min(fs.length, MAX_POINTS); n >= 1; n--) {
    const points = fs.slice(0, n).map((f, i) => `${i + 1}. ${f.text}`);
    if (fs.length > n) points.push(`${n + 1}. And ${fs.length - n} more like these; ask me for the full list.`);
    const q = [head, ...points, tail].join("\n");
    if (q.length <= MAX_QUESTION) return q;
  }
  return `${head}\n1. ${fs[0]!.text.slice(0, MAX_QUESTION - head.length - tail.length - 10)}\n${tail}`;
}

export interface BookkeeperReviewDeps {
  guardPort: GuardPlatformPort;
  backend: StaffBackend;
  /** businessId -> fingerprint last reported (in memory) */
  reported?: Map<string, string>;
}

export class BookkeeperReview {
  readonly reported: Map<string, string>;
  private readonly guard: Guard;
  private readonly running = new Set<string>();

  constructor(private readonly deps: BookkeeperReviewDeps) {
    this.reported = deps.reported ?? new Map();
    this.guard = new Guard(deps.guardPort);
  }

  /** One review of one business. Throws on platform errors (the scheduler logs them). */
  async review(businessId: string): Promise<ReviewOutcome> {
    if (this.running.has(businessId)) return { status: "skipped", reason: "a review of this business is already running" };
    this.running.add(businessId);
    try {
      return await this.run(businessId);
    } finally {
      this.running.delete(businessId);
    }
  }

  private async run(businessId: string): Promise<ReviewOutcome> {
    const { guardPort, backend } = this.deps;
    await guardPort.ready?.();
    const active = guardPort.activeConfiguration(businessId);
    if (!active) return { status: "skipped", reason: "no active configuration" };
    const agent = active.config.agents.find((a) => a.role === "bookkeeper");
    if (!agent?.tools.includes("reconcile") || !agent.tools.includes("escalate")) return { status: "skipped", reason: "the configuration's bookkeeper cannot reconcile and escalate" };
    const identity = backend.identity("bookkeeper", businessId);
    if (!identity) return { status: "skipped", reason: "the brain holds no bookkeeper identity for this business" };

    const findings = reviewFindings(await backend.books(businessId), active.config);
    if (findings.length === 0) {
      this.reported.delete(businessId); // a problem that comes back later is reported again
      return { status: "clean" };
    }
    const fp = fingerprint(findings);
    if (this.reported.get(businessId) === fp) return { status: "duplicate", fingerprint: fp };
    const open = (await backend.openInboxItems?.(businessId)) ?? [];
    if (open.some((i) => contextFingerprint(i.contextJson) === fp)) {
      this.reported.set(businessId, fp);
      return { status: "duplicate", fingerprint: fp };
    }

    const question = reviewQuestion(findings);
    const escalate = wrapTool(
      async (a: { question: string; documentRef?: string }, d: GuardDecision) => {
        await backend.openInbox("bookkeeper", businessId, { question: a.question, documentRef: a.documentRef ?? "", contextJson: JSON.stringify({ tool: "escalate", source: "bookkeeper_review", reviewFingerprint: fp, inputsHash: d.inputsHash }) });
        return { status: "escalated_to_owner" };
      },
      this.guard,
      "escalate",
    );
    const documentRef = findings.find((f) => f.docs.length)?.docs[0] ?? "";
    const r = await escalate({
      actor: { role: "bookkeeper", identity },
      businessId,
      args: { question, ...(documentRef ? { documentRef } : {}) },
      provenance: { source: "agent", text: "automatic bookkeeper review" },
    });
    // escalated = the guard itself opened an owner item for this call; either way the owner has been told
    if (r.ok || r.decision.outcome === "escalated") {
      this.reported.set(businessId, fp);
      return { status: "reported", fingerprint: fp, question, outcome: r.decision.outcome };
    }
    return { status: "not_allowed", fingerprint: fp, reason: r.decision.reason };
  }
}

function contextFingerprint(json: string): string | undefined {
  try {
    const v = JSON.parse(json) as { reviewFingerprint?: unknown };
    return typeof v?.reviewFingerprint === "string" ? v.reviewFingerprint : undefined;
  } catch {
    return undefined;
  }
}

// ---------- scheduling ----------

export interface ReviewScheduleConfig {
  enabled: boolean;
  intervalMs: number;
  initialDelayMs: number;
  /** quiet time after the last new document before a review; 0 = no document trigger */
  debounceMs: number;
  pollMs: number;
}

function num(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const raw = env[name]?.trim();
  if (!raw) return dflt;
  const v = Number(raw);
  if (Number.isFinite(v) && v >= 0) return v;
  log.warn("review", `${name}=${raw.slice(0, 20)} is not a number >= 0; using ${dflt}`);
  return dflt;
}

/**
 * BOOKKEEPER_REVIEW=off disables it (default on; default OFF under vitest unless set to on).
 * BOOKKEEPER_REVIEW_INTERVAL_HOURS (6; 0 = no timer), BOOKKEEPER_REVIEW_INITIAL_DELAY_SECONDS (120),
 * BOOKKEEPER_REVIEW_DEBOUNCE_SECONDS (120; 0 = no review after new documents).
 */
export function reviewConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ReviewScheduleConfig {
  const flag = env["BOOKKEEPER_REVIEW"]?.trim().toLowerCase();
  const inTests = env["VITEST"] !== undefined || env["NODE_ENV"] === "test";
  const enabled = flag ? !["off", "0", "false", "no"].includes(flag) : !inTests;
  const debounceMs = num(env, "BOOKKEEPER_REVIEW_DEBOUNCE_SECONDS", 120) * 1000;
  return {
    enabled,
    intervalMs: num(env, "BOOKKEEPER_REVIEW_INTERVAL_HOURS", 6) * 3_600_000,
    initialDelayMs: num(env, "BOOKKEEPER_REVIEW_INITIAL_DELAY_SECONDS", 120) * 1000,
    debounceMs,
    pollMs: Math.max(1000, Math.min(30_000, debounceMs || 30_000)),
  };
}

export interface ReviewSchedulerDeps {
  review: (businessId: string) => Promise<ReviewOutcome>;
  /** live, enforced businesses where the brain holds a bookkeeper identity ([] while disconnected) */
  businesses: () => string[];
  /** cheap change signal for a business's posted documents (e.g. count + newest id) */
  signature: (businessId: string) => string | undefined;
  now?: () => number;
}

export class ReviewScheduler {
  private timers: NodeJS.Timeout[] = [];
  private readonly seen = new Map<string, { sig: string; changedAt?: number }>();
  private started = false;

  constructor(private readonly deps: ReviewSchedulerDeps, readonly config: ReviewScheduleConfig) {}

  start(): void {
    if (this.started || !this.config.enabled) return;
    this.started = true;
    const c = this.config;
    const later = (fn: () => Promise<unknown>) => () => void fn().catch((e) => log.error("review", `failed: ${(e as Error).message}`));
    this.timers.push(setTimeout(later(() => this.runAll("startup")), c.initialDelayMs));
    if (c.intervalMs > 0) this.timers.push(setInterval(later(() => this.runAll("timer")), c.intervalMs));
    if (c.debounceMs > 0) this.timers.push(setInterval(later(() => this.poll()), c.pollMs));
    for (const t of this.timers) t.unref?.();
    log.info("review", `automatic bookkeeper review on: every ${c.intervalMs / 3_600_000}h (first after ${c.initialDelayMs / 1000}s)${c.debounceMs ? `, and ${c.debounceMs / 1000}s after new documents` : ""}`);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    this.started = false;
  }

  private list(): string[] {
    try {
      return this.deps.businesses();
    } catch (e) {
      log.warn("review", `cannot list businesses: ${(e as Error).message}`);
      return [];
    }
  }

  /** Reviews one business; never throws. */
  async runOne(businessId: string, reason: string): Promise<ReviewOutcome | undefined> {
    try {
      const r = await this.deps.review(businessId);
      const detail = r.status === "skipped" || r.status === "not_allowed" ? ` (${r.reason})` : r.status === "reported" ? ` (guard: ${r.outcome})` : "";
      log.info("review", `${businessId} [${reason}]: ${r.status}${detail}`);
      return r;
    } catch (e) {
      log.error("review", `${businessId} [${reason}] failed: ${(e as Error).message}`);
      return undefined;
    }
  }

  async runAll(reason: string): Promise<void> {
    for (const id of this.list()) await this.runOne(id, reason);
  }

  /** Document trigger: a business whose signature changed is reviewed once it has been quiet for debounceMs. */
  async poll(): Promise<void> {
    const now = (this.deps.now ?? Date.now)();
    for (const id of this.list()) {
      let sig: string | undefined;
      try {
        sig = this.deps.signature(id);
      } catch {
        sig = undefined;
      }
      if (sig === undefined) continue;
      const s = this.seen.get(id);
      if (!s) {
        this.seen.set(id, { sig }); // first sight: the startup review covers what is already there
        continue;
      }
      if (s.sig !== sig) {
        s.sig = sig;
        s.changedAt = now;
      }
      if (s.changedAt !== undefined && now - s.changedAt >= this.config.debounceMs) {
        delete s.changedAt;
        await this.runOne(id, "new documents");
      }
    }
  }
}
