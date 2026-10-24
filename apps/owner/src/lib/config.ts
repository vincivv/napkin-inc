// The active Configuration (packages/schema) as the owner app reads it: names for accounts,
// registers, document types and catalog entries, plus the owner-unconfirmed placeholders.

import { parseConfiguration, parseProofReport, type Configuration, type ProofReport } from "@napkin/schema";
import type { ConfigVersionRow } from "@/data/types";

export interface ConfigView {
  row: ConfigVersionRow;
  config: Configuration | undefined;
  /** set when the stored JSON does not validate against the Configuration contract */
  error: string | undefined;
  proof: ProofReport | undefined;
  proofError: string | undefined;
}

export function readConfig(row: ConfigVersionRow | undefined): ConfigView | undefined {
  if (!row) return undefined;
  let config: Configuration | undefined;
  let error: string | undefined;
  try {
    config = parseConfiguration(JSON.parse(row.json));
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  let proof: ProofReport | undefined;
  let proofError: string | undefined;
  const proofJson = row.proofReportJson.trim() || "";
  if (proofJson) {
    try {
      proof = parseProofReport(JSON.parse(proofJson));
    } catch (e) {
      proofError = e instanceof Error ? e.message : String(e);
    }
  } else if (config?.proofReport) {
    proof = config.proofReport;
  }
  return { row, config, error, proof, proofError };
}

export interface Names {
  account(code: string): string;
  accountType(code: string): string | undefined;
  register(id: string): string;
  docType(id: string): string;
  /** product / stock-item display name, from any catalog entry with a `name` */
  entry(id: string): string;
  /** "item=choc_chip_cookie,..." -> "Chocolate chip cookie (baked)" */
  dims(dimsKey: string): string;
}

export function parseDims(dimsKey: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of dimsKey.split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

export function makeNames(config: Configuration | undefined): Names {
  const accounts = new Map((config?.chartOfAccounts ?? []).map((a) => [a.code, a]));
  const registers = new Map((config?.registers ?? []).map((r) => [r.id, r.name]));
  const docs = new Map((config?.documents ?? []).map((d) => [d.id, d.name]));
  const entries = new Map<string, string>();
  for (const c of config?.catalogs ?? []) {
    for (const e of c.entries) {
      const n = e.data["name"];
      if (typeof n === "string" && !entries.has(e.id)) entries.set(e.id, n);
    }
  }
  const entry = (id: string) => entries.get(id) ?? id;
  return {
    account: (code) => accounts.get(code)?.name ?? `Account ${code}`,
    accountType: (code) => accounts.get(code)?.type,
    register: (id) => registers.get(id) ?? id,
    docType: (id) => docs.get(id) ?? id.replace(/_/g, " "),
    entry,
    dims: (dimsKey) => {
      const d = parseDims(dimsKey);
      const vals = Object.values(d);
      return vals.length ? vals.map(entry).join(" · ") : dimsKey || "—";
    },
  };
}

/** The value at a dotted path inside the configuration, e.g. "catalogs.products.entries.cookie_box6.data.cost". */
export function valueAtPath(config: Configuration | undefined, path: string): string | undefined {
  if (!config) return undefined;
  let cur: unknown = config;
  for (const seg of path.split(".")) {
    if (Array.isArray(cur)) cur = cur.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === seg);
    else if (cur && typeof cur === "object") cur = (cur as Record<string, unknown>)[seg];
    else return undefined;
  }
  if (cur === undefined) return undefined;
  return typeof cur === "string" ? cur : JSON.stringify(cur);
}

/** Human label for a placeholder path. */
export function describePath(config: Configuration | undefined, path: string): string {
  const segs = path.split(".");
  if (segs[0] === "catalogs" && segs[2] === "entries") {
    const names = makeNames(config);
    const field = segs[segs.length - 1] ?? "";
    const label: Record<string, string> = { cost: "Ingredient cost", stockUnits: "Cookies used from stock", price: "Price" };
    return `${label[field] ?? field} — ${names.entry(segs[3] ?? "")}`;
  }
  if (segs[0] === "initialStock") return `Starting stock — ${makeNames(config).entry(segs[1] ?? "")}`;
  if (segs[0] === "policies") return `Policy — ${segs[1] === "taxRate" ? "sales tax rate" : segs[1]}`;
  if (segs[0] === "business") {
    const m: Record<string, string> = { pickupLocation: "Pickup location", hours: "Opening hours", timezone: "Time zone" };
    return m[segs[1] ?? ""] ?? path;
  }
  return path;
}

/** Products (catalog with lineKey productId) with their stock usage; used for low-stock thresholds. */
export function productsUsingStock(config: Configuration | undefined): Map<string, { productId: string; name: string; units: bigint }[]> {
  const out = new Map<string, { productId: string; name: string; units: bigint }[]>();
  const products = config?.catalogs.find((c) => c.lineKey === "productId");
  for (const e of products?.entries ?? []) {
    const item = e.data["stockItem"];
    const units = e.data["stockUnits"];
    if (typeof item !== "string" || !item) continue;
    let u = 0n;
    try {
      u = BigInt(String(units ?? "0"));
    } catch {
      continue;
    }
    if (u <= 0n) continue;
    const list = out.get(item) ?? [];
    list.push({ productId: e.id, name: String(e.data["name"] ?? e.id), units: u });
    out.set(item, list);
  }
  return out;
}
