// Shared machinery for the reducers in index.ts. All posting math is delegated to @napkin/ledger-core;
// this file only translates between SpacetimeDB rows and ledger-core inputs/outputs, resolves roles
// from ctx.sender, and enforces the invariants that need database state (3, 5, 6, 7, 8).

import { SenderError, type InferSchema, type ReducerCtx } from "spacetimedb/server";
import {
  Rational,
  post,
  computeDocument,
  reversalOf,
  periodOf,
  balanceKey,
  applyMovements,
  checkBalanced,
  checkPeriodOpen,
  checkSegregation,
  checkStockNonNegative,
  PolicyCheckError,
  UnbalancedPostingError,
  FractionalCentsError,
  UnknownNameError,
  DslTypeError,
  type DocumentDef,
  type DocumentInput,
  type JournalLine,
  type Movement,
  type PostingContext,
  type PostingResult,
  type RegisterBalance,
  type Scalar,
} from "@napkin/ledger-core";
import { parseConfiguration, parseProofReport, checkConfigurationSemantics, type Configuration, type DocumentType } from "@napkin/schema";
import spacetimedb from "./schema";

export type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type Db = Ctx["db"];
export type BusinessRow = NonNullable<ReturnType<Db["business"]["id"]["find"]>>;
export type DocRow = NonNullable<ReturnType<Db["document"]["id"]["find"]>>;
export type OrderRow = NonNullable<ReturnType<Db["customerOrder"]["id"]["find"]>>;
export type ActorRow = NonNullable<ReturnType<Db["actor"]["identity"]["find"]>>;
export type FieldValueT = { name: string; value: string };
export type DocLineT = { values: FieldValueT[] };
export type Identity = Ctx["sender"];
export type Timestamp = Ctx["timestamp"];

export const ROLES = ["owner", "system", "storefront", "shopkeeper", "support", "bookkeeper"] as const;
export const GRANTABLE_ROLES = ["owner", "storefront", "shopkeeper", "support", "bookkeeper"] as const;

export const fail = (msg: string): never => {
  throw new SenderError(msg);
};

/** Run a reducer body; any non-SenderError becomes a SenderError with a readable message (still rolls back). */
export function run(name: string, body: () => void): void {
  try {
    body();
  } catch (e) {
    if (e instanceof SenderError) throw e;
    throw new SenderError(`${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function makeTimestamp(ctx: Ctx, micros: bigint): Timestamp {
  // spacetimedb/server does not export Timestamp; construct through the runtime's own class.
  const C = ctx.timestamp.constructor as new (m: bigint) => Timestamp;
  return new C(micros);
}

// ---------- money / number formatting ----------

/** Integer cents -> exact decimal dollars, e.g. 1500n -> "15.00". */
export function centsToDecimal(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/** Exact string for a rational: a terminating decimal when possible, else "n/d" (Rational.parse reads both). */
export function rationalToString(r: Rational): string {
  const s = r.toDecimal(12);
  return s.endsWith("…") ? r.toJSON() : s;
}

export function parseExact(text: string, what: string): Rational {
  try {
    return Rational.parse(text);
  } catch {
    return fail(`${what}: "${text}" is not an exact decimal`);
  }
}

// ---------- identity & roles ----------

export interface Caller {
  identity: Identity;
  role: string;
  name: string;
}

export function actorOf(ctx: Ctx): ActorRow | null {
  return ctx.db.actor.identity.find(ctx.sender) ?? null;
}

export function isSystem(ctx: Ctx): boolean {
  const a = actorOf(ctx);
  return !!a && a.role === "system" && a.businessId === "*";
}

/** Resolve the caller's role for a business from ctx.sender. Never from arguments. */
export function callerFor(ctx: Ctx, businessId: string): Caller {
  const a = actorOf(ctx);
  if (!a) return fail("unknown caller: this identity has no role (redeem a role grant first)");
  if (a.role === "system" && a.businessId === "*") return { identity: ctx.sender, role: "system", name: a.name };
  if (a.businessId !== businessId) return fail(`permission denied: caller is not an actor of business "${businessId}"`);
  return { identity: ctx.sender, role: a.role, name: a.name };
}

export function requireSystemActor(ctx: Ctx): Caller {
  if (!isSystem(ctx)) fail("permission denied: only the platform system actor may do this");
  return { identity: ctx.sender, role: "system", name: "system" };
}

export function getBusiness(ctx: Ctx, id: string): BusinessRow {
  return ctx.db.business.id.find(id) ?? fail(`unknown business "${id}"`);
}

/**
 * Role permission check (skipped for the red-team baseline). owner has every permission;
 * `allowed` lists the other roles that may act.
 */
export function requireRole(biz: BusinessRow, caller: Caller, allowed: readonly string[], what: string, ownerAllowed = true): void {
  if (!biz.enforce) return;
  if ((ownerAllowed && caller.role === "owner") || allowed.includes(caller.role)) return;
  const list = ownerAllowed ? ["owner", ...allowed.filter((r) => r !== "owner")] : allowed;
  fail(`permission denied: role "${caller.role}" cannot ${what} (allowed: ${list.join(", ")})`);
}

export const systemOnly = (biz: BusinessRow, caller: Caller, what: string) => requireRole(biz, caller, ["system"], what, false);
export const ownerOnly = (biz: BusinessRow, caller: Caller, what: string) => requireRole(biz, caller, [], what, true);

export function hasOwner(ctx: Ctx, businessId: string): boolean {
  for (const a of ctx.db.actor.businessId.filter(businessId)) if (a.role === "owner") return true;
  return false;
}

/** Numeric role limit from the configuration (e.g. support.maxRefundCents), or undefined. */
export function roleLimit(cfg: Configuration, role: string, key: string): Rational | undefined {
  const v = cfg.roles.find((r) => r.id === role)?.limits[key];
  if (v === undefined) return undefined;
  return parseExact(String(v), `role ${role} limit ${key}`);
}

// ---------- configuration ----------

interface CachedConfig {
  json: string;
  cfg: Configuration;
  ctx: PostingContext;
}
// Parsed configurations, keyed by config_version.id. Safe across transactions and instances because a hit
// is used only if the stored JSON is byte-identical to the row's JSON (a rolled-back or reused id can
// never serve stale content), and the cached objects are deep-frozen so no reducer can mutate them.
const configCache = new Map<bigint, CachedConfig>();

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

export function parseConfigurationJson(json: string): Configuration {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    return fail(`configuration JSON does not parse: ${(e as Error).message}`);
  }
  let cfg: Configuration;
  try {
    cfg = parseConfiguration(raw);
  } catch (e) {
    return fail((e as Error).message);
  }
  const issues = checkConfigurationSemantics(cfg);
  if (issues.length) {
    fail(`configuration has ${issues.length} semantic issue(s): ${issues.slice(0, 6).map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  }
  return deepFreeze(cfg);
}

export function postingContextOf(cfg: Configuration): PostingContext {
  const policies: Record<string, Scalar> = {};
  for (const [k, v] of Object.entries(cfg.policies)) if (typeof v === "string" || typeof v === "number") policies[k] = v;
  return deepFreeze({
    policies,
    catalogs: cfg.catalogs.map((c) => ({ id: c.id, lineKey: c.lineKey, entries: c.entries.map((e) => ({ id: e.id, data: e.data })) })),
  });
}

export function loadConfig(ctx: Ctx, configId: bigint): CachedConfig & { row: NonNullable<ReturnType<Db["configVersion"]["id"]["find"]>> } {
  const row = ctx.db.configVersion.id.find(configId) ?? fail(`unknown configuration ${configId}`);
  let hit = configCache.get(configId);
  if (!hit || hit.json !== row.json) {
    const cfg = parseConfigurationJson(row.json);
    hit = { json: row.json, cfg, ctx: postingContextOf(cfg) };
    configCache.set(configId, hit);
  }
  return { ...hit, row };
}

export function activeConfig(ctx: Ctx, biz: BusinessRow) {
  if (biz.activeConfigId === 0n) fail(`business "${biz.id}" has no active configuration yet`);
  return loadConfig(ctx, biz.activeConfigId);
}

/** Reject any proof report containing a failed proof (top level or any detail). "" = no report yet. */
export function validateProofReport(json: string): void {
  if (json.trim() === "") return;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    fail(`proof report JSON does not parse: ${(e as Error).message}`);
  }
  let report;
  try {
    report = parseProofReport(raw);
  } catch (e) {
    return fail((e as Error).message);
  }
  for (const key of ["balanceProof", "discountProof", "flowCheck"] as const) {
    const p = report[key];
    if (p.status === "failed") fail(`proof report: ${key} failed; a configuration with a failed proof is never accepted`);
    for (const d of p.details) if (d.status === "failed") fail(`proof report: ${key} failed for ${d.subject}${d.message ? `: ${d.message}` : ""}`);
  }
}

export function docDef(cfg: Configuration, docType: string): DocumentType {
  return cfg.documents.find((d) => d.id === docType) ?? fail(`the configuration has no document type "${docType}"`);
}

// ---------- document values ----------

const DECIMAL = /^-?\d+(\.\d+)?$/;
const FRACTION = /^-?\d+\/\d+$/;

/** Validate caller-visible values against the document definition (unknown, duplicate, missing, malformed). */
export function validateDocValues(def: DocumentType, fields: readonly FieldValueT[], lines: readonly DocLineT[]): void {
  const check = (defs: DocumentType["fields"], vals: readonly FieldValueT[], where: string) => {
    const seen = new Set<string>();
    for (const v of vals) {
      const fd = defs.find((d) => d.name === v.name) ?? fail(`${def.id} ${where}: unknown field "${v.name}"`);
      if (seen.has(v.name)) fail(`${def.id} ${where}: duplicate field "${v.name}"`);
      seen.add(v.name);
      if (fd.type !== "string" && v.value !== "") {
        if (!DECIMAL.test(v.value) && !FRACTION.test(v.value)) fail(`${def.id} ${where}: field "${v.name}" must be an exact decimal, got "${v.value}"`);
        const r = parseExact(v.value, `${def.id} ${where}: field "${v.name}"`);
        if (fd.type === "qty" && !r.isInteger()) fail(`${def.id} ${where}: quantity "${v.name}" must be a whole number`);
      }
    }
    for (const fd of defs) {
      if (fd.required && !vals.find((v) => v.name === fd.name && v.value !== "")) fail(`${def.id} ${where}: required field "${fd.name}" is missing`);
    }
  };
  check(def.fields, fields, "document");
  if (def.lineFields.length === 0 && lines.length > 0) fail(`${def.id} has no lines`);
  lines.forEach((l, i) => check(def.lineFields, l.values, `line ${i}`));
}

export function toInput(fields: readonly FieldValueT[], lines: readonly DocLineT[]): DocumentInput {
  const f: Record<string, string> = {};
  for (const v of fields) f[v.name] = v.value;
  return { fields: f, lines: lines.map((l) => Object.fromEntries(l.values.map((v) => [v.name, v.value]))) };
}

export function fieldOf(fields: readonly FieldValueT[], name: string): string {
  return fields.find((f) => f.name === name)?.value ?? "";
}

export function withField(fields: readonly FieldValueT[], name: string, value: string): FieldValueT[] {
  const out = fields.filter((f) => f.name !== name);
  out.push({ name, value });
  return out;
}

/** Keep only fields the definition declares, in declaration order. */
export function declaredFields(def: DocumentType, values: Record<string, string>): FieldValueT[] {
  return def.fields.filter((f) => values[f.name] !== undefined).map((f) => ({ name: f.name, value: values[f.name]! }));
}

// ---------- posting ----------

function translatePostingError(e: unknown, docType: string): SenderError {
  if (e instanceof SenderError) return e;
  if (e instanceof PolicyCheckError) return new SenderError(`invariant 4 (policy): ${docType} refused: ${e.message}`);
  if (e instanceof UnbalancedPostingError) return new SenderError(`invariant 1 (balanced): ${e.message}`);
  if (e instanceof FractionalCentsError) return new SenderError(`${docType}: ${e.message}`);
  if (e instanceof UnknownNameError) return new SenderError(`${docType}: missing value: ${e.message}`);
  if (e instanceof DslTypeError) return new SenderError(`${docType}: rule error: ${e.message}`);
  return new SenderError(`${docType}: cannot post: ${e instanceof Error ? e.message : String(e)}`);
}

/** ledger-core post(); policy checks are skipped only for the red-team baseline. */
export function runPost(biz: BusinessRow, cc: CachedConfig, def: DocumentType, input: DocumentInput): PostingResult {
  let r: PostingResult;
  try {
    r = post(def as unknown as DocumentDef, input, cc.ctx, { skipChecks: !biz.enforce });
  } catch (e) {
    throw translatePostingError(e, def.id);
  }
  const v = checkBalanced(r.journal);
  if (v) fail(`invariant 1 (balanced): ${v.message}`);
  return r;
}

export function computeOnly(cc: CachedConfig, def: DocumentType, input: DocumentInput) {
  try {
    return computeDocument(def as unknown as DocumentDef, input, cc.ctx).computed;
  } catch (e) {
    throw translatePostingError(e, def.id);
  }
}

/** Headline amount: doc.total (sales), else the amount / fee field (money docs), else 0. */
export function headlineCents(result: PostingResult, input: DocumentInput): bigint {
  try {
    const t = result.computed.doc["total"];
    if (t) return t.toCents();
    for (const k of ["amount", "fee"]) {
      const v = input.fields[k];
      if (v !== undefined && v !== "") return Rational.parse(String(v)).toCents();
    }
  } catch (e) {
    fail(`headline amount: ${(e as Error).message}`);
  }
  return 0n;
}

export function dimsKeyOf(dims: Record<string, string>): string {
  return Object.keys(dims)
    .sort()
    .map((k) => `${k}=${dims[k]}`)
    .join(",");
}

function dimsFromKey(key: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (key === "") return out;
  for (const part of key.split(",")) {
    const i = part.indexOf("=");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

interface BalanceUpdate {
  key: string;
  registerId: string;
  dimsKey: string;
  exists: boolean;
  before: RegisterBalance;
  after: RegisterBalance;
}

/**
 * Apply movements to the stored running balances (ledger-core applyMovements) and enforce invariant 3:
 * no balance register may go below zero unless register.allowNegative or policies.backordersAllowed.
 * Returns the updates to write; writes nothing.
 */
export function planBalances(ctx: Ctx, biz: BusinessRow, cfg: Configuration, movements: readonly Pick<Movement, "register" | "dims" | "kind" | "qty" | "amountCents">[]): BalanceUpdate[] {
  const before = new Map<string, RegisterBalance>();
  const meta = new Map<string, { key: string; registerId: string; dimsKey: string; exists: boolean }>();
  for (const m of movements) {
    const reg = cfg.registers.find((r) => r.id === m.register) ?? fail(`unknown register "${m.register}"`);
    const bk = balanceKey(reg.id, m.dims);
    if (meta.has(bk)) continue;
    const dimsKey = dimsKeyOf(m.dims);
    const key = `${biz.id}|${reg.id}|${dimsKey}`;
    const row = ctx.db.registerBalance.key.find(key);
    before.set(bk, { qty: row?.qty ?? 0n, amountCents: row?.amountCents ?? 0n });
    meta.set(bk, { key, registerId: reg.id, dimsKey, exists: !!row });
  }
  const after = applyMovements(before, [...movements]);
  // Only balances this document lowers are checked, so a receipt can always top up a register.
  const lowered = new Map([...after].filter(([k, b]) => b.qty < before.get(k)!.qty));
  const allowNegative = (register: string) => !!cfg.registers.find((r) => r.id === register)?.allowNegative || cfg.policies.backordersAllowed;
  const v = checkStockNonNegative(lowered, allowNegative);
  if (v) {
    const [bk] = [...lowered].find(([k, b]) => b.qty < 0n && !allowNegative(k.slice(0, k.indexOf("|"))))!;
    const m = meta.get(bk)!;
    fail(`invariant 3 (stock): not enough ${m.registerId} for ${m.dimsKey}: available ${before.get(bk)!.qty}, would go to ${after.get(bk)!.qty}`);
  }
  return [...meta].map(([bk, m]) => ({ ...m, before: before.get(bk)!, after: after.get(bk)! }));
}

/** Invariant 8: returns the open posting period for now ("YYYY-MM", UTC); refuses a closed one. */
export function openPeriod(ctx: Ctx, businessId: string): string {
  const month = periodOf(ctx.timestamp.microsSinceUnixEpoch);
  const key = `${businessId}|${month}`;
  const p = ctx.db.period.key.find(key);
  const closed = new Set(p && p.status === "closed" ? [month] : []);
  const v = checkPeriodOpen(month, closed);
  if (v) fail(`invariant 8 (closed period): ${v.message}; nothing can post into it`);
  if (!p) ctx.db.period.insert({ key, businessId, month, status: "open", closedBy: undefined, closedAt: undefined });
  return month;
}

export function nextNumber(ctx: Ctx, businessId: string, docType: string): bigint {
  let max = 0n;
  for (const d of ctx.db.document.by_business_type.filter([businessId, docType])) if (d.number > max) max = d.number;
  return max + 1n;
}

function writeEntries(ctx: Ctx, biz: BusinessRow, documentId: bigint, month: string, journal: readonly JournalLine[], movements: readonly Movement[], balances: readonly BalanceUpdate[]) {
  for (const j of journal) {
    ctx.db.journalLine.insert({
      id: 0n,
      businessId: biz.id,
      documentId,
      accountCode: j.account,
      period: month,
      debitCents: j.debitCents,
      creditCents: j.creditCents,
      ruleId: j.ruleId,
      memo: j.memo ?? "",
      lineIndex: j.lineIndex ?? -1,
      postedAt: ctx.timestamp,
    });
  }
  for (const m of movements) {
    ctx.db.registerMovement.insert({
      id: 0n,
      businessId: biz.id,
      documentId,
      registerId: m.register,
      dimsKey: dimsKeyOf(m.dims),
      kind: m.kind,
      qty: m.qty,
      amountCents: m.amountCents,
      period: month,
      postedAt: ctx.timestamp,
    });
  }
  for (const b of balances) {
    const row = { key: b.key, businessId: biz.id, registerId: b.registerId, dimsKey: b.dimsKey, qty: b.after.qty, amountCents: b.after.amountCents };
    if (b.exists) ctx.db.registerBalance.key.update(row);
    else ctx.db.registerBalance.insert(row);
  }
}

/** Approval permission + invariant 5 (segregation of duties). Skipped for the baseline. */
export function checkCanApprove(biz: BusinessRow, def: DocumentType, doc: DocRow, caller: Caller): void {
  if (!biz.enforce) return;
  if (caller.role !== "owner" && !def.approval.approverRoles.includes(caller.role)) {
    fail(`permission denied: role "${caller.role}" cannot approve ${def.id} (approvers: ${["owner", ...def.approval.approverRoles.filter((r) => r !== "owner")].join(", ")})`);
  }
  const v = checkSegregation(doc.createdBy.toHexString(), caller.identity.toHexString(), def.approval.cannotApproveOwn);
  if (v) fail(`invariant 5 (segregation of duties): ${v.message} (${def.id} #${doc.number} was created by this identity)`);
}

/**
 * Post a draft: ledger-core post() (invariants 1, 4), period open (8), balances (3), then write journal
 * lines, movements and balances and mark the document posted. Validation happens before any write
 * except the lazily-created open period row, so a caller may catch a failure and continue.
 */
export function postDraft(ctx: Ctx, biz: BusinessRow, doc: DocRow, approver: Caller): DocRow {
  if (doc.status !== "draft") fail(`invariant 8 (immutable): document ${doc.id} is ${doc.status}; only drafts can be posted`);
  const cc = loadConfig(ctx, doc.configId);
  const def = docDef(cc.cfg, doc.docType);
  validateDocValues(def, doc.fields, doc.lines);
  const input = toInput(doc.fields, doc.lines);
  const result = runPost(biz, cc, def, input);
  const month = openPeriod(ctx, biz.id);
  const balances = planBalances(ctx, biz, cc.cfg, result.movements);
  writeEntries(ctx, biz, doc.id, month, result.journal, result.movements, balances);
  return ctx.db.document.id.update({
    ...doc,
    status: "posted",
    period: month,
    totalCents: headlineCents(result, input),
    approvedBy: approver.identity,
    approvedByRole: approver.role,
    postedAt: ctx.timestamp,
  });
}

export interface NewDoc {
  docType: string;
  externalRef: string;
  fields: FieldValueT[];
  lines: DocLineT[];
  note: string;
}

/** Validate + dry-run a document, then insert it as a draft. Returns the row and the dry-run result. */
export function insertDraft(ctx: Ctx, biz: BusinessRow, configId: bigint, creator: Caller, d: NewDoc) {
  const cc = loadConfig(ctx, configId);
  const def = docDef(cc.cfg, d.docType);
  validateDocValues(def, d.fields, d.lines);
  const input = toInput(d.fields, d.lines);
  const result = runPost(biz, cc, def, input);
  const row = ctx.db.document.insert({
    id: 0n,
    businessId: biz.id,
    docType: d.docType,
    number: nextNumber(ctx, biz.id, d.docType),
    status: "draft",
    period: periodOf(ctx.timestamp.microsSinceUnixEpoch),
    externalRef: d.externalRef,
    fields: d.fields,
    lines: d.lines,
    totalCents: headlineCents(result, input),
    configId,
    createdBy: creator.identity,
    createdByRole: creator.role,
    approvedBy: undefined,
    approvedByRole: "",
    createdAt: ctx.timestamp,
    postedAt: undefined,
    reversalOf: 0n,
    reversedBy: 0n,
    note: d.note,
  });
  return { row, result, def, cc };
}

/** Reverse a posted document: ledger-core reversalOf() over its stored lines, posted into the open period. */
export function reversePosted(ctx: Ctx, biz: BusinessRow, doc: DocRow, caller: Caller, reason: string): DocRow {
  if (doc.status !== "posted") fail(`document ${doc.id} is ${doc.status}; only posted documents can be reversed`);
  if (doc.reversalOf !== 0n) fail(`document ${doc.id} is itself a reversal and cannot be reversed`);
  const cc = loadConfig(ctx, doc.configId);
  const journal: JournalLine[] = [...ctx.db.journalLine.documentId.filter(doc.id)].map((j) => ({
    ruleId: j.ruleId,
    account: j.accountCode,
    debitCents: j.debitCents,
    creditCents: j.creditCents,
    lineIndex: j.lineIndex < 0 ? null : j.lineIndex,
    memo: j.memo || undefined,
  }));
  const movements: Movement[] = [...ctx.db.registerMovement.documentId.filter(doc.id)].map((m) => ({
    ruleId: "",
    register: m.registerId,
    kind: m.kind === "in" ? "in" : "out",
    dims: dimsFromKey(m.dimsKey),
    qty: m.qty,
    amountCents: m.amountCents,
    lineIndex: null,
  }));
  const rev = reversalOf({ journal, movements });
  const v = checkBalanced(rev.journal);
  if (v) fail(`invariant 1 (balanced): reversal ${v.message}`);
  const month = openPeriod(ctx, biz.id);
  const balances = planBalances(ctx, biz, cc.cfg, rev.movements);
  const r = ctx.db.document.insert({
    ...doc,
    id: 0n,
    number: nextNumber(ctx, biz.id, doc.docType),
    status: "posted",
    period: month,
    createdBy: caller.identity,
    createdByRole: caller.role,
    approvedBy: caller.identity,
    approvedByRole: caller.role,
    createdAt: ctx.timestamp,
    postedAt: ctx.timestamp,
    reversalOf: doc.id,
    reversedBy: 0n,
    note: reason,
  });
  writeEntries(ctx, biz, r.id, month, rev.journal, rev.movements, balances);
  ctx.db.document.id.update({ ...doc, status: "reversed", reversedBy: r.id });
  return r;
}

// ---------- item_seller specifics ----------

/** The catalog sale lines are keyed on (lineKey "productId"). */
export function productCatalog(cfg: Configuration) {
  return cfg.catalogs.find((c) => c.lineKey === "productId") ?? fail("the configuration has no product catalog (lineKey productId)");
}

/**
 * Invariant 6: prices, costs and stock units come from the ACTIVE catalog, never from the caller.
 * With `callerValues` (baseline only) caller-supplied unitPrice/unitCost/stockItem/stockUnits win.
 */
export function fillSaleLine(cfg: Configuration, productId: string, qty: string, callerValues?: Record<string, string>): DocLineT {
  const cat = productCatalog(cfg);
  const entry = cat.entries.find((e) => e.id === productId) ?? fail(`unknown product "${productId}"`);
  const get = (k: string) => {
    const v = entry.data[k];
    if (v === undefined || v === null || typeof v === "boolean") return fail(`product "${productId}" has no ${k} in the catalog`);
    return String(v);
  };
  const from = (lineField: string, catField: string) => (callerValues && callerValues[lineField] !== undefined ? callerValues[lineField]! : get(catField));
  return {
    values: [
      { name: "productId", value: productId },
      { name: "qty", value: qty },
      { name: "unitPrice", value: from("unitPrice", "price") },
      { name: "unitCost", value: from("unitCost", "cost") },
      { name: "stockItem", value: from("stockItem", "stockItem") },
      { name: "stockUnits", value: from("stockUnits", "stockUnits") },
    ],
  };
}

/** Opening stock lines from initialStock, unitCost from the stock_items catalog (never assumed). */
export function openingLines(cfg: Configuration): DocLineT[] {
  const items = Object.entries(cfg.initialStock ?? {}).filter(([, q]) => q > 0);
  if (items.length === 0) return [];
  const cat = cfg.catalogs.find((c) => c.lineKey === "stockItem") ?? fail("initialStock needs a stock items catalog (lineKey stockItem)");
  return items.map(([item, qty]) => {
    const e = cat.entries.find((x) => x.id === item) ?? fail(`initialStock item "${item}" is not in catalog "${cat.id}"`);
    const c = e.data["unitCost"];
    if (c === undefined || c === null || typeof c === "boolean") fail(`stock item "${item}" has no unitCost`);
    return {
      values: [
        { name: "stockItem", value: item },
        { name: "qty", value: String(qty) },
        { name: "unitCost", value: String(c) },
      ],
    };
  });
}

/** Catalog entry data -> FieldValue[] (null values are omitted). */
export function catalogData(data: Record<string, Scalar | boolean | null>): FieldValueT[] {
  return Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([name, v]) => ({ name, value: String(v) }));
}

export interface RefundFacts {
  saleTotal: Rational;
  saleNet: Rational;
  saleCost: Rational;
  refundedSoFarCents: bigint;
  sale: DocRow;
}

/** Facts about an order's posted sale, recomputed with ledger-core from the stored sale document. */
export function refundFacts(ctx: Ctx, order: OrderRow): RefundFacts {
  const sale = ctx.db.document.id.find(order.saleDocumentId) ?? fail(`order ${order.id} has no sale document`);
  if (sale.status !== "posted") fail(`order ${order.id}: its sale is ${sale.status}, so there is nothing to refund`);
  const cc = loadConfig(ctx, sale.configId);
  const def = docDef(cc.cfg, sale.docType);
  const computed = computeOnly(cc, def, toInput(sale.fields, sale.lines));
  let net = Rational.ZERO;
  let cost = Rational.ZERO;
  for (const l of computed.lines) {
    if (!l["net"] || !l["cost"]) fail("the sale definition has no line.net / line.cost to compute refunds from");
    net = net.add(l["net"]!);
    cost = cost.add(l["cost"]!);
  }
  let refunded = 0n;
  for (const d of ctx.db.document.externalRef.filter(order.id)) {
    if (d.businessId === order.businessId && d.docType === "refund" && d.status === "posted" && d.reversalOf === 0n) refunded += d.totalCents;
  }
  return { saleTotal: Rational.fromCents(sale.totalCents), saleNet: net, saleCost: cost, refundedSoFarCents: refunded, sale };
}

export function hoursBetween(from: Timestamp, to: Timestamp): Rational {
  return Rational.of(to.microsSinceUnixEpoch - from.microsSinceUnixEpoch, 3_600_000_000n);
}

export function processorRefFor(ctx: Ctx, businessId: string, orderId: string): string {
  for (const d of ctx.db.document.externalRef.filter(orderId)) {
    if (d.businessId === businessId && d.docType === "payment_received" && d.status === "posted") return fieldOf(d.fields, "processorRef");
  }
  return "";
}

export function audit(ctx: Ctx, businessId: string, actorRole: string, reducer: string, summary: string): void {
  ctx.db.auditLog.insert({ id: 0n, businessId, actorRole, reducer, summary: summary.slice(0, 500), ok: true, timestamp: ctx.timestamp });
}

export function openInboxItem(ctx: Ctx, businessId: string, fromRole: string, question: string, context: unknown, documentRef: string) {
  return ctx.db.inboxItem.insert({
    id: 0n,
    businessId,
    fromRole,
    question,
    contextJson: JSON.stringify(context, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    documentRef,
    status: "open",
    answer: "",
    createdAt: ctx.timestamp,
    answeredAt: undefined,
  });
}

export function requireJson(text: string, what: string): void {
  if (text === "") return;
  try {
    JSON.parse(text);
  } catch {
    fail(`${what} must be JSON`);
  }
}
