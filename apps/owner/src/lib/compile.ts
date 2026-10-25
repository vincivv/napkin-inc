// Build page helpers: the brain's POST /compile Server-Sent Events stream, and a configuration diff
// (prices, policies, accounts, stock, role limits, storefront) between the active and a pending version.

import type { Configuration } from "@napkin/schema";
import { BRAIN_URL } from "@/data/env";
import { authHeaders } from "@/data/account";
import { formatCents, parseDollars, rateToPct } from "./money";

export const BUILD_STEPS = ["facts", "template", "synthesis", "proofs", "configuration", "storefront", "agents", "submit"] as const;
export type BuildStep = (typeof BUILD_STEPS)[number];
export const STEP_LABEL: Record<BuildStep, string> = {
  facts: "Facts check",
  template: "Template",
  synthesis: "Posting-rule synthesis",
  proofs: "Dry run and proofs",
  configuration: "Configuration",
  storefront: "Storefront",
  agents: "AI staff",
  submit: "Submit to the books",
};

export interface CompileQuestion {
  id: string;
  fieldPath: string;
  question: string;
  candidates?: string[];
}
export type CompileEvent =
  | { event: "step"; data: { step: BuildStep; status: "running" | "done" | "skipped" | "failed"; message: string; data?: unknown } }
  | { event: "result"; data: { configId: string; version: number; status: string; activated: boolean; message: string } }
  | { event: "error"; data: { code: string; message: string; questions: CompileQuestion[] } };

/** POST /compile and feed each SSE event to onEvent until the stream ends. */
export async function streamCompile(businessId: string, onEvent: (e: CompileEvent) => void, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BRAIN_URL}/compile`, { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify({ businessId }), ...(signal ? { signal } : {}) });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    throw new Error(`Cannot reach the brain at ${BRAIN_URL}. Is it running?`);
  }
  if (!res.ok || !res.body) {
    const b = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(b.error ?? `compile failed to start (${res.status})`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const event = /^event: ?(.*)$/m.exec(block)?.[1];
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.replace(/^data: ?/, "")).join("\n");
      if (event && data) {
        try {
          onEvent({ event, data: JSON.parse(data) } as CompileEvent);
        } catch {
          /* ignore a malformed event */
        }
      }
    }
  }
}

export async function latestCompile(businessId: string): Promise<{ running: boolean; events: CompileEvent[] } | undefined> {
  try {
    const r = await fetch(`${BRAIN_URL}/compile/${businessId}/latest`, { headers: authHeaders() });
    return r.ok ? ((await r.json()) as { running: boolean; events: CompileEvent[] }) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- diff ----------

export type DiffSection = "Prices" | "Policies" | "Accounts" | "Stock" | "Role limits" | "Storefront";
export interface DiffRow {
  section: DiffSection;
  key: string;
  label: string;
  before: string | null;
  after: string | null;
  kind: "added" | "removed" | "changed" | "same";
}

const dollars = (v: unknown) => {
  if (typeof v !== "string") return v === undefined || v === null ? null : String(v);
  try {
    return formatCents(parseDollars(v));
  } catch {
    return v;
  }
};
const RATE_POLICIES = new Set(["taxRate", "marginFloor", "maxDiscount"]);
const policyText = (k: string, v: unknown) => (v === undefined ? null : RATE_POLICIES.has(k) && typeof v === "string" ? rateToPct(v) : k === "refundWindowHours" ? `${v} h` : Array.isArray(v) ? v.join(", ") : String(v));

function row(section: DiffSection, key: string, label: string, before: string | null, after: string | null): DiffRow {
  const kind = before === after ? "same" : before === null ? "added" : after === null ? "removed" : "changed";
  return { section, key, label, before, after, kind };
}

export function diffConfigs(before: Configuration | undefined, after: Configuration): DiffRow[] {
  const out: DiffRow[] = [];
  const prods = (c: Configuration | undefined) => new Map((c?.catalogs.find((x) => x.lineKey === "productId")?.entries ?? []).map((e) => [e.id, e.data]));
  const pb = prods(before);
  const pa = prods(after);
  for (const id of new Set([...pb.keys(), ...pa.keys()])) {
    const b = pb.get(id);
    const a = pa.get(id);
    const name = String(a?.["name"] ?? b?.["name"] ?? id);
    out.push(row("Prices", `${id}.price`, `${name}: price`, b ? dollars(b["price"]) : null, a ? dollars(a["price"]) : null));
    out.push(row("Prices", `${id}.cost`, `${name}: cost`, b ? dollars(b["cost"]) : null, a ? dollars(a["cost"]) : null));
    if (String(a?.["stockItem"] ?? b?.["stockItem"] ?? "") !== "") out.push(row("Prices", `${id}.stockUnits`, `${name}: units of stock used`, b ? String(b["stockUnits"] ?? "") : null, a ? String(a["stockUnits"] ?? "") : null));
  }
  const keys = new Set([...Object.keys(before?.policies ?? {}), ...Object.keys(after.policies)]);
  for (const k of keys) out.push(row("Policies", k, k, policyText(k, (before?.policies as Record<string, unknown> | undefined)?.[k]), policyText(k, (after.policies as Record<string, unknown>)[k])));
  const ab = new Map((before?.chartOfAccounts ?? []).map((a) => [a.code, `${a.code} ${a.name} (${a.type})`]));
  const aa = new Map(after.chartOfAccounts.map((a) => [a.code, `${a.code} ${a.name} (${a.type})`]));
  for (const code of new Set([...ab.keys(), ...aa.keys()])) out.push(row("Accounts", code, code, ab.get(code) ?? null, aa.get(code) ?? null));
  const sb = before?.initialStock ?? {};
  const sa = after.initialStock ?? {};
  for (const k of new Set([...Object.keys(sb), ...Object.keys(sa)])) out.push(row("Stock", k, `starting stock: ${k}`, sb[k] === undefined ? null : String(sb[k]), sa[k] === undefined ? null : String(sa[k])));
  const lim = (c: Configuration | undefined) => new Map((c?.roles ?? []).flatMap((r) => Object.entries(r.limits).map(([k, v]) => [`${r.id}.${k}`, k === "maxRefundCents" ? formatCents(BigInt(String(v))) : k === "maxDiscount" ? rateToPct(String(v)) : String(v)] as const)));
  const lb = lim(before);
  const la = lim(after);
  for (const k of new Set([...lb.keys(), ...la.keys()])) out.push(row("Role limits", k, k, lb.get(k) ?? null, la.get(k) ?? null));
  const sf = (c: Configuration | undefined) => (c ? { headline: c.storefront.headline, tagline: c.storefront.tagline, theme: `${c.storefront.theme.primary} on ${c.storefront.theme.background}${c.storefront.theme.emoji ? ` ${c.storefront.theme.emoji}` : ""}` } : undefined);
  const fb = sf(before);
  const fa = sf(after)!;
  for (const k of ["headline", "tagline", "theme"] as const) out.push(row("Storefront", k, k, fb?.[k] ?? null, fa[k]));
  return out;
}
