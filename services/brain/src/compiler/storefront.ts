// Steps "storefront" and "agents": the ONLY place an LLM touches a compiled configuration. It may
// PROPOSE theme colors, emoji, font, headline, tagline and agent goal wording. Proposals are optional,
// validated here deterministically, and anything that fails validation is dropped (defaults are used).
// The LLM never sees prices, costs, stock or policies, and no proposal can reach a money field: the
// compiler fingerprints the money sections before and after this step and refuses on any difference.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { AGENT_TEMPLATES, DEFAULT_THEME, type AgentTemplate } from "./templates/item_seller";

export interface CopyInput {
  businessName: string;
  oneLiner: string;
  community: string;
  /** display names only (no prices) */
  offerings: string[];
}

export const ProposalSchema = z.object({
  theme: z
    .object({
      primary: z.string(),
      accent: z.string(),
      background: z.string(),
      text: z.string(),
      emoji: z.string().optional(),
      font: z.string().optional(),
    })
    .optional(),
  headline: z.string().optional(),
  tagline: z.string().optional(),
  agentGoals: z
    .object({ shopkeeper: z.array(z.string()).optional(), support: z.array(z.string()).optional(), bookkeeper: z.array(z.string()).optional() })
    .optional(),
});
export type Proposal = z.infer<typeof ProposalSchema>;

export interface CopyProposer {
  readonly name: string;
  propose(input: CopyInput): Promise<Proposal>;
}

// ---------- deterministic validation ----------

export const FONTS = ["Inter", "Fraunces", "Poppins", "Lora", "Nunito", "DM Sans", "Playfair Display", "Space Grotesk", "Work Sans"] as const;
const HEX = /^#[0-9a-fA-F]{6}$/;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}
/** WCAG contrast ratio (display math, not money). */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

/**
 * Copy must not make money claims: no digits, currency or percent signs, URLs, or price/discount words.
 * (A tagline like "cookies from $1, 20% off" would be the LLM inventing prices and policies.)
 */
const MONEY_WORDS = /\b(free|discount|discounts|off|sale|deal|deals|refund|refunds|guarantee|guaranteed|price|prices|cheap|cheapest|coupon|coupons|promo|percent)\b/i;
export function copyProblem(s: string, maxLen: number): string | undefined {
  const t = s.trim();
  if (t.length === 0) return "empty";
  if (t.length > maxLen) return `longer than ${maxLen} characters`;
  if (/[0-9$€£¥%]/.test(t)) return "contains digits, currency or percent signs";
  if (/https?:|www\.|@/i.test(t)) return "contains a link or handle";
  if (MONEY_WORDS.test(t)) return "makes a price, discount or refund claim";
  if (/[<>{}]/.test(t)) return "contains markup";
  return undefined;
}

/** Safety goals an agent always keeps, whatever wording is proposed. */
export const REQUIRED_GOALS: Record<AgentTemplate["id"], string[]> = {
  shopkeeper: ["never sell below the margin floor"],
  support: ["handle refunds within policy"],
  bookkeeper: ["keep the books balanced"],
};

export interface AcceptedCopy {
  theme: { primary: string; accent: string; background: string; text: string; emoji?: string; font?: string };
  headline: string;
  tagline: string;
  goals: Record<AgentTemplate["id"], string[]>;
  rejected: string[];
  used: string[];
}

export function acceptProposal(p: Proposal | undefined, defaults: { headline: string; tagline: string }): AcceptedCopy {
  const rejected: string[] = [];
  const used: string[] = [];
  let theme: AcceptedCopy["theme"] = { ...DEFAULT_THEME };
  if (p?.theme) {
    const t = p.theme;
    const bad = (["primary", "accent", "background", "text"] as const).filter((k) => !HEX.test(t[k]));
    if (bad.length) rejected.push(`theme: ${bad.join(", ")} not #rrggbb`);
    else if (contrast(t.text, t.background) < 4.5) rejected.push(`theme: text/background contrast ${contrast(t.text, t.background).toFixed(2)} < 4.5`);
    else if (contrast(t.primary, t.background) < 3) rejected.push(`theme: primary/background contrast ${contrast(t.primary, t.background).toFixed(2)} < 3`);
    else {
      theme = { primary: t.primary.toLowerCase(), accent: t.accent.toLowerCase(), background: t.background.toLowerCase(), text: t.text.toLowerCase() };
      used.push("theme colors");
      if (t.emoji !== undefined) {
        if (t.emoji.length <= 8 && /^\p{Extended_Pictographic}[\p{Extended_Pictographic}‍️]*$/u.test(t.emoji)) {
          theme.emoji = t.emoji;
          used.push("emoji");
        } else rejected.push("theme.emoji: not a single emoji");
      }
      if (t.font !== undefined) {
        if ((FONTS as readonly string[]).includes(t.font)) {
          theme.font = t.font;
          used.push("font");
        } else rejected.push(`theme.font: "${t.font}" is not in the allowed list`);
      }
    }
  }
  const text = (field: "headline" | "tagline", max: number) => {
    const v = p?.[field];
    if (v === undefined) return defaults[field];
    const bad = copyProblem(v, max);
    if (bad) {
      rejected.push(`${field}: ${bad}`);
      return defaults[field];
    }
    used.push(field);
    return v.trim();
  };
  const headline = text("headline", 60);
  const tagline = text("tagline", 140);

  const goals = {} as AcceptedCopy["goals"];
  for (const a of AGENT_TEMPLATES) {
    const proposed = p?.agentGoals?.[a.id];
    let list = [...a.defaultGoals];
    if (proposed) {
      const problems = proposed.map((g) => copyProblem(g, 80)).filter(Boolean);
      if (proposed.length === 0 || proposed.length > 5 || problems.length) rejected.push(`agentGoals.${a.id}: ${problems[0] ?? "need 1-5 goals"}`);
      else {
        list = proposed.map((g) => g.trim());
        used.push(`${a.id} goals`);
      }
    }
    for (const req of REQUIRED_GOALS[a.id]) if (!list.some((g) => g.toLowerCase() === req)) list.push(req);
    goals[a.id] = list;
  }
  return { theme, headline, tagline, goals, rejected, used };
}

// ---------- Anthropic proposer (optional) ----------

export const COPY_MODEL = "claude-opus-5-5";

/** Proposes look and wording with Claude. Used only when ANTHROPIC_API_KEY is configured. */
export class ClaudeCopyProposer implements CopyProposer {
  readonly name = `${COPY_MODEL} (proposal only)`;
  private readonly client: Anthropic;
  /** workspaceId: sent as anthropic-workspace-id (required for keys not scoped to a workspace), like src/llm.ts */
  constructor(apiKey: string, workspaceId?: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }

  async propose(input: CopyInput): Promise<Proposal> {
    const res = await this.client.messages.parse({
      model: COPY_MODEL,
      max_tokens: 4000,
      output_config: { effort: "low", format: zodOutputFormat(ProposalSchema) },
      system:
        "You design the look of a small business's online storefront. Propose a color theme (hex #rrggbb, readable text on the background), " +
        "optionally one emoji and a font, a short headline (the business name is fine) and a one-line tagline, and plain-language goal phrases " +
        "for its three AI staff (shopkeeper, support, bookkeeper). Never mention prices, numbers, discounts, refunds, deals or promises: " +
        "money rules are set elsewhere and anything like that will be discarded.",
      messages: [
        {
          role: "user",
          content: JSON.stringify({ business: input.businessName, oneLiner: input.oneLiner, community: input.community, sells: input.offerings }),
        },
      ],
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return {};
    return res.parsed_output;
  }
}
