// Claude proposes a storefront design (style, palette, fonts, copy, photo search queries) through the
// shared Llm port. It sees the business name, one-liner, community and product names and kinds only:
// never prices, costs, stock or policies. The output is untrusted and goes through acceptDesignProposal.

import { BODY_FONTS, DISPLAY_FONTS } from "@napkin/schema";
import { LlmUnavailable, MODELS, type Llm } from "../llm";
import { DesignProposal, type DesignInput, type DesignStyleName } from "./design";

export const DESIGN_MODEL = MODELS.opus;

export interface DesignProposer {
  readonly name: string;
  propose(input: DesignInput, opts?: { style?: DesignStyleName }): Promise<DesignProposal | undefined>;
}

const str = (description: string, maxLength?: number) => ({ type: "string", description, ...(maxLength ? { maxLength } : {}) });
const HEXS = (d: string) => str(`#rrggbb; ${d}`);

export const DESIGN_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    style: { type: "string", enum: ["editorial", "bold"] },
    corners: { type: "string", enum: ["round", "soft", "square"], description: "round = pill buttons (editorial), square = sharp (bold)" },
    palette: {
      type: "object",
      additionalProperties: false,
      properties: {
        background: HEXS("page background"),
        surface: HEXS("product tiles and cards, a light neutral close to the background"),
        text: HEXS("body text, contrast >= 4.5 on background and on surface"),
        muted: HEXS("secondary text, contrast >= 3 on background"),
        primary: HEXS("buttons, links, announcement bar; contrast >= 3 on background"),
        onPrimary: HEXS("text on primary, contrast >= 4.5 on primary"),
        accent: HEXS("one highlight word in a heading, badges"),
      },
      required: ["background", "surface", "text", "muted", "primary", "onPrimary", "accent"],
    },
    fonts: {
      type: "object",
      additionalProperties: false,
      properties: { display: { type: "string", enum: [...DISPLAY_FONTS] }, body: { type: "string", enum: [...BODY_FONTS] } },
      required: ["display", "body"],
    },
    announcement: str("one short line for the bar above the header, about ordering (no claims)", 70),
    hero: {
      type: "object",
      additionalProperties: false,
      properties: {
        eyebrow: str("tiny label above the title", 32),
        title: str("the hero headline; the business name is a good choice", 48),
        subtitle: str("one sentence under the title", 120),
        cta: str("button label, e.g. Shop now", 20),
        layout: { type: "string", enum: ["fullbleed", "split"], description: "fullbleed = photo behind the text (bold); split = text beside a photo (editorial)" },
      },
      required: ["eyebrow", "title", "subtitle", "cta", "layout"],
    },
    collection: {
      type: "object",
      additionalProperties: false,
      description: 'product grid heading "<title> <accent>", e.g. {"title":"Shop the","accent":"menu"} or {"title":"New","accent":"in"}',
      properties: { title: str("first words", 24), accent: str("the highlighted last word", 24) },
      required: ["title", "accent"],
    },
    banner: { type: "object", additionalProperties: false, properties: { title: str("heading of the pickup/visit section, e.g. Plan your pickup", 40) }, required: ["title"] },
    imageQueries: {
      type: "object",
      additionalProperties: false,
      description: "stock-photo search queries, 2-5 plain English words each, describing a photo with no people and no text",
      properties: {
        subject: str("what the shop sells, in 1-2 plain words, plural: e.g. cookies, candles, hoodies, coffee", 24),
        hero: str("a wide, atmospheric photo of the product or its ingredients/materials, e.g. chocolate chip cookies on table"),
        banner: str("a wide mood photo for the pickup/visit section, e.g. cookie dough on wooden table, folded hoodies on shelf"),
        products: {
          type: "array",
          items: { type: "object", additionalProperties: false, properties: { productId: { type: "string" }, query: str("e.g. chocolate chip cookie close up") }, required: ["productId", "query"] },
        },
      },
      required: ["subject", "hero", "banner", "products"],
    },
  },
  required: ["style", "corners", "palette", "fonts", "announcement", "hero", "collection", "banner", "imageQueries"],
} as const;

const SYSTEM = [
  "You are the art director for a small business's online store. Propose its look and its few lines of store copy.",
  "Two reference design languages; pick one as `style`:",
  "- editorial (like warbyparker.com): soft warm neutrals (cream, oat, stone), a light neutral surface behind product photos, big calm photography, pill-shaped buttons (corners round), a friendly display serif or soft grotesk (Fraunces, Instrument Serif, DM Serif Display, Bricolage Grotesque) with a clean body font, a value-prop line in the announcement bar, layout split.",
  "- bold (like asos.com): black and white with at most one strong accent, a full-bleed photo hero, heavy uppercase-feeling display type (Archivo, Space Grotesk, Outfit, Inter), square buttons (corners square), layout fullbleed.",
  "Pick bold for fashion, streetwear, sneakers, nightlife, music and similar businesses; pick editorial for food, bakeries, coffee, craft, wellness, plants, home goods and similar.",
  "Colors: hex #rrggbb. text must read on background and on surface (contrast >= 4.5), onPrimary on primary (>= 4.5), primary and muted on background (>= 3).",
  "Copy rules (anything that breaks them is discarded): no prices, no numbers or digits, no discounts, sales, deals, free items, refunds or guarantees; no links or handles.",
  "Never state a fact you were not given: do not say organic, vegan, gluten-free, natural, handmade, since <year>, established, family-owned, locally sourced, award-winning, best in town, famous, or anything about ingredients, history, people or location unless the input says it.",
  "Image queries: 2-4 plain English words for a stock-photo search (the search matches every word, so short concrete queries work best), one for the hero, one for the banner and one per product id given. Describe the product, its ingredients or materials, or a mood (e.g. chocolate chip cookies close up, cookie dough on wooden table, black hoodie flat lay, folded hoodies on shelf). Never ask for a storefront, shop window, sign, menu, brand, logo, people or text: a photo of another business's sign must never appear on this store.",
].join("\n");

/** Claude Opus design proposals via the brain's Llm port; undefined when the model declines or returns nothing usable. */
export class LlmDesignProposer implements DesignProposer {
  readonly name = `${DESIGN_MODEL} (design proposal)`;
  constructor(private readonly llm: Llm) {}

  async propose(input: DesignInput, opts: { style?: DesignStyleName } = {}): Promise<DesignProposal | undefined> {
    const brief = {
      business: input.businessName,
      oneLiner: input.oneLiner,
      community: input.community,
      fulfillment: input.fulfillment,
      products: input.products.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      ...(opts.style ? { ownerChoseStyle: opts.style } : {}),
    };
    let raw: unknown;
    try {
      raw = await this.llm.tool({
        model: DESIGN_MODEL,
        system: SYSTEM,
        content: [{ type: "text", text: JSON.stringify(brief) }],
        toolName: "propose_design",
        toolDescription: "Record the proposed storefront design, copy and photo search queries.",
        schema: DESIGN_JSON_SCHEMA as unknown as Record<string, unknown>,
      });
    } catch (e) {
      if (e instanceof LlmUnavailable) return undefined;
      throw e;
    }
    const parsed = DesignProposal.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }
}
