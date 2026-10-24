// Owner statements ("no discounts this week") -> a structured diff over the spec. Parsing is the LLM's job;
// resolving paths, coercing values, applying and reverting are pure code. A diff is NEVER applied until the
// owner confirms it in the app (phone statements additionally go through the platform's decideOwnerStatement).

import type { BusinessSpec } from "@napkin/schema";
import { z } from "zod";
import { MODELS, type Llm } from "../llm";
import { CoerceError, coerceValue, showValue, valueKey } from "../spec/coerce";
import { getFact, listFacts, setFact, type AnyFact } from "../spec/paths";
import { labelFor } from "./engine";

export interface DiffChange {
  path: string;
  label: string;
  before: AnyFact;
  after: AnyFact;
  beforeText: string;
  afterText: string;
}
export interface StatementDiff {
  changes: DiffChange[];
  /** parts of the statement that did not map to a known field; shown to the owner, never guessed at */
  unparsed: string[];
  note?: string;
}

export const STATEMENT_SCHEMA = {
  type: "object",
  properties: {
    changes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          path: { type: "string", description: "EXACTLY one of the listed field paths." },
          newValue: { type: "string", description: "The new value as plain text, e.g. 0, 20%, 4.00, yes." },
          quote: { type: "string", description: "The owner's words that justify the change." },
        },
        required: ["path", "newValue"],
      },
    },
    unparsed: { type: "array", items: { type: "string" }, description: "Parts of the statement that match none of the listed fields." },
    note: { type: "string", description: "Anything the owner should double-check, e.g. a time limit ('this week') the system cannot enforce." },
  },
  required: ["changes"],
} as const;

const Parsed = z.object({
  changes: z.array(z.object({ path: z.string(), newValue: z.union([z.string(), z.number(), z.boolean()]).transform(String), quote: z.string().optional() })),
  unparsed: z.array(z.string()).default([]),
  note: z.string().optional(),
});
export type ParsedStatement = z.infer<typeof Parsed>;

export function statementContext(spec: BusinessSpec): string {
  return listFacts(spec)
    .map(({ path, fact }) => `${path} | ${labelFor(spec, path)} | current: ${showValue(path, fact.value)}`)
    .join("\n");
}

export async function parseStatement(llm: Llm, spec: BusinessSpec, text: string): Promise<ParsedStatement> {
  const raw = await llm.tool({
    model: MODELS.opus,
    system:
      "You turn an owner's instruction about their business into changes to specific fields. Use ONLY the listed paths. " +
      "Rates are fractions in the data but write the owner's own wording of the value (e.g. 0, 20%). " +
      "If the statement does not clearly map to a listed field, put it in unparsed. Never invent values the owner did not state.",
    content: [{ type: "text", text: `Fields:\n${statementContext(spec)}\n\nOwner said: """${text}"""` }],
    toolName: "propose_changes",
    toolDescription: "Propose field changes for the owner to confirm.",
    schema: STATEMENT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
  });
  return Parsed.parse(raw);
}

/** Pure: resolve a parsed statement against the spec. Unknown paths and bad values go to `unparsed`. */
export function buildDiff(spec: BusinessSpec, parsed: ParsedStatement, ctx: { statementId: string; text: string; channel: "app" | "phone" }): StatementDiff {
  const changes: DiffChange[] = [];
  const unparsed = [...parsed.unparsed];
  const seen = new Set<string>();
  for (const c of parsed.changes) {
    const before = getFact(spec, c.path);
    if (!before || seen.has(c.path)) {
      unparsed.push(`${c.path}: not a field I can change`);
      continue;
    }
    let value: unknown;
    try {
      value = coerceValue(c.path, before.value, c.newValue);
    } catch (e) {
      unparsed.push(`${c.path}: ${e instanceof CoerceError ? e.message : String(e)}`);
      continue;
    }
    if (valueKey(c.path, value) === valueKey(c.path, before.value) && before.confirmed) continue; // already true
    seen.add(c.path);
    const after: AnyFact = {
      value,
      provenance: "owner_said",
      confidence: 1,
      source: { kind: ctx.channel === "phone" ? "phone" : "chat", ref: ctx.statementId, quote: c.quote?.trim() || ctx.text },
      confirmed: true, // takes effect only when the owner confirms the diff
    };
    changes.push({ path: c.path, label: labelFor(spec, c.path), before, after, beforeText: showValue(c.path, before.value), afterText: showValue(c.path, value) });
  }
  return { changes, unparsed, ...(parsed.note ? { note: parsed.note } : {}) };
}

export class StaleDiff extends Error {
  override name = "StaleDiff";
}

/** Pure. Refuses if any field changed since the diff was made (never assume). */
export function applyDiff(spec: BusinessSpec, diff: StatementDiff): BusinessSpec {
  let next = spec;
  for (const c of diff.changes) {
    const cur = getFact(next, c.path);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(c.before)) throw new StaleDiff(`${c.path} changed since this was proposed; ask again`);
    next = setFact(next, c.path, c.after);
  }
  return next;
}

/** Pure inverse of applyDiff: revertDiff(applyDiff(s, d), d) deep-equals s. */
export function revertDiff(spec: BusinessSpec, diff: StatementDiff): BusinessSpec {
  let next = spec;
  for (const c of [...diff.changes].reverse()) {
    const cur = getFact(next, c.path);
    if (!cur || JSON.stringify(cur) !== JSON.stringify(c.after)) throw new StaleDiff(`${c.path} no longer holds the applied value`);
    next = setFact(next, c.path, c.before);
  }
  return next;
}
