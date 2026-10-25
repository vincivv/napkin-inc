// Create or update the Napkin phone-line Managed Agent and its 7 webhook tools on Cartesia (API 2026-08-14).
//
//   pnpm --filter @napkin/brain exec tsx --env-file-if-exists=../../.env scripts/cartesia-setup.ts \
//     https://<your-tunnel>.trycloudflare.com --model <model id> --voice <voice id> [--phone-number-id <id>] [--dry-run]
//   ... scripts/cartesia-setup.ts --list-models          (read-only: GET /v1/agents/models)
//
// --dry-run makes NO network calls: it prints every request it would send, with the bearer secret redacted.
//
// Real run (requires CARTESIA_API_KEY and PHONE_TOOL_SECRET in the env):
//   1. GET   /v1/agents/tools?type=webhook&limit=100[&starting_after=...]  find our tools by name (url contains /phone/tools/)
//   2. POST  /v1/agents/tools            for each missing tool   | PATCH /v1/agents/tools/{tool_id} for each existing one
//   3. GET   /v1/agents?q=<name>&limit=100                        find the agent by exact name
//   4. POST  /v1/agents                   if missing             | PATCH /v1/agents/{agent_id} with the new config
//   5. PATCH /agents/phone-numbers/{id} {agent_id}                only with --phone-number-id (assign inbound calls)
// Headers on every call: Authorization: Bearer $CARTESIA_API_KEY, Cartesia-Version: 2026-08-14.
// (The OpenAPI security scheme is HTTP bearer; some guide pages show X-API-Key instead. The brain's STT call
//  already uses Bearer successfully, so this script does too.)
// Docs: https://docs.cartesia.ai/api-reference/agents/create.md, .../agents/update.md, .../agents/list.md,
//       .../agents/tools/create.md, .../agents/tools/update.md, .../agents/tools/list.md,
//       .../agents/models/list.md, .../agents/phone-numbers/update.md, https://docs.cartesia.ai/agents/webhook-tools.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAgentBody, buildCartesiaTools, CARTESIA_API, CARTESIA_VERSION, type WebhookToolDefinition } from "../src/phone/cartesia-agent";
import { MIN_PHONE_TOOL_SECRET_LENGTH } from "../src/env";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REDACTED = "<PHONE_TOOL_SECRET redacted>";

interface Args {
  brainUrl?: string;
  dryRun: boolean;
  listModels: boolean;
  model?: string;
  voice?: string;
  name: string;
  businessId: string;
  businessName?: string;
  phoneNumberId?: string;
  timezone?: string;
}

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error(
    "usage: cartesia-setup.ts <https://public-brain-url> --model <id> --voice <id> [--name <agent name>] [--business-id maya-cookies]\n" +
      "                         [--business-name \"Maya's Cookies\"] [--phone-number-id <id>] [--timezone <IANA>] [--dry-run]\n" +
      "       cartesia-setup.ts --list-models",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false, listModels: false, name: "", businessId: process.env.PHONE_BUSINESS_ID?.trim() || "maya-cookies" };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]!;
    const val = () => argv[++i] ?? usage(`${k} needs a value`);
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--list-models") a.listModels = true;
    else if (k === "--model") a.model = val();
    else if (k === "--voice") a.voice = val();
    else if (k === "--name") a.name = val();
    else if (k === "--business-id") a.businessId = val();
    else if (k === "--business-name") a.businessName = val();
    else if (k === "--phone-number-id") a.phoneNumberId = val();
    else if (k === "--timezone") a.timezone = val();
    else if (k.startsWith("--")) usage(`unknown flag ${k}`);
    else if (!a.brainUrl) a.brainUrl = k;
    else usage(`unexpected argument ${k}`);
  }
  if (!a.name) a.name = `Napkin phone line (${a.businessId})`;
  return a;
}

/** Business name from the hand-written fixture configuration (never invented). */
function fixtureBusinessName(businessId: string): string | undefined {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../fixtures/maya/configuration.json"), "utf8")) as { businessId?: string; business?: { name?: string; slug?: string } };
    if (cfg.businessId === businessId || cfg.business?.slug === businessId) return cfg.business?.name;
  } catch {
    /* no fixture */
  }
  return undefined;
}

function fixtureKeyterms(businessId: string): string[] {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(HERE, "../../../fixtures/maya/configuration.json"), "utf8")) as {
      businessId?: string;
      business?: { slug?: string };
      catalogs?: { id: string; entries: { data: { name?: string } }[] }[];
    };
    if (cfg.businessId !== businessId && cfg.business?.slug !== businessId) return [];
    return (cfg.catalogs ?? []).filter((c) => c.id === "products").flatMap((c) => c.entries.map((e) => e.data.name ?? "")).filter(Boolean);
  } catch {
    return [];
  }
}

class Cartesia {
  constructor(private readonly key: string) {}
  async req<T>(method: string, p: string, body?: unknown): Promise<T> {
    const res = await fetch(`${CARTESIA_API}${p}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, "Cartesia-Version": CARTESIA_VERSION, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  async listAll<T>(p: string): Promise<T[]> {
    const out: T[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page++) {
      const sep = p.includes("?") ? "&" : "?";
      const r = await this.req<{ data: T[]; has_more: boolean; next_page?: string | null }>("GET", `${p}${sep}limit=100${after ? `&starting_after=${encodeURIComponent(after)}` : ""}`);
      out.push(...r.data);
      if (!r.has_more || !r.next_page) break;
      after = r.next_page;
    }
    return out;
  }
}

const printReq = (method: string, p: string, body?: unknown) => {
  console.log(`\n${method} ${CARTESIA_API}${p}`);
  console.log(`  Authorization: Bearer <CARTESIA_API_KEY>\n  Cartesia-Version: ${CARTESIA_VERSION}`);
  if (body !== undefined) console.log(JSON.stringify(body, null, 2));
};

function redact(tools: WebhookToolDefinition[]): WebhookToolDefinition[] {
  return tools.map((t) => ({ ...t, api_schema: { ...t.api_schema, authentication: { mode: "bearer", token: { type: "secret", secret_value: REDACTED, secret_description: t.api_schema.authentication.token.secret_description } } } }));
}

const withoutType = ({ type: _t, ...rest }: WebhookToolDefinition) => rest;

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  const key = process.env.CARTESIA_API_KEY?.trim();

  if (a.listModels) {
    if (a.dryRun) return printReq("GET", "/v1/agents/models?limit=100");
    if (!key) usage("CARTESIA_API_KEY is not set");
    const models = await new Cartesia(key).listAll<{ id: string; display_name?: string; provider?: string; average_latency_ms?: number | null }>("/v1/agents/models");
    for (const m of models) console.log(`${m.id.padEnd(40)} ${m.provider ?? ""} ${m.display_name ?? ""} ${m.average_latency_ms ?? ""}ms`);
    return;
  }

  if (!a.brainUrl) usage("the public brain URL (Cloudflare tunnel) is required");
  let url: URL;
  try {
    url = new URL(a.brainUrl);
  } catch {
    usage(`not a URL: ${a.brainUrl}`);
  }
  if (url.protocol !== "https:") usage("Cartesia webhook tools must use HTTPS (use the tunnel URL)");
  if (/^(localhost|127\.|10\.|192\.168\.)/.test(url.hostname)) usage("Cartesia blocks private and internal addresses; use the public tunnel URL");
  const brainUrl = url.origin + url.pathname.replace(/\/+$/, "");

  const businessName = a.businessName ?? fixtureBusinessName(a.businessId);
  if (!businessName) usage(`no business name for ${a.businessId}; pass --business-name`);
  const secret = process.env.PHONE_TOOL_SECRET?.trim();

  if (a.dryRun) {
    console.log(`# DRY RUN: no requests are sent. Brain: ${brainUrl}  business: ${a.businessId} (${businessName})`);
    if (!secret || secret.length < MIN_PHONE_TOOL_SECRET_LENGTH) console.log(`# NOTE: PHONE_TOOL_SECRET is missing or shorter than ${MIN_PHONE_TOOL_SECRET_LENGTH} chars; a real run would refuse.`);
    if (!a.model) console.log("# NOTE: --model is missing; a real run would refuse. Pick a Claude id from --list-models.");
    if (!a.voice) console.log("# NOTE: --voice is missing; a real run would refuse. Pick a voice id in the Cartesia Playground.");
    printReq("GET", "/v1/agents/tools?type=webhook&limit=100");
    const tools = redact(buildCartesiaTools({ brainUrl, businessId: a.businessId, secret: undefined }));
    for (const t of tools) printReq("POST", "/v1/agents/tools", t);
    console.log(`\n# (for a tool that already exists, the same body without "type" goes to PATCH /v1/agents/tools/{tool_id})`);
    printReq("GET", `/v1/agents?q=${encodeURIComponent(a.name)}&limit=100`);
    const body = buildAgentBody({
      name: a.name,
      businessName,
      businessId: a.businessId,
      modelId: a.model ?? "<MODEL_ID from --list-models>",
      voiceId: a.voice ?? "<VOICE_ID>",
      toolIds: tools.map((t) => `<id of tool ${t.name}>`),
      keyterms: fixtureKeyterms(a.businessId),
      timezone: a.timezone,
    });
    printReq("POST", "/v1/agents", body);
    console.log(`\n# (if an agent named "${a.name}" exists: PATCH /v1/agents/{agent_id} with the same body)`);
    if (a.phoneNumberId) printReq("PATCH", `/agents/phone-numbers/${encodeURIComponent(a.phoneNumberId)}`, { agent_id: "<agent id>" });
    return;
  }

  if (!key) usage("CARTESIA_API_KEY is not set");
  if (!secret || secret.length < MIN_PHONE_TOOL_SECRET_LENGTH) usage(`PHONE_TOOL_SECRET must be set (at least ${MIN_PHONE_TOOL_SECRET_LENGTH} chars) and match the brain's`);
  if (!a.model) usage("--model is required (see --list-models; pick a Claude model)");
  if (!a.voice) usage("--voice is required (a Cartesia voice id)");

  const api = new Cartesia(key);
  const defs = buildCartesiaTools({ brainUrl, businessId: a.businessId, secret });
  const existing = await api.listAll<{ id: string; name: string; type: string; api_schema?: { url?: string } }>("/v1/agents/tools?type=webhook");
  const toolIds: string[] = [];
  for (const def of defs) {
    const found = existing.find((t) => t.name === def.name && (t.api_schema?.url ?? "").includes("/phone/tools/"));
    if (found) {
      await api.req("PATCH", `/v1/agents/tools/${encodeURIComponent(found.id)}`, withoutType(def));
      console.log(`updated tool ${def.name} (${found.id})`);
      toolIds.push(found.id);
    } else {
      const created = await api.req<{ id: string }>("POST", "/v1/agents/tools", def);
      console.log(`created tool ${def.name} (${created.id})`);
      toolIds.push(created.id);
    }
  }

  const body = buildAgentBody({ name: a.name, businessName, businessId: a.businessId, modelId: a.model, voiceId: a.voice, toolIds, keyterms: fixtureKeyterms(a.businessId), timezone: a.timezone });
  const agents = await api.listAll<{ id: string; name: string }>(`/v1/agents?q=${encodeURIComponent(a.name)}`);
  const agent = agents.find((x) => x.name === a.name);
  let agentId: string;
  if (agent) {
    agentId = agent.id;
    try {
      await api.req("PATCH", `/v1/agents/${encodeURIComponent(agent.id)}`, { ...body, version_description: "cartesia-setup.ts update" });
      console.log(`updated agent ${a.name} (${agentId})`);
    } catch (e) {
      // Cartesia refuses a version_description when nothing in the agent changed (only the tool URLs did).
      if (!/only allowed when the agent configuration changes/.test(String(e))) throw e;
      console.log(`agent ${a.name} (${agentId}) unchanged`);
    }
  } else {
    agentId = (await api.req<{ id: string }>("POST", "/v1/agents", body)).id;
    console.log(`created agent ${a.name} (${agentId})`);
  }
  if (a.phoneNumberId) {
    await api.req("PATCH", `/agents/phone-numbers/${encodeURIComponent(a.phoneNumberId)}`, { agent_id: agentId });
    console.log(`assigned phone number ${a.phoneNumberId} to ${agentId}`);
  } else {
    console.log("no --phone-number-id: assign a number to the agent in the Cartesia Playground (Phone Numbers).");
  }
}

main().catch((e) => {
  console.error(`cartesia-setup failed: ${(e as Error).message}`);
  process.exit(1);
});
