// Live AI staff for the red team, loaded by DYNAMIC import so the runner works (rows "not run") before the
// harness exists. Wiring, as the agents work defines it:
//   createAgentHarness({ staff }) from services/brain/src/agents/harness.ts
//   createLiveStaff(hub, checkoutDeps) from services/brain/src/agents (Claude through ANTHROPIC_API_KEY)
// napkin mode = maya-cookies with the real Guard; baseline = maya-cookies-baseline with BaselineGuard.
//
// A fresh staff + harness is built for every row, after the row's reset: the staff's backend caches a ledger
// subscription on the system connection, and a reset replaces that connection.
//
// The Anthropic key is read from the environment, or from the repo's .env (only ANTHROPIC_API_KEY and
// ANTHROPIC_WORKSPACE_ID are taken from it; nothing else in that file is used, and nothing is printed).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REDTEAM_ROOT } from "../load";
import type { Mode, Transcript, Finding } from "../types";
import { actorKey, type SessionRecord } from "./brain";
import type { ScratchWorld } from "./db";
import type { RealInspector } from "./inspector";
import { HARNESS_MISSING } from "./classify";

const AGENTS_DIR = join(REDTEAM_ROOT, "..", "services", "brain", "src", "agents");
export const HARNESS_PATH = join(AGENTS_DIR, "harness.ts");
const AGENTS_INDEX = join(AGENTS_DIR, "index.ts");
const ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_WORKSPACE_ID"] as const;

export interface PlantedInput {
  id: string;
  documents: unknown[];
  periods: { month: string; status: string; closedAt?: string | null }[];
  processorStatement: unknown[];
}

/** What the runner needs from the harness (structural; the brain's types are copies of redteam's). */
export interface LiveHarness {
  send(target: string, turns: string[], mode: Mode): Promise<Transcript>;
  audit(set: PlantedInput, mode: Mode): Promise<{ findings: Finding[]; reply: string; toolCalls: unknown[]; error?: string }>;
}

export interface LiveAgents {
  model: string;
  /** A fresh staff + harness over the world's current connections. */
  make(): LiveHarness;
}

/** Parses KEY=VALUE lines (optionally quoted) for the given keys only. */
export function parseEnvKeys(text: string, keys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(raw);
    if (!m || !keys.includes(m[1]!)) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]!] = v;
  }
  return out;
}

function envCandidates(): string[] {
  const c: string[] = [];
  if (process.env.NAPKIN_ENV_FILE) c.push(process.env.NAPKIN_ENV_FILE);
  c.push(join(REDTEAM_ROOT, "..", ".env"));
  try {
    // a git worktree has no .env; the main checkout (the shared git dir's parent) holds it
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: REDTEAM_ROOT, encoding: "utf8" }).trim();
    c.push(join(dirname(common), ".env"));
  } catch {
    /* not a git checkout */
  }
  return c;
}

/** Puts ANTHROPIC_API_KEY (and workspace id) into process.env if absent. Returns whether a key is available. */
export function ensureAnthropicEnv(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  for (const p of envCandidates()) {
    if (!existsSync(p)) continue;
    const kv = parseEnvKeys(readFileSync(p, "utf8"), ENV_KEYS);
    for (const k of ENV_KEYS) if (kv[k] && !process.env[k]) process.env[k] = kv[k];
    if (process.env.ANTHROPIC_API_KEY) return true;
  }
  return false;
}

type HarnessModule = { createAgentHarness?: (deps: { staff: unknown }) => LiveHarness };
type AgentsModule = { createLiveStaff?: (hub: unknown, checkout: unknown) => unknown; AGENT_MODEL?: string };

export async function loadLiveAgents(world: ScratchWorld, inspector: RealInspector): Promise<{ agents?: LiveAgents; why?: string }> {
  if (!existsSync(HARNESS_PATH)) return { why: HARNESS_MISSING };
  if (!ensureAnthropicEnv()) return { why: "not run: ANTHROPIC_API_KEY is not set (environment or repo .env)" };
  try {
    const h = (await import(pathToFileURL(HARNESS_PATH).href)) as HarnessModule;
    const a = (await import(pathToFileURL(AGENTS_INDEX).href)) as AgentsModule;
    if (typeof h.createAgentHarness !== "function") return { why: `${HARNESS_MISSING} (harness.ts has no createAgentHarness export)` };
    if (typeof a.createLiveStaff !== "function") return { why: "not run: services/brain/src/agents has no createLiveStaff export" };
    const createAgentHarness = h.createAgentHarness;
    const createLiveStaff = a.createLiveStaff;
    const sessions = new Map<string, SessionRecord>();
    return {
      agents: {
        model: a.AGENT_MODEL ?? "unknown (agents module did not export AGENT_MODEL)",
        make() {
          const checkout = {
            platform: world.platform,
            // the Inspector's processor for this row: simulated payments made by the agents are processor truth too
            gateway: inspector.processor.gateway(world.platform),
            sessions: { get: (id: string) => sessions.get(id), put: (r: SessionRecord) => void sessions.set(r.orderId, r) },
            storePublicUrl: "http://localhost:3002",
            hasStorefront: (b: string) => Boolean(world.hub.get(actorKey("storefront", b))),
          };
          const staff = createLiveStaff(world.hub, checkout);
          if (!staff) throw new Error("createLiveStaff returned no staff (ANTHROPIC_API_KEY missing?)");
          return createAgentHarness({ staff });
        },
      },
    };
  } catch (e) {
    return { why: `not run: agent harness failed to load: ${e instanceof Error ? e.message : String(e)}` };
  }
}
