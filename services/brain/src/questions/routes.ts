// GET /questions/next, POST /questions/:id/answer|dismiss, POST /owner/statement, GET /owner/statements,
// POST /owner/statement/:id/decide, GET /spec/:businessId

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "../log";
import { checkBusinessId, HttpError, newRouter, requireLlm, requireSpec, sha, specView, type M2Deps } from "../m2deps";
import { applyAnswer, batchConfirmable, confirmMany, dismissQuestion, editFact, labelFor, moneyReady, nextQuestion, refreshQuestions, removeAtPath } from "./engine";
import { phraseQuestion } from "./phrase";
import { applyDiff, buildDiff, parseStatement, StaleDiff, type StatementDiff } from "./statement";
import type { Draft, PendingStatement, StoredSpec } from "../spec/store";
import { getFact, isMissing } from "../spec/paths";
import { showValue } from "../spec/coerce";

async function recordDecision(d: M2Deps, businessId: string, a: { action: string; reason: string; evidence: string[]; inputs: unknown; wouldChangeIf?: string }): Promise<boolean> {
  if (!d.platform?.hasBusiness(businessId)) return false;
  try {
    await d.platform.recordDecision({
      businessId,
      action: a.action,
      documentRef: "",
      ruleIds: [],
      evidenceRefs: a.evidence,
      inputsHash: sha(a.inputs),
      outcome: "executed",
      reason: a.reason,
      wouldChangeIf: a.wouldChangeIf ?? "",
    });
    return true;
  } catch (e) {
    log.warn("m2", `recordDecision failed for ${businessId}: ${(e as Error).message}`);
    return false;
  }
}

const ConfirmMany = z.object({ businessId: z.string(), questionIds: z.array(z.string().max(200)).min(1).max(200) });
const Answer = z.object({ businessId: z.string(), answer: z.string().max(500).optional(), confirm: z.boolean().optional() });
const Statement = z.object({ businessId: z.string(), text: z.string().min(1).max(1000), channel: z.enum(["app", "phone"]) });
const Decide = z.object({ businessId: z.string(), confirm: z.boolean() });
const EditFact = z.object({ businessId: z.string(), path: z.string().min(1).max(300), value: z.string().max(500) });
const RemoveFact = z.object({ businessId: z.string(), path: z.string().min(1).max(300) });

/** Apply/reject phone statements the owner already decided in the platform (the authoritative confirmation). */
async function syncStatements(d: M2Deps, businessId: string): Promise<StoredSpec | undefined> {
  const rec = d.store.get(businessId);
  if (!rec || !d.platform) return rec;
  const rows = d.platform.ownerStatements(businessId);
  const todo = rec.statements.filter((s) => s.channel === "phone" && s.status === "pending");
  if (todo.length === 0) return rec;
  const verdict = new Map<string, { id: bigint; status: string }>();
  for (const r of rows) {
    try {
      const sid = (JSON.parse(r.diffJson) as { statementId?: string }).statementId;
      if (sid) verdict.set(sid, { id: r.id, status: r.status });
    } catch {
      /* not ours */
    }
  }
  const applied: { s: PendingStatement; pid: bigint }[] = [];
  const next = await d.store.update(businessId, (cur) => {
    let spec = cur!.spec;
    const statements = cur!.statements.map((s) => {
      const v = verdict.get(s.id);
      if (s.channel !== "phone" || s.status !== "pending" || !v) return s;
      if (v.status === "rejected") return { ...s, status: "rejected" as const, decidedAt: new Date().toISOString() };
      if (v.status === "confirmed" || v.status === "applied") {
        try {
          spec = refreshQuestions(applyDiff(spec, s.diff));
          applied.push({ s, pid: v.id });
          return { ...s, status: "applied" as const, decidedAt: new Date().toISOString() };
        } catch (e) {
          if (e instanceof StaleDiff) return s;
          throw e;
        }
      }
      return s;
    });
    return { ...cur!, spec, statements };
  });
  for (const a of applied) {
    await d.platform.markOwnerStatementApplied(a.pid).catch((e) => log.warn("m2", `markOwnerStatementApplied: ${(e as Error).message}`));
    await recordDecision(d, businessId, { action: "owner_statement_applied", reason: `Owner confirmed phone statement: "${a.s.text}"`, evidence: [`statement:${a.s.id}`], inputs: a.s.diff });
  }
  return next;
}

/**
 * Owner statement -> structured diff, stored as pending. "phone" statements are also queued on the platform
 * (queueOwnerStatement) for the owner to confirm in the app Inbox. NOTHING is applied here (invariant 6).
 * Shared by POST /owner/statement and the phone line's owner_instruction tool.
 */
export async function submitOwnerStatement(d: M2Deps, businessId: string, text: string, channel: "app" | "phone") {
  const rec0 = requireSpec(d, businessId);
  if (channel === "phone" && !d.platform?.hasBusiness(businessId)) throw new HttpError(409, "phone statements need the business to exist on the platform");
  const llm = requireLlm(d);
  const id = d.newId?.() ?? randomUUID();
  const parsed = await parseStatement(llm, rec0.spec, text);
  const diff = buildDiff(rec0.spec, parsed, { statementId: id, text, channel });
  const st: PendingStatement = { id, text, channel, diff, status: "pending", createdAt: new Date().toISOString() };
  let queued = false;
  if (channel === "phone") {
    // Queued for the owner to confirm in the app (Inbox). Never applied here.
    await d.platform!.queueOwnerStatement({
      businessId,
      channel: "phone",
      text,
      diffJson: JSON.stringify({ statementId: id, changes: diff.changes.map((x) => ({ path: x.path, label: x.label, from: x.beforeText, to: x.afterText })), unparsed: diff.unparsed, note: diff.note }),
    });
    queued = true;
  }
  await d.store.update(businessId, (cur) => ({ ...cur!, statements: [...cur!.statements, st] }));
  return { statementId: id, status: "pending" as const, channel, diff, platformQueued: queued, appliedToSpec: false as const };
}

/** A spec saved before a question rule changed may lack questions it now needs; regenerate and persist them. */
async function withFreshQuestions(d: M2Deps, businessId: string): Promise<StoredSpec> {
  const rec = requireSpec(d, businessId);
  const key = (qs: StoredSpec["spec"]["openQuestions"]) => JSON.stringify(qs.map((q) => [q.id, q.status, q.question]));
  if (key(refreshQuestions(rec.spec).openQuestions) === key(rec.spec.openQuestions)) return rec;
  return d.store.update(businessId, (cur) => ({ ...cur!, spec: refreshQuestions(cur!.spec) }));
}

export function questionRoutes(d: M2Deps) {
  const r = newRouter();

  r.get("/spec/:businessId", async (c) => {
    const id = checkBusinessId(c.req.param("businessId"));
    await withFreshQuestions(d, id);
    const rec = (await syncStatements(d, id)) ?? requireSpec(d, id);
    return c.json(specView(rec));
  });

  r.get("/questions/next", async (c) => {
    const id = checkBusinessId(c.req.query("businessId"));
    const rec = await withFreshQuestions(d, id);
    const q = nextQuestion(rec.spec);
    const open = rec.spec.openQuestions.filter((x) => x.status === "open" || x.status === "asked");
    if (!q) return c.json({ question: null, remaining: 0, moneyReady: moneyReady(rec.spec), version: rec.version });
    const fact = getFact(rec.spec, q.fieldPath);
    // money questions keep the exact template wording: a rephrase can shift the unit ("per add-on" vs "per batch")
    const phrased = q.moneyRelevant ? { text: q.question, phrasedBy: "template" as const } : await phraseQuestion(d.llm, q.question);
    return c.json({
      question: {
        ...q,
        phrased: phrased.text,
        phrasedBy: phrased.phrasedBy,
        current: fact ? { value: fact.value, display: isMissing(fact) ? "" : showValue(q.fieldPath, fact.value), provenance: fact.provenance, confidence: fact.confidence, source: fact.source, confirmed: fact.confirmed } : undefined,
      },
      remaining: open.length,
      moneyReady: moneyReady(rec.spec),
      version: rec.version,
    });
  });

  r.post("/questions/:id/answer", async (c) => {
    const body = Answer.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    const qid = c.req.param("id");
    await withFreshQuestions(d, businessId);
    let result: ReturnType<typeof applyAnswer> | undefined;
    const rec = await d.store.update(businessId, (cur) => {
      result = applyAnswer(cur!.spec, qid, { answer: body.answer, confirm: body.confirm });
      return { ...cur!, spec: result.spec };
    });
    const res = result!;
    const decisionRecorded = await recordDecision(d, businessId, {
      action: "owner_confirmed_fact",
      reason: `Owner confirmed ${res.path}: ${showValue(res.path, res.after.value)} (was ${res.before.provenance}, ${showValue(res.path, res.before.value)})`,
      evidence: [`spec:${businessId}@v${rec.version}`, res.path],
      inputs: { path: res.path, before: res.before, after: res.after },
      wouldChangeIf: "the owner states a different value",
    });
    return c.json({ ...specView(rec), answered: { path: res.path, value: res.after.value }, decisionRecorded });
  });

  /** The review list: facts the owner may confirm in one step (their own words or read from the paper). */
  r.get("/questions/review", async (c) => {
    const id = checkBusinessId(c.req.query("businessId"));
    const rec = await withFreshQuestions(d, id);
    const items = batchConfirmable(rec.spec).map((q) => {
      const f = getFact(rec.spec, q.fieldPath)!;
      return { id: q.id, fieldPath: q.fieldPath, label: labelFor(rec.spec, q.fieldPath), display: showValue(q.fieldPath, f.value), provenance: f.provenance, quote: f.source.quote ?? "", moneyRelevant: q.moneyRelevant };
    });
    const open = rec.spec.openQuestions.filter((x) => x.status === "open" || x.status === "asked").length;
    return c.json({ items, needAnswers: open - items.length, moneyReady: moneyReady(rec.spec), version: rec.version });
  });

  r.post("/questions/confirm", async (c) => {
    const body = ConfirmMany.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    await withFreshQuestions(d, businessId);
    let result: ReturnType<typeof confirmMany> | undefined;
    const rec = await d.store.update(businessId, (cur) => {
      result = confirmMany(cur!.spec, body.questionIds);
      return { ...cur!, spec: result.spec };
    });
    const res = result!;
    let decisionsRecorded = 0;
    for (const x of res.confirmed) {
      const ok = await recordDecision(d, businessId, {
        action: "owner_confirmed_fact",
        reason: `Owner confirmed ${x.path} from the review list: ${showValue(x.path, x.after.value)} (was ${x.before.provenance})`,
        evidence: [`spec:${businessId}@v${rec.version}`, x.path],
        inputs: { path: x.path, before: x.before, after: x.after },
        wouldChangeIf: "the owner states a different value",
      });
      if (ok) decisionsRecorded++;
    }
    return c.json({ ...specView(rec), confirmed: res.confirmed.map((x) => x.path), skipped: res.skipped, decisionsRecorded });
  });

  r.post("/questions/:id/dismiss", async (c) => {
    const body = z.object({ businessId: z.string() }).parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    requireSpec(d, businessId);
    const rec = await d.store.update(businessId, (cur) => ({ ...cur!, spec: dismissQuestion(cur!.spec, c.req.param("id")) }));
    return c.json(specView(rec));
  });

  /** The intake list's Edit: the owner types the right value for any field. */
  r.post("/intake/edit", async (c) => {
    const body = EditFact.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    requireSpec(d, businessId);
    let res: ReturnType<typeof editFact> | undefined;
    const rec = await d.store.update(businessId, (cur) => {
      res = editFact(cur!.spec, body.path, body.value);
      return { ...cur!, spec: res.spec };
    });
    const decisionRecorded = await recordDecision(d, businessId, {
      action: "owner_confirmed_fact",
      reason: `Owner edited ${body.path}: ${showValue(body.path, res!.after.value)} (was ${res!.before.provenance}, ${showValue(body.path, res!.before.value)})`,
      evidence: [`spec:${businessId}@v${rec.version}`, body.path],
      inputs: { path: body.path, before: res!.before, after: res!.after },
      wouldChangeIf: "the owner states a different value",
    });
    return c.json({ ...specView(rec), decisionRecorded });
  });

  /** The intake list's Remove: an item goes (also from the stored drafts, so a re-merge can't bring it back); a value is forgotten. */
  r.post("/intake/remove", async (c) => {
    const body = RemoveFact.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    requireSpec(d, businessId);
    const rec = await d.store.update(businessId, (cur) => {
      const res = removeAtPath(cur!.spec, body.path);
      if (res.removed === "value") return { ...cur!, spec: res.spec, alternatives: Object.fromEntries(Object.entries(cur!.alternatives).filter(([p]) => p !== res.prefix)) };
      const under = (p: string) => p === res.prefix || p.startsWith(`${res.prefix}.`);
      const fromDraft = (dr: Draft | undefined): Draft | undefined => {
        if (!dr) return dr;
        try {
          return { ...dr, spec: removeAtPath(dr.spec, body.path).spec };
        } catch {
          return dr; // the draft never had it
        }
      };
      const photo = fromDraft(cur!.drafts.photo);
      const voice = fromDraft(cur!.drafts.voice);
      const offeringGone = /^offerings\.[^.]+$/.test(res.prefix) ? res.prefix.split(".")[1] : undefined;
      return {
        ...cur!,
        spec: res.spec,
        alternatives: Object.fromEntries(Object.entries(cur!.alternatives).filter(([p]) => !under(p))),
        drafts: { ...(photo ? { photo } : {}), ...(voice ? { voice } : {}) },
        ...(cur!.voiceItems ? { voiceItems: cur!.voiceItems.filter((id) => id !== offeringGone) } : {}),
      };
    });
    return c.json(specView(rec));
  });

  /** Start over: before the business is live, the owner may throw the whole draft away (photo, notes, answers). */
  r.post("/intake/reset", async (c) => {
    const body = z.object({ businessId: z.string() }).parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    if (d.platform?.hasBusiness(businessId)) throw new HttpError(409, "this business is already live; change it from the back office instead");
    await d.store.remove(businessId);
    log.info("m2", `setup reset for ${businessId}`);
    return c.json({ ok: true });
  });

  r.post("/owner/statement", async (c) => {
    const body = Statement.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    return c.json(await submitOwnerStatement(d, businessId, body.text, body.channel));
  });

  r.get("/owner/statements", async (c) => {
    const id = checkBusinessId(c.req.query("businessId"));
    requireSpec(d, id);
    const rec = (await syncStatements(d, id))!;
    return c.json({ statements: rec.statements.slice().reverse(), version: rec.version });
  });

  /** App-channel statements are confirmed/rejected here. Phone ones are decided in the platform (Inbox) and synced. */
  r.post("/owner/statement/:id/decide", async (c) => {
    const body = Decide.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    const sid = c.req.param("id");
    const rec0 = requireSpec(d, businessId);
    const st = rec0.statements.find((s) => s.id === sid);
    if (!st) throw new HttpError(404, `unknown statement ${sid}`);
    if (st.channel === "phone") throw new HttpError(409, "phone statements are confirmed in the Inbox (platform); this view syncs the result");
    if (st.status !== "pending") throw new HttpError(409, `statement is already ${st.status}`);
    const rec = await d.store.update(businessId, (cur) => {
      const now = new Date().toISOString();
      let spec = cur!.spec;
      if (body.confirm) spec = refreshQuestions(applyDiff(spec, st.diff));
      return { ...cur!, spec, statements: cur!.statements.map((s) => (s.id === sid ? { ...s, status: body.confirm ? ("applied" as const) : ("rejected" as const), decidedAt: now } : s)) };
    });
    const decisionRecorded = await recordDecision(d, businessId, {
      action: body.confirm ? "owner_statement_applied" : "owner_statement_rejected",
      reason: `${body.confirm ? "Owner confirmed" : "Owner rejected"} statement: "${st.text}"`,
      evidence: [`statement:${sid}`, ...st.diff.changes.map((x) => x.path)],
      inputs: st.diff,
    });
    return c.json({ ...specView(rec), decisionRecorded, statement: rec.statements.find((s) => s.id === sid) });
  });

  return r;
}

export type { StatementDiff };
