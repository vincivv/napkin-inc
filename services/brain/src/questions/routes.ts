// GET /questions/next, POST /questions/:id/answer|dismiss, POST /owner/statement, GET /owner/statements,
// POST /owner/statement/:id/decide, GET /spec/:businessId

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { log } from "../log";
import { checkBusinessId, HttpError, newRouter, requireLlm, requireSpec, sha, specView, type M2Deps } from "../m2deps";
import { applyAnswer, dismissQuestion, moneyReady, nextQuestion, refreshQuestions } from "./engine";
import { phraseQuestion } from "./phrase";
import { applyDiff, buildDiff, parseStatement, StaleDiff, type StatementDiff } from "./statement";
import type { PendingStatement, StoredSpec } from "../spec/store";
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

const Answer = z.object({ businessId: z.string(), answer: z.string().max(500).optional(), confirm: z.boolean().optional() });
const Statement = z.object({ businessId: z.string(), text: z.string().min(1).max(1000), channel: z.enum(["app", "phone"]) });
const Decide = z.object({ businessId: z.string(), confirm: z.boolean() });

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

export function questionRoutes(d: M2Deps) {
  const r = newRouter();

  r.get("/spec/:businessId", async (c) => {
    const id = checkBusinessId(c.req.param("businessId"));
    requireSpec(d, id);
    const rec = (await syncStatements(d, id)) ?? requireSpec(d, id);
    return c.json(specView(rec));
  });

  r.get("/questions/next", async (c) => {
    const id = checkBusinessId(c.req.query("businessId"));
    const rec = requireSpec(d, id);
    const q = nextQuestion(rec.spec);
    const open = rec.spec.openQuestions.filter((x) => x.status === "open" || x.status === "asked");
    if (!q) return c.json({ question: null, remaining: 0, moneyReady: moneyReady(rec.spec), version: rec.version });
    const fact = getFact(rec.spec, q.fieldPath);
    const phrased = await phraseQuestion(d.llm, q.question);
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
    requireSpec(d, businessId);
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

  r.post("/questions/:id/dismiss", async (c) => {
    const body = z.object({ businessId: z.string() }).parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    requireSpec(d, businessId);
    const rec = await d.store.update(businessId, (cur) => ({ ...cur!, spec: dismissQuestion(cur!.spec, c.req.param("id")) }));
    return c.json(specView(rec));
  });

  r.post("/owner/statement", async (c) => {
    const body = Statement.parse(await c.req.json());
    const businessId = checkBusinessId(body.businessId);
    const rec0 = requireSpec(d, businessId);
    if (body.channel === "phone" && !d.platform?.hasBusiness(businessId)) throw new HttpError(409, "phone statements need the business to exist on the platform");
    const llm = requireLlm(d);
    const id = d.newId?.() ?? randomUUID();
    const parsed = await parseStatement(llm, rec0.spec, body.text);
    const diff = buildDiff(rec0.spec, parsed, { statementId: id, text: body.text, channel: body.channel });
    const st: PendingStatement = { id, text: body.text, channel: body.channel, diff, status: "pending", createdAt: new Date().toISOString() };
    let queued = false;
    if (body.channel === "phone") {
      // Queued for the owner to confirm in the app (Inbox). Never applied here.
      await d.platform!.queueOwnerStatement({
        businessId,
        channel: "phone",
        text: body.text,
        diffJson: JSON.stringify({ statementId: id, changes: diff.changes.map((x) => ({ path: x.path, label: x.label, from: x.beforeText, to: x.afterText })), unparsed: diff.unparsed, note: diff.note }),
      });
      queued = true;
    }
    await d.store.update(businessId, (cur) => ({ ...cur!, statements: [...cur!.statements, st] }));
    return c.json({ statementId: id, status: "pending", channel: body.channel, diff, platformQueued: queued, appliedToSpec: false });
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
