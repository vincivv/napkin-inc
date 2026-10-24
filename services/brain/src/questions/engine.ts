// Deterministic question engine. Which question comes next is decided here by impactScore; the LLM may
// only re-word the chosen question (see ./phrase), never choose or change it.

import type { BusinessSpec, OpenQuestion } from "@napkin/schema";
import { usableForMoney } from "@napkin/schema";
import { CoerceError, coerceValue, showValue } from "../spec/coerce";
import { getFact, isMissing, listFacts, normalizePath, setFact, type AnyFact } from "../spec/paths";
import { impactScore, isMoneyRelevant, moneyImpact } from "./impact";

const LABELS: Record<string, string> = {
  "policies.taxRate": "your sales tax rate",
  "policies.marginFloorPct": "the minimum profit margin you will accept on a sale",
  "policies.maxDiscountPct": "the biggest discount you will give",
  "policies.refundWindowHours": "how long customers have to ask for a refund",
  "policies.refundMethod": "how refunds are paid back",
  "policies.couponsAllowed": "whether coupons are allowed",
  "policies.currency": "your currency",
  "policies.paymentMethods": "how customers pay",
  "operations.fulfillment": "pickup or delivery",
  "operations.pickupLocation": "where customers pick up",
  "business.name": "your business name",
  "business.oneLiner": "your one-line description",
  "business.community": "who your customers are",
  "business.location": "your location",
  "business.hours": "your opening hours",
  "business.timezone": "your timezone",
};

/** Human label for a path, using the names in the spec ("the cost of Chocolate chip cookie, Box of 6"). */
export function labelFor(spec: BusinessSpec, path: string): string {
  const norm = normalizePath(path);
  if (LABELS[norm]) return LABELS[norm]!;
  const m = /^offerings\.([^.]+)(?:\.(variants|addOns)\.([^.]+))?\.(\w+)$/.exec(path);
  if (m) {
    const [, oid, grp, eid, field] = m;
    const off = spec.offerings.find((o) => o.id === oid);
    const offName = off && String(off.name.value) ? String(off.name.value) : "this item";
    const el = grp && off ? (off[grp as "variants" | "addOns"] as { id: string; name: AnyFact }[]).find((e) => e.id === eid) : undefined;
    const elName = el && String(el.name.value) ? String(el.name.value) : grp === "addOns" ? "this add-on" : "this size";
    const what = { price: "the price of", cost: "what it costs you to make", stockUnits: "the stock units of", name: "the name of", initialStock: "how many you have in stock of", stockTracked: "whether you track stock for", description: "the description of" }[field!] ?? field;
    const target = grp ? `${offName}, ${elName}` : offName;
    return field === "cost" ? `what it costs you to make ${target}` : `${what} ${target}`.replace("the price of", "the price of");
  }
  return path;
}

export function describeQuestion(spec: BusinessSpec, path: string, fact: AnyFact, candidates?: string[]): string {
  const label = labelFor(spec, path);
  if (candidates && candidates.length > 1) return `Two sources disagree about ${label}: ${candidates.join(" or ")}. Which is right?`;
  if (isMissing(fact)) return `What is ${label}?`;
  const v = showValue(path, fact.value);
  if (fact.provenance === "paper") return `I read ${fact.source.quote ? `"${fact.source.quote}"` : "this"} on your paper as ${label}: ${v}. Is that right?`;
  if (fact.provenance === "owner_said") return `You said ${label} is ${v}. Can you confirm that?`;
  return `I am only guessing ${label} might be ${v}; you have not told me. What is it really?`;
}

/** Facts that do not apply (stock details when the owner confirmed stock is not tracked) are never asked or required. */
export function isApplicable(spec: BusinessSpec, path: string): boolean {
  const m = /^offerings\.([^.]+)\.(initialStock|variants\.[^.]+\.stockUnits)$/.exec(path);
  if (!m) return true;
  const off = spec.offerings.find((o) => o.id === m[1]);
  return !(off && off.stockTracked.confirmed && off.stockTracked.value === false);
}

export interface Blocker {
  path: string;
  why: "missing" | "guess" | "unconfirmed";
}

export function moneyBlockers(spec: BusinessSpec): Blocker[] {
  return listFacts(spec)
    .filter(({ path, fact }) => isMoneyRelevant(path) && isApplicable(spec, path) && !usableForMoney(fact))
    .map(({ path, fact }) => ({ path, why: isMissing(fact) ? ("missing" as const) : fact.provenance === "inferred" ? ("guess" as const) : ("unconfirmed" as const) }));
}
/** True iff every money-relevant fact is usableForMoney. The compiler refuses to compile when false. */
export function moneyReady(spec: BusinessSpec): boolean {
  return moneyBlockers(spec).length === 0;
}

/** Regenerate openQuestions from the facts: one per path whose fact is not yet usableForMoney. Pure. */
export function refreshQuestions(spec: BusinessSpec): BusinessSpec {
  const prior = new Map<string, OpenQuestion>();
  // a conflict question (has candidates) must win over the plain question for the same path
  for (const q of [...spec.openQuestions].sort((a, b) => Number(Boolean(a.candidates)) - Number(Boolean(b.candidates)))) prior.set(q.fieldPath, q);
  const out: OpenQuestion[] = [];
  for (const { path, fact } of listFacts(spec)) {
    if (usableForMoney(fact) || !isApplicable(spec, path)) continue;
    const old = prior.get(path);
    if (old?.status === "dismissed" && !isMoneyRelevant(path)) {
      out.push(old);
      continue;
    }
    const conflict = old && old.candidates && old.candidates.length > 1 && (old.status === "open" || old.status === "asked") ? old : undefined;
    out.push({
      id: conflict ? conflict.id : `q.${path}`,
      fieldPath: path,
      question: describeQuestion(spec, path, fact, conflict?.candidates),
      impactScore: conflict ? moneyImpact(path) : impactScore(path, fact.confidence),
      moneyRelevant: isMoneyRelevant(path),
      status: old?.status === "asked" ? "asked" : "open",
      ...(conflict?.candidates ? { candidates: conflict.candidates } : {}),
    });
  }
  out.sort((a, b) => b.impactScore - a.impactScore || (a.id < b.id ? -1 : 1));
  return { ...spec, openQuestions: out };
}

export function nextQuestion(spec: BusinessSpec): OpenQuestion | undefined {
  return spec.openQuestions.filter((q) => q.status === "open" || q.status === "asked").sort((a, b) => b.impactScore - a.impactScore || (a.id < b.id ? -1 : 1))[0];
}

export class AnswerError extends Error {
  override name = "AnswerError";
}

export interface AnswerInput {
  /** typed text answer */
  answer?: string;
  /** "yes, what you have is right": confirms the current value as the owner's own */
  confirm?: boolean;
}

/** Pure. The fact becomes owner_said + confirmed (confidence 1). Throws AnswerError on a bad/ambiguous answer. */
export function applyAnswer(spec: BusinessSpec, questionId: string, input: AnswerInput): { spec: BusinessSpec; path: string; before: AnyFact; after: AnyFact } {
  const q = spec.openQuestions.find((x) => x.id === questionId);
  if (!q) throw new AnswerError(`unknown question ${questionId}`);
  const before = getFact(spec, q.fieldPath);
  if (!before) throw new AnswerError(`question ${questionId} points at a missing field`);
  let value: unknown;
  let quote: string;
  if (input.answer !== undefined && input.answer.trim() !== "") {
    try {
      value = coerceValue(q.fieldPath, before.value, input.answer);
    } catch (e) {
      throw new AnswerError(e instanceof CoerceError ? e.message : String(e));
    }
    quote = input.answer.trim();
  } else if (input.confirm) {
    if (isMissing(before)) throw new AnswerError("there is no value to confirm yet; please type the answer");
    value = before.value;
    quote = `confirmed: ${showValue(q.fieldPath, before.value)}`;
  } else throw new AnswerError("send an answer or confirm=true");
  const after: AnyFact = {
    value,
    provenance: "owner_said",
    confidence: 1,
    source: { kind: "chat", ref: questionId, ...(before.source.region ? { region: before.source.region } : {}), quote },
    confirmed: true,
  };
  const next = refreshQuestions(
    markAnswered(setFact(spec, q.fieldPath, after), q, input.answer ?? quote),
  );
  return { spec: next, path: q.fieldPath, before, after };
}

function markAnswered(spec: BusinessSpec, q: OpenQuestion, answer: string): BusinessSpec {
  return { ...spec, openQuestions: spec.openQuestions.map((x) => (x.id === q.id ? { ...x, status: "answered" as const, answer } : x)) };
}

/** Dismiss is only allowed for questions that cannot affect money. */
export function dismissQuestion(spec: BusinessSpec, questionId: string): BusinessSpec {
  const q = spec.openQuestions.find((x) => x.id === questionId);
  if (!q) throw new AnswerError(`unknown question ${questionId}`);
  if (q.moneyRelevant) throw new AnswerError("money-relevant questions cannot be skipped");
  return { ...spec, openQuestions: spec.openQuestions.map((x) => (x.id === questionId ? { ...x, status: "dismissed" as const } : x)) };
}
