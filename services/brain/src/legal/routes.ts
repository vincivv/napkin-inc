// Getting-legal checklist routes (all carry the business in the path, so the account gate covers them):
//   GET   /legal/:businessId                    the checklist (base items until tailored ones exist)
//   POST  /legal/:businessId/location           { city, state } -> remember where the business is
//   POST  /legal/:businessId/generate           { city?, state? } -> (re)generate tailored items
//   PATCH /legal/:businessId/items/:itemId      { status?, note? }
// Napkin never applies or files anything; this is a starting list with official links.

import type { Hono } from "hono";
import { z } from "zod";
import { log } from "../log";
import type { Llm } from "../llm";
import { checkBusinessId, HttpError, newRouter } from "../m2deps";
import { baseItems, normalizeState } from "./base";
import { LegalGenerationFailed, locationText, mergeStatuses, tailoredItems } from "./generate";
import type { FetchLike } from "./links";
import { knowsBusiness } from "./profile";
import { LegalStore } from "./store";
import { LEGAL_STATUSES, type LegalChecklist, type LegalItem, type LegalLocation, type LegalProfile } from "./types";

export interface LegalDeps {
  store: LegalStore;
  llm: Llm | undefined;
  /** facts the owner gave about the business (spec during setup, configuration once live) */
  profile(businessId: string): LegalProfile | undefined;
  fetchImpl?: FetchLike;
  linkTimeoutMs?: number;
}

const ITEM_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;

const GenerateBody = z
  .object({
    city: z.string().trim().min(1, "city is required").max(80).optional(),
    state: z.string().trim().min(2, "state is required").max(40).optional(),
  })
  .strict();
const PatchBody = z
  .object({
    status: z.enum(LEGAL_STATUSES as [string, ...string[]]).optional(),
    note: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((b) => b.status !== undefined || b.note !== undefined, "send status and/or note");

const DISCLAIMER =
  "This is a starting list, not legal advice. Rules differ by state, county and city. Napkin doesn't apply for or file anything; check each item with the agency listed.";

function counts(items: LegalItem[]) {
  return {
    total: items.length,
    done: items.filter((i) => i.status === "done").length,
    notNeeded: items.filter((i) => i.status === "not_needed").length,
    todo: items.filter((i) => i.status === "todo").length,
  };
}

/** Base items for a (new) location, tailored ones kept; statuses and notes survive by id. */
function relocate(cur: LegalChecklist | undefined, loc: LegalLocation | undefined): LegalItem[] {
  const tailored = (cur?.items ?? []).filter((i) => !i.base);
  return mergeStatuses([...baseItems(loc), ...tailored], cur?.items);
}

function rest(cur: LegalChecklist | undefined): Omit<LegalChecklist, "version" | "updatedAt" | "businessId" | "items"> {
  return {
    ...(cur?.generatedAt ? { generatedAt: cur.generatedAt } : {}),
    ...(cur?.generatedFor ? { generatedFor: cur.generatedFor } : {}),
    ...(cur?.location ? { location: cur.location } : {}),
  };
}

export function legalRoutes(d: LegalDeps): Hono {
  const r = newRouter();
  const fetchImpl: FetchLike = d.fetchImpl ?? ((url, init) => fetch(url, init));

  const view = (businessId: string) => {
    const rec = d.store.get(businessId);
    const profile = d.profile(businessId);
    const where = locationText(rec?.location, profile);
    const items = rec?.items ?? baseItems(rec?.location);
    return {
      businessId,
      disclaimer: DISCLAIMER,
      items,
      counts: counts(items),
      location: rec?.location ?? null,
      /** what the checklist is tailored to: the owner's city/state, else the location in the business spec */
      locationText: where ?? null,
      locationSource: rec?.location ? "owner" : where ? "business" : null,
      needsLocation: !where,
      knowsBusiness: knowsBusiness(profile),
      generated: Boolean(rec?.generatedAt),
      generatedAt: rec?.generatedAt ?? null,
      generatedFor: rec?.generatedFor ?? null,
      aiAvailable: Boolean(d.llm),
    };
  };

  r.get("/legal/:businessId", (c) => c.json(view(checkBusinessId(c.req.param("businessId")))));

  /** Validates and stores the owner's city/state (base hints use it even if the AI step later fails). */
  const saveLocation = async (businessId: string, body: { city?: string | undefined; state?: string | undefined }): Promise<LegalLocation> => {
    if (!body.city || !body.state) throw new HttpError(400, "send both city and state");
    const state = normalizeState(body.state);
    if (!state) throw new HttpError(400, `"${body.state}" is not a US state; use a name like Texas or a code like TX`);
    const loc = { city: body.city.replace(/\s+/g, " "), state };
    await d.store.update(businessId, (cur) => ({ ...rest(cur), location: loc, items: relocate(cur, loc) }));
    return loc;
  };

  r.post("/legal/:businessId/location", async (c) => {
    const businessId = checkBusinessId(c.req.param("businessId"));
    await saveLocation(businessId, GenerateBody.parse(await c.req.json()));
    return c.json(view(businessId));
  });

  r.post("/legal/:businessId/generate", async (c) => {
    const businessId = checkBusinessId(c.req.param("businessId"));
    const raw = await c.req.json().catch(() => ({}));
    const body = GenerateBody.parse(raw ?? {});
    let loc = d.store.get(businessId)?.location;
    if (body.city !== undefined || body.state !== undefined) loc = await saveLocation(businessId, body);
    const profile = d.profile(businessId);
    const where = locationText(loc, profile);
    if (!where) throw new HttpError(409, "Napkin doesn't know where your business is yet: send your city and state");
    if (!knowsBusiness(profile)) throw new HttpError(409, "Napkin doesn't know what your business sells yet: finish your napkin first");
    if (!d.llm) throw new HttpError(503, "ANTHROPIC_API_KEY is not set; tailored items are unavailable (the general items still apply)");
    let tailored: LegalItem[];
    try {
      tailored = await tailoredItems({ llm: d.llm, profile, location: where, fetchImpl, ...(d.linkTimeoutMs ? { linkTimeoutMs: d.linkTimeoutMs } : {}) });
    } catch (e) {
      if (e instanceof LegalGenerationFailed) throw new HttpError(502, e.message);
      throw e;
    }
    const finalLoc = loc;
    await d.store.update(businessId, (cur) => ({
      ...(finalLoc ? { location: finalLoc } : {}),
      generatedAt: new Date().toISOString(),
      generatedFor: where,
      items: mergeStatuses([...baseItems(finalLoc), ...tailored], cur?.items),
    }));
    log.info("legal", `${businessId}: ${tailored.length} tailored items for ${where} (${tailored.filter((t) => t.link).length} with verified links)`);
    return c.json(view(businessId));
  });

  r.patch("/legal/:businessId/items/:itemId", async (c) => {
    const businessId = checkBusinessId(c.req.param("businessId"));
    const itemId = c.req.param("itemId");
    if (!ITEM_ID_RE.test(itemId)) throw new HttpError(400, "invalid item id");
    const body = PatchBody.parse(await c.req.json());
    const exists = (d.store.get(businessId)?.items ?? baseItems()).some((i) => i.id === itemId);
    if (!exists) throw new HttpError(404, `no checklist item "${itemId}"`);
    await d.store.update(businessId, (cur) => ({
      ...rest(cur),
      items: (cur?.items ?? baseItems(cur?.location)).map((i) => {
        if (i.id !== itemId) return i;
        const next: LegalItem = { ...i, ...(body.status ? { status: body.status as LegalItem["status"] } : {}) };
        if (body.note !== undefined) {
          const note = body.note?.trim();
          if (note) next.note = note;
          else delete next.note;
        }
        return next;
      }),
    }));
    return c.json(view(businessId));
  });

  return r;
}

export function mountLegal(app: Hono, d: LegalDeps): void {
  app.route("/", legalRoutes(d));
}
