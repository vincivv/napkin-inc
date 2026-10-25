// POST /intake/photo, /intake/voice, /intake/merge ; GET /intake/photo/:businessId

import { randomUUID } from "node:crypto";
import type { BusinessSpec } from "@napkin/schema";
import { checkBusinessId, HttpError, newRouter, requireLlm, requireSpec, specView, type M2Deps } from "../m2deps";
import { refreshQuestions } from "../questions/engine";
import type { Draft, StoredSpec } from "../spec/store";
import { mergeAlternatives, mergeSpecs } from "./merge";
import { extractFromPhoto, extractFromTranscript, transcribe } from "./run";

const MAX_IMAGE = 5 * 1024 * 1024;
const MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function knownNames(spec: BusinessSpec | undefined): string[] {
  if (!spec) return [];
  return spec.offerings.flatMap((o) => [String(o.name.value), ...o.variants.map((v) => `${o.name.value} / ${v.name.value}`), ...o.addOns.map((a) => `add-on: ${a.name.value}`)]).filter((s) => s.trim() !== "" && !s.startsWith(" /"));
}

/**
 * A new photo replaces the old one. Items come only from photos and voice notes, so an item that is
 * neither on the new photo nor named by the owner in a note came from an earlier photo: it is dropped
 * with its alternatives instead of lingering as a product that is no longer on the paper.
 */
function withoutReplacedItems(cur: StoredSpec, draft: Draft): Pick<StoredSpec, "spec" | "alternatives"> {
  const keep = new Set([...draft.spec.offerings.map((o) => o.id), ...voiceItems(cur)]);
  const stale = cur.spec.offerings.map((o) => o.id).filter((id) => !keep.has(id));
  if (stale.length === 0) return cur;
  const isStale = (path: string) => stale.some((id) => path === `offerings.${id}` || path.startsWith(`offerings.${id}.`));
  return {
    spec: { ...cur.spec, offerings: cur.spec.offerings.filter((o) => !stale.includes(o.id)) },
    alternatives: Object.fromEntries(Object.entries(cur.alternatives).filter(([path]) => !isStale(path))),
  };
}
const voiceItems = (cur: StoredSpec | undefined) => [...new Set([...(cur?.voiceItems ?? []), ...(cur?.drafts.voice?.spec.offerings.map((o) => o.id) ?? [])])];

/** Fold a new draft into the stored record. The first draft becomes the spec; later ones are merged (deterministically). */
function fold(cur: StoredSpec | undefined, kind: "photo" | "voice", draft: Draft): Omit<StoredSpec, "version" | "updatedAt" | "businessId"> {
  let spec = draft.spec;
  const base = cur && kind === "photo" ? withoutReplacedItems(cur, draft) : cur;
  let alternatives = base?.alternatives ?? {};
  if (base) {
    const m = mergeSpecs(base.spec, draft.spec);
    spec = m.spec;
    alternatives = mergeAlternatives(alternatives, m.alternatives);
  }
  return {
    spec: refreshQuestions(spec),
    alternatives,
    drafts: { ...(cur?.drafts ?? {}), [kind]: draft },
    ...(cur?.photo ? { photo: cur.photo } : {}),
    transcripts: cur?.transcripts ?? [],
    statements: cur?.statements ?? [],
    voiceItems: kind === "voice" ? [...new Set([...voiceItems(cur), ...draft.spec.offerings.map((o) => o.id)])] : voiceItems(cur),
  };
}

export function intakeRoutes(d: M2Deps) {
  const r = newRouter();

  r.post("/intake/photo", async (c) => {
    const body = await c.req.parseBody();
    const businessId = checkBusinessId(body.businessId);
    const file = body.image;
    if (!(file instanceof File)) throw new HttpError(400, "multipart field `image` (a photo) is required");
    if (!MEDIA.has(file.type)) throw new HttpError(415, `unsupported image type ${file.type || "unknown"}; use jpeg, png, webp or gif`);
    if (file.size > MAX_IMAGE) throw new HttpError(413, "image is over 5 MB");
    const bytes = Buffer.from(await file.arrayBuffer());
    const llm = requireLlm(d);
    const out = await extractFromPhoto(llm, { base64: bytes.toString("base64"), mediaType: file.type as "image/png" }, file.name || "photo");
    const photo = d.store.savePhoto(businessId, bytes, file.type);
    const draft: Draft = { spec: out.spec, createdAt: new Date().toISOString(), rejected: out.rejected, ...(out.notes ? { notes: out.notes } : {}) };
    const rec = await d.store.update(businessId, (cur) => ({ ...fold(cur, "photo", draft), photo }));
    return c.json({ ...specView(rec), rejected: out.rejected, notes: out.notes });
  });

  r.post("/intake/voice", async (c) => {
    const body = await c.req.parseBody();
    const businessId = checkBusinessId(body.businessId);
    let text: string;
    let source: "voice" | "typed";
    if (body.audio instanceof File) {
      if (!d.cartesiaKey) throw new HttpError(503, "CARTESIA_API_KEY is not set; speech-to-text is unavailable (type your answer instead)");
      if (body.audio.size === 0) throw new HttpError(400, "empty audio");
      text = await transcribe(d.cartesiaKey, body.audio, body.audio.name || "voice.webm", d.fetchImpl);
      source = "voice";
    } else if (typeof body.transcript === "string" && body.transcript.trim()) {
      text = body.transcript.trim();
      source = "typed";
    } else throw new HttpError(400, "send multipart `audio` (webm) or `transcript` (text)");
    if (!text) throw new HttpError(422, "no speech was recognised; try again");
    const llm = requireLlm(d);
    const id = d.newId?.() ?? randomUUID();
    const cur0 = d.store.get(businessId);
    const out = await extractFromTranscript(llm, text, id, source === "voice" ? "voice" : "chat", knownNames(cur0?.spec));
    const draft: Draft = { spec: out.spec, createdAt: new Date().toISOString(), rejected: out.rejected, ...(out.notes ? { notes: out.notes } : {}) };
    const rec = await d.store.update(businessId, (cur) => {
      const f = fold(cur, "voice", draft);
      return { ...f, transcripts: [...f.transcripts, { id, text, source, createdAt: draft.createdAt }] };
    });
    return c.json({ ...specView(rec), transcript: text, transcriptId: id, rejected: out.rejected, notes: out.notes });
  });

  /** Re-merge the stored photo + voice drafts into the current spec (idempotent; confirmed answers survive). */
  r.post("/intake/merge", async (c) => {
    const businessId = checkBusinessId(((await c.req.json().catch(() => ({}))) as { businessId?: string }).businessId);
    const rec0 = requireSpec(d, businessId);
    const drafts = [rec0.drafts.photo, rec0.drafts.voice].filter((x): x is Draft => Boolean(x));
    if (drafts.length === 0) throw new HttpError(409, "no photo or voice draft to merge");
    const rec = await d.store.update(businessId, (cur) => {
      let spec = cur!.spec;
      let alts = cur!.alternatives;
      for (const dr of drafts) {
        const m = mergeSpecs(spec, dr.spec);
        spec = m.spec;
        alts = mergeAlternatives(alts, m.alternatives);
      }
      return { ...cur!, spec: refreshQuestions(spec), alternatives: alts };
    });
    return c.json(specView(rec));
  });

  r.get("/intake/photo/:businessId", (c) => {
    const rec = requireSpec(d, checkBusinessId(c.req.param("businessId")));
    const p = d.store.readPhoto(rec);
    if (!p) throw new HttpError(404, "no photo stored");
    return new Response(new Uint8Array(p.bytes), { headers: { "content-type": p.mime, "cache-control": "no-store" } });
  });

  return r;
}
