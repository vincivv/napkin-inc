// Deterministic question engine. Which question comes next is decided here by impactScore; the LLM may
// only re-word the chosen question (see ./phrase), never choose or change it.

import { Rational } from "@napkin/ledger-core";
import type { BusinessSpec, OpenQuestion } from "@napkin/schema";
import { usableForMoney } from "@napkin/schema";
import { moneyFacts } from "../compiler/facts";
import { CoerceError, coerceValue, showValue, valueKey } from "../spec/coerce";
import { getFact, isMissing, listFacts, missingFact, normalizePath, removeFact, setFact, slugify, type AnyFact } from "../spec/paths";
import { impactScore, isMoneyRelevant, moneyImpact } from "./impact";
import { isOneSize, unitsPerSale } from "../spec/stock";

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

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
    // a one-size item often has a size named like the item ("Chicken burrito" / "Chicken burrito"): say it once
    const oneName = grp === "variants" && sameName(elName, offName);
    if (field === "cost" && grp === "addOns") return `your ingredient cost for the ${elName} add-on on one order of ${offName}`;
    if (field === "cost") return `your ingredient cost to make one ${grp && !oneName ? `${elName} of ${offName}` : offName}`;
    if (field === "price" && grp === "addOns") return `the price you charge for the ${elName} add-on`;
    if (field === "stockUnits") return oneName ? `how many ${offName} one sale takes off the shelf` : `how many ${offName} go into one ${elName}`;
    if (field === "name" && oneName) return `the size name for ${offName}`;
    const what = { price: "the price of", stockUnits: "the stock units of", name: "the name of", initialStock: "the starting stock of", stockTracked: "whether you track stock for", description: "the description of" }[field!] ?? field;
    const target = grp && !oneName ? `${offName}, ${elName}` : offName;
    return `${what} ${target}`;
  }
  return path;
}

/** Direct wording for labels that don't read as "What is <label>?" ("how long...", "whether..."). */
const ASK: Record<string, string> = {
  "policies.refundWindowHours": "How many hours do customers have to ask for a refund?",
  "policies.refundMethod": "How are refunds paid back?",
  "policies.couponsAllowed": "Do you allow coupons?",
  "policies.paymentMethods": "How do customers pay?",
  "operations.fulfillment": "Is it pickup or delivery?",
  "operations.pickupLocation": "Where do customers pick up?",
  "business.community": "Who are your customers?",
};

function askMissing(spec: BusinessSpec, path: string, label: string): string {
  const direct = ASK[normalizePath(path)];
  if (direct) return direct;
  const m = /^offerings\.([^.]+)(?:\.variants\.([^.]+))?\.(stockTracked|initialStock|stockUnits)$/.exec(path);
  if (m) {
    const off = spec.offerings.find((o) => o.id === m[1]);
    const offName = off && String(off.name.value) ? String(off.name.value) : "this item";
    const v = m[2] && off ? off.variants.find((x) => x.id === m[2]) : undefined;
    const vName = v && String(v.name.value) ? String(v.name.value) : "this size";
    if (m[3] === "stockTracked") return `Do you want to track stock for ${offName}?`;
    if (m[3] === "initialStock") return `How many ${offName} do you have in stock right now?`;
    return `How many ${offName} go into one ${vName}? (A box of 6 holds 6, a single holds 1. This is not how many you have in stock.)`;
  }
  return `What is ${label}?`;
}

export function describeQuestion(spec: BusinessSpec, path: string, fact: AnyFact, candidates?: string[]): string {
  const label = labelFor(spec, path);
  if (candidates && candidates.length > 1) return `Two sources disagree about ${label}: ${candidates.join(" or ")}. Which is right?`;
  if (isMissing(fact)) return askMissing(spec, path, label);
  const v = showValue(path, fact.value);
  if (fact.provenance === "paper") return `I read ${fact.source.quote ? `"${fact.source.quote}"` : "this"} on your paper as ${label}: ${v}. Is that right?`;
  if (fact.provenance === "owner_said") return `You said ${label} is ${v}. Can you confirm that?`;
  if (/\.stockUnits$/.test(path)) return `${askMissing(spec, path, label)} My guess is ${v}, but you have not told me.`;
  return `I am only guessing ${label} might be ${v}; you have not told me. What is it really?`;
}

/** Facts that do not apply (stock details when the owner confirmed stock is not tracked) are never asked or required. */
export function isApplicable(spec: BusinessSpec, path: string): boolean {
  const m = /^offerings\.([^.]+)\.(initialStock|variants\.[^.]+\.stockUnits)$/.exec(path);
  if (!m) return true;
  const off = spec.offerings.find((o) => o.id === m[1]);
  if (!off) return true;
  const v = /^variants\.([^.]+)\.stockUnits$/.exec(m[2]!);
  if (v && off.variants.some((x) => x.id === v[1] && isOneSize(off, x))) return false;
  return !(off.stockTracked.confirmed && off.stockTracked.value === false);
}

export interface Blocker {
  path: string;
  why: "missing" | "guess" | "unconfirmed" | "invalid";
}

/**
 * Confirmed facts the compiler would still refuse (e.g. a fractional stockUnits saved before the interview
 * checked it), as engine paths. They must be asked again, or the owner is stuck with nothing to answer.
 */
export function invalidFacts(spec: BusinessSpec): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of moneyFacts(spec)) {
    const problem = m.fact && usableForMoney(m.fact) ? m.validate?.(m.fact.value) : undefined;
    if (problem) out.set(m.path.replace(/\[([^\]]+)\]/g, ".$1"), problem);
  }
  if (out.size === 0) for (const [path, problem] of stockCostProblems(spec)) out.set(path, problem);
  for (const [path, m] of addOnMismatches(spec)) if (!out.has(path)) out.set(path, m.problem);
  return out;
}

const ADDON_PATH = /^offerings\.([^.]+)\.addOns\.([^.]+)\.(price|cost)$/;

/**
 * An add-on offered on several items ("Cheese" on every burrito) is ONE product in the catalog, so its price
 * and its cost must agree everywhere (the compiler refuses otherwise). When the owner's confirmed values
 * differ, the first copy is flagged with the values to choose from; answering it sets every copy.
 */
export function addOnMismatches(spec: BusinessSpec): Map<string, { problem: string; question: string; candidates: string[] }> {
  const groups = new Map<string, { path: string; fact: AnyFact; on: string }[]>();
  for (const o of spec.offerings)
    for (const a of o.addOns)
      for (const field of ["price", "cost"] as const) {
        const fact = a[field] as AnyFact;
        if (!fact || isMissing(fact) || !usableForMoney(fact)) continue;
        const key = `${a.id}.${field}`;
        groups.set(key, [...(groups.get(key) ?? []), { path: `offerings.${o.id}.addOns.${a.id}.${field}`, fact, on: String(o.name.value) }]);
      }
  const out = new Map<string, { problem: string; question: string; candidates: string[] }>();
  for (const [key, copies] of groups) {
    if (copies.length < 2) continue;
    const distinct = [...new Map(copies.map((c) => [valueKey(c.path, c.fact.value), c])).values()];
    if (distinct.length < 2) continue;
    const field = key.endsWith(".cost") ? "cost" : "price";
    const m = ADDON_PATH.exec(copies[0]!.path)!;
    const name = String(spec.offerings.find((o) => o.id === m[1])?.addOns.find((a) => a.id === m[2])?.name.value ?? m[2]);
    const said = distinct.map((c) => `${showValue(c.path, c.fact.value)} on ${c.on}`).join(" but ");
    const candidates = [...new Set(distinct.map((c) => showValue(c.path, c.fact.value)))];
    const question =
      field === "cost"
        ? `${name} costs you ${said}. It's one add-on for every item, so which cost is right?`
        : `${name} is priced ${said}. It's one add-on for every item, so which price is right?`;
    out.set(copies[0]!.path, { problem: `differs between items (${candidates.join(" vs ")})`, question, candidates });
  }
  return out;
}

/** Set the owner's answer at `path`; an add-on's price or cost is the same product everywhere, so every copy gets it. */
function placeOwnerValue(spec: BusinessSpec, path: string, after: AnyFact): BusinessSpec {
  let next = setFact(spec, path, after);
  const m = ADDON_PATH.exec(path);
  if (!m) return next;
  const [, oid, aid, field] = m;
  for (const o of next.offerings) {
    if (o.id === oid || !o.addOns.some((a) => a.id === aid)) continue;
    next = setFact(next, `offerings.${o.id}.addOns.${aid}.${field}`, { ...after, source: { ...after.source, ref: `${after.source.ref}+${o.id}` } });
  }
  return next;
}

/**
 * The books keep one stock item per tracked offering, so every variant must cost the same per unit of stock
 * (the compiler refuses otherwise). The smallest variant sets the unit cost; the others are asked to agree.
 */
function stockCostProblems(spec: BusinessSpec): Map<string, string> {
  const dollars = (r: Rational) => (Number(r.toCents()) / 100).toFixed(2);
  const out = new Map<string, string>();
  const usable = (f: AnyFact | undefined): f is AnyFact => Boolean(f && usableForMoney(f));
  for (const o of spec.offerings) {
    if (!usable(o.stockTracked as AnyFact) || o.stockTracked.value !== true) continue;
    if (!o.variants.every((v) => usable(v.cost as AnyFact) && (isOneSize(o, v) || usable(v.stockUnits as AnyFact | undefined)))) continue;
    const units = (v: (typeof o.variants)[number]) => unitsPerSale(o, v)!;
    const vs = [...o.variants].sort((a, b) => Number(units(a)) - Number(units(b)));
    const ref = vs[0];
    if (!ref) continue;
    const unit = Rational.parse(ref.cost.value).div(Rational.parse(units(ref)));
    const name = o.name.value;
    if (!unit.mul(Rational.of(100n)).isInteger()) {
      out.set(`offerings.${o.id}.variants.${ref.id}.cost`, `does not split into a whole number of cents across its ${units(ref)} units of stock`);
      continue;
    }
    for (const v of vs.slice(1)) {
      const expected = unit.mul(Rational.parse(units(v)));
      if (Rational.parse(v.cost.value).eq(expected)) continue;
      out.set(
        `offerings.${o.id}.variants.${v.id}.cost`,
        `should be $${dollars(expected)}: it uses ${units(v)} units of ${name} stock and one unit costs $${dollars(unit)} (from ${ref.name.value}), and every option of ${name} draws on the same stock`,
      );
    }
  }
  return out;
}

export function moneyBlockers(spec: BusinessSpec): Blocker[] {
  const invalid = invalidFacts(spec);
  return listFacts(spec)
    .filter(({ path, fact }) => isMoneyRelevant(path) && isApplicable(spec, path) && (!usableForMoney(fact) || invalid.has(path)))
    .map(({ path, fact }) => ({
      path,
      why: invalid.has(path) ? ("invalid" as const) : isMissing(fact) ? ("missing" as const) : fact.provenance === "inferred" ? ("guess" as const) : ("unconfirmed" as const),
    }));
}
/** True iff every money-relevant fact is usableForMoney. The compiler refuses to compile when false. */
export function moneyReady(spec: BusinessSpec): boolean {
  return moneyBlockers(spec).length === 0;
}

/**
 * Stock fields are optional in the spec, so a photo that never mentions stock leaves them out entirely and no
 * question would ever ask for them, while the compiler requires them for tracked stock. Add a "missing"
 * placeholder for each one that applies, so the interview asks, and removes them again once the owner
 * confirms stock is not tracked. Pure.
 */
export function withRequiredPlaceholders(spec: BusinessSpec): BusinessSpec {
  let changed = false;
  const offerings = spec.offerings.map((o) => {
    if (o.stockTracked.confirmed && o.stockTracked.value === false) {
      // not tracked: drop placeholders we added (never claims); keep anything the owner or paper actually gave
      const stale = o.variants.some((v) => v.stockUnits && isMissing(v.stockUnits)) || (o.initialStock && isMissing(o.initialStock));
      if (!stale) return o;
      changed = true;
      const variants = o.variants.map((v) => (v.stockUnits && isMissing(v.stockUnits) ? (({ stockUnits: _, ...rest }) => rest)(v) : v));
      const { initialStock, ...rest } = o;
      return { ...rest, variants, ...(initialStock && !isMissing(initialStock) ? { initialStock } : {}) };
    }
    const variants = o.variants.map((v) => {
      // a one-size item uses one of itself per sale: never asked, and a stored answer is dropped (see spec/stock)
      if (isOneSize(o, v)) return v.stockUnits ? ((changed = true), (({ stockUnits: _, ...rest }) => rest)(v)) : v;
      return v.stockUnits ? v : ((changed = true), { ...v, stockUnits: missingFact("1") });
    });
    const initialStock = o.initialStock ?? ((changed = true), missingFact(0));
    return { ...o, variants, initialStock };
  });
  return changed ? { ...spec, offerings } : spec;
}

/** Regenerate openQuestions from the facts: one per path whose fact is not yet usableForMoney. Pure. */
export function refreshQuestions(input: BusinessSpec): BusinessSpec {
  const spec = withRequiredPlaceholders(input);
  const prior = new Map<string, OpenQuestion>();
  // a conflict question (has candidates) must win over the plain question for the same path
  for (const q of [...spec.openQuestions].sort((a, b) => Number(Boolean(a.candidates)) - Number(Boolean(b.candidates)))) prior.set(q.fieldPath, q);
  const out: OpenQuestion[] = [];
  const invalid = invalidFacts(spec);
  const mismatched = addOnMismatches(spec);
  for (const { path, fact } of listFacts(spec)) {
    if ((usableForMoney(fact) && !invalid.has(path)) || !isApplicable(spec, path)) continue;
    const mm = mismatched.get(path);
    if (mm && invalid.get(path) === mm.problem) {
      out.push({ id: `addon.${path}`, fieldPath: path, question: mm.question, impactScore: moneyImpact(path), moneyRelevant: true, status: "open", candidates: mm.candidates });
      continue;
    }
    const old = prior.get(path);
    if (old?.status === "dismissed" && !isMoneyRelevant(path)) {
      out.push(old);
      continue;
    }
    const conflict = old && old.candidates && old.candidates.length > 1 && (old.status === "open" || old.status === "asked") ? old : undefined;
    out.push({
      id: conflict ? conflict.id : `q.${path}`,
      fieldPath: path,
      question: invalid.has(path)
        ? `You said ${labelFor(spec, path)} is ${showValue(path, fact.value)}, but it ${invalid.get(path)}. What should it be?`
        : describeQuestion(spec, path, fact, conflict?.candidates),
      impactScore: conflict || invalid.has(path) ? moneyImpact(path) : impactScore(path, fact.confidence),
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
    const problem = invalidFacts(spec).get(q.fieldPath);
    if (problem) throw new AnswerError(`that value ${problem}; please type the right one`);
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
  const typed = input.answer !== undefined && input.answer.trim() !== "";
  // a typed answer is the owner's word for that field everywhere it appears (an add-on on several items);
  // a bare confirm only confirms the value shown, so a different copy elsewhere still gets asked about
  const placed = typed ? placeOwnerValue(spec, q.fieldPath, after) : setFact(spec, q.fieldPath, after);
  const problem = typed ? invalidFacts(placed).get(q.fieldPath) : undefined;
  if (problem) throw new AnswerError(`${showValue(q.fieldPath, value)} ${problem}`);
  const next = refreshQuestions(markAnswered(placed, q, input.answer ?? quote));
  return { spec: next, path: q.fieldPath, before, after };
}

/**
 * The owner corrects any fact directly (the intake list's Edit): the same coercion and checks as an answer,
 * and the result is the owner's own confirmed word. Open questions about that field are answered by it.
 */
export function editFact(spec: BusinessSpec, path: string, answer: string): { spec: BusinessSpec; before: AnyFact; after: AnyFact } {
  const before = getFact(spec, path);
  if (!before) throw new AnswerError(`no field ${path}`);
  if (!answer.trim()) throw new AnswerError("type the new value");
  let value: unknown;
  try {
    value = coerceValue(path, before.value, answer);
  } catch (e) {
    throw new AnswerError(e instanceof CoerceError ? e.message : String(e));
  }
  const after: AnyFact = { value, provenance: "owner_said", confidence: 1, source: { kind: "chat", ref: `edit.${path}`, quote: answer.trim() }, confirmed: true };
  const edited = placeOwnerValue(spec, path, after);
  const problem = invalidFacts(edited).get(path);
  if (problem) throw new AnswerError(`${showValue(path, value)} ${problem}`);
  const next = { ...edited, openQuestions: edited.openQuestions.map((q) => (q.fieldPath === path && (q.status === "open" || q.status === "asked") ? { ...q, status: "answered" as const, answer: answer.trim() } : q)) };
  return { spec: refreshQuestions(next), before, after };
}

/**
 * The intake list's Remove. On an item's name it removes the item (an offering, a size/variant, an add-on or
 * a supplier; an offering's last variant takes the offering with it); on any other field it forgets the
 * value, which goes back to "not provided" and is asked again in the interview.
 */
export function removeAtPath(spec: BusinessSpec, path: string): { spec: BusinessSpec; removed: "item" | "value"; prefix: string } {
  const fact = getFact(spec, path);
  if (!fact) throw new AnswerError(`no field ${path}`);
  const off = /^offerings\.([^.]+)\.name$/.exec(path);
  const sub = /^offerings\.([^.]+)\.(variants|addOns)\.([^.]+)\.name$/.exec(path);
  const sup = /^operations\.suppliers\.([^.]+)\.name$/.exec(path);
  const drop = (offeringId: string): BusinessSpec => ({ ...spec, offerings: spec.offerings.filter((o) => o.id !== offeringId) });
  let next: BusinessSpec | undefined;
  let prefix = path;
  if (off) {
    next = drop(off[1]!);
    prefix = `offerings.${off[1]}`;
  } else if (sub) {
    const [, oid, grp, eid] = sub;
    const o = spec.offerings.find((x) => x.id === oid);
    if (grp === "variants" && o && o.variants.length <= 1) {
      next = drop(oid!);
      prefix = `offerings.${oid}`;
    } else {
      next = { ...spec, offerings: spec.offerings.map((x) => (x.id !== oid ? x : { ...x, [grp!]: (x[grp as "variants" | "addOns"] as { id: string }[]).filter((e) => e.id !== eid) })) } as BusinessSpec;
      prefix = `offerings.${oid}.${grp}.${eid}`;
    }
  } else if (sup) {
    next = { ...spec, operations: { ...spec.operations, suppliers: spec.operations.suppliers.filter((s) => slugify(String(s.name.value)) !== sup[1]) } };
    prefix = `operations.suppliers.${sup[1]}`;
  }
  if (next && next.offerings.length === 0) throw new AnswerError("that's your only item: add the right one first, or start over");
  if (next) {
    const under = (p: string) => p === prefix || p.startsWith(`${prefix}.`);
    return { spec: refreshQuestions({ ...next, openQuestions: next.openQuestions.filter((q) => !under(q.fieldPath)) }), removed: "item", prefix };
  }
  if (isMissing(fact)) throw new AnswerError("there is nothing to remove there yet");
  const OPTIONAL = new Set(["description", "initialStock", "stockUnits"]);
  const cleared = OPTIONAL.has(path.split(".").at(-1)!) ? removeFact(spec, path) : setFact(spec, path, missingFact(fact.value));
  return { spec: refreshQuestions({ ...cleared, openQuestions: cleared.openQuestions.filter((q) => q.fieldPath !== path) }), removed: "value", prefix: path };
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

/**
 * Questions the owner may confirm from a review list in one step: the value is the owner's own words or was
 * read from the paper, it is present and valid, and no two sources disagree about it. Guesses ("inferred")
 * and conflicts still need a typed answer, one at a time.
 */
export function batchConfirmable(spec: BusinessSpec): OpenQuestion[] {
  const invalid = invalidFacts(spec);
  return spec.openQuestions.filter((q) => {
    if (q.status !== "open" && q.status !== "asked") return false;
    if (q.candidates && q.candidates.length > 1) return false;
    const f = getFact(spec, q.fieldPath);
    return !!f && !isMissing(f) && f.provenance !== "inferred" && !invalid.has(q.fieldPath);
  });
}

/** Pure. Confirms each listed question that is still batch-confirmable when its turn comes; the rest are skipped with a reason. */
export function confirmMany(
  spec: BusinessSpec,
  questionIds: readonly string[],
): { spec: BusinessSpec; confirmed: { path: string; before: AnyFact; after: AnyFact }[]; skipped: { id: string; reason: string }[] } {
  let cur = spec;
  const confirmed: { path: string; before: AnyFact; after: AnyFact }[] = [];
  const skipped: { id: string; reason: string }[] = [];
  for (const id of new Set(questionIds)) {
    if (!batchConfirmable(cur).some((q) => q.id === id)) {
      skipped.push({ id, reason: "needs a typed answer (a guess, a conflict, missing or invalid)" });
      continue;
    }
    try {
      const r = applyAnswer(cur, id, { confirm: true });
      cur = r.spec;
      confirmed.push({ path: r.path, before: r.before, after: r.after });
    } catch (e) {
      skipped.push({ id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { spec: cur, confirmed, skipped };
}
