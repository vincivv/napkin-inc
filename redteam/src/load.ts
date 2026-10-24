// Loads and validates every red-team data file. Throws on the first invalid file, with the file path
// and zod issues, so a bad JSON file fails loudly before any run starts.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Attack, ChaosCase, PlantedErrorSet } from "./types";
import { z } from "zod";

const here = dirname(fileURLToPath(import.meta.url));
export const REDTEAM_ROOT = join(here, "..");

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function jsonFiles(dir: string): string[] {
  return readdirSync(join(REDTEAM_ROOT, dir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(REDTEAM_ROOT, dir, f));
}

function parseOrThrow<T>(schema: z.ZodType<T>, path: string, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid red-team file ${path}: ${issues}`);
  }
  return r.data;
}

export interface LoadedAttack extends Attack {
  /** file the attack came from, relative to redteam/ */
  file: string;
}

export function loadAttacks(): LoadedAttack[] {
  const out: LoadedAttack[] = [];
  for (const path of jsonFiles("attacks")) {
    const arr = parseOrThrow(z.array(Attack).min(1), path, readJson(path));
    for (const a of arr) out.push({ ...a, file: path.slice(REDTEAM_ROOT.length + 1) });
  }
  return out;
}

export function loadChaos(): ChaosCase[] {
  const out: ChaosCase[] = [];
  for (const path of jsonFiles("chaos")) {
    out.push(...parseOrThrow(z.array(ChaosCase).min(1), path, readJson(path)));
  }
  return out;
}

export function loadPlanted(): { set: z.infer<typeof PlantedErrorSet>; file: string }[] {
  return jsonFiles("planted").map((path) => ({
    set: parseOrThrow(PlantedErrorSet, path, readJson(path)),
    file: path.slice(REDTEAM_ROOT.length + 1),
  }));
}
