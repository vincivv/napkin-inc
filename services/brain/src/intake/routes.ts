// POST /intake/photo, /intake/voice, /intake/merge ; GET|DELETE /intake/photo/:businessId (?i=N for one photo)

import { randomUUID } from "node:crypto";
import type { BusinessSpec } from "@napkin/schema";
import { checkBusinessId, HttpError, newRouter, requireLlm, requireSpec, specView, type M2Deps } from "../m2deps";
import { refreshQuestions } from "../questions/engine";
import { getFact, isMissing, listFacts, missingFact, removeFact, setFact, slugify, type AnyFact } from "../spec/paths";
import { MAX_PHOTOS, photosOf, type Draft, type StoredPhoto, type StoredSpec } from "../spec/store";
import { placeholderOffering } from "./extract";
import { mergeAlternatives, mergeSpecs } from "./merge";
import { extractFromPhoto, extractFromTranscript, transcribe, type PhotoInput } from "./run";

const MAX_IMAGE = 5 * 1024 * 1024;
const MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function knownNames(spec: BusinessSpec | undefined): string[] {
  if (!spec) return [];
  return spec.offerings.flatMap((o) => [String(o.name.value), ...o.variants.map((v) => `${o.name.value} / ${v.name.value}`), ...o.addOns.map((a) => `add-on: ${a.name.value}`)]).filter((s) => s.trim() !== "" && !s.startsWith(" /"));
}

/**
 * A new set of photos replaces the old reading. Items come only from photos and voice notes, so an item that is
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

const OPTIONAL_FIELDS = new Set(["description", "initialStock", "stockUnits"]);
const fromPhoto = (f: AnyFact | undefined) => f?.source.kind === "photo";

/**
 * Forget the photo (an accidental upload): what was read only from it goes, what the owner typed or said
 * stays. Offerings not named in a note are dropped (as for a replaced photo); every other photo-read fact
 * falls back to what the owner said for the same field (a recorded alternative, else the last voice draft),
 * else to "not provided" (optional fields are removed). Variants, add-ons and suppliers that only the photo
 * named are dropped. Conflict questions on the touched fields go with the photo's side of them.
 */
export function withoutPhoto(cur: StoredSpec): Omit<StoredSpec, "version" | "updatedAt" | "businessId"> {
  const voiceSpec = cur.drafts.voice?.spec;
  const said = (path: string): AnyFact | undefined => {
    const alts = (cur.alternatives[path] ?? []).filter((f) => !fromPhoto(f) && !isMissing(f));
    alts.sort((a, b) => Number(b.confirmed) - Number(a.confirmed) || b.confidence - a.confidence);
    const v = voiceSpec ? getFact(voiceSpec, path) : undefined;
    return alts[0] ?? (v && !isMissing(v) && !fromPhoto(v) ? v : undefined);
  };
  const keepOffering = new Set(voiceItems(cur));
  const onlyOnPhoto = <T extends { name: AnyFact }>(base: string, key: (x: T) => string) => (x: T) => !(fromPhoto(x.name) && !said(`${base}.${key(x)}.name`));
  const offerings = cur.spec.offerings
    .filter((o) => keepOffering.has(o.id))
    .map((o) => ({ ...o, variants: o.variants.filter(onlyOnPhoto(`offerings.${o.id}.variants`, (v) => v.id)), addOns: o.addOns.filter(onlyOnPhoto(`offerings.${o.id}.addOns`, (a) => a.id)) }));
  let spec: BusinessSpec = {
    ...cur.spec,
    // only the photo named items: back to one unnamed item, as if nothing had been read yet
    offerings: offerings.length > 0 ? offerings : [placeholderOffering()],
    operations: { ...cur.spec.operations, suppliers: cur.spec.operations.suppliers.filter(onlyOnPhoto("operations.suppliers", (s) => slugify(String(s.name.value)))) },
  };
  const touched = new Set<string>();
  for (const { path, fact } of listFacts(spec)) {
    if (!fromPhoto(fact)) continue;
    touched.add(path);
    const repl = said(path);
    if (repl) spec = setFact(spec, path, repl);
    else if (/^offerings\.[^.]+\.name$/.test(path)) spec = setFact(spec, path, { ...fact, source: { kind: fact.source.kind, ref: fact.source.ref, ...(fact.source.quote ? { quote: fact.source.quote } : {}) } }); // a kept item's name: the owner named it too, but the box on the photo is gone
    else if (OPTIONAL_FIELDS.has(path.split(".").at(-1)!)) spec = removeFact(spec, path);
    else spec = setFact(spec, path, missingFact(fact.value));
  }
  // a conflict with the photo is over whichever side was shown
  for (const [path, fs] of Object.entries(cur.alternatives)) if (fs.some(fromPhoto)) touched.add(path);
  const live = new Set(listFacts(spec).map((f) => f.path));
  spec = { ...spec, openQuestions: spec.openQuestions.filter((q) => live.has(q.fieldPath) && !(q.candidates && touched.has(q.fieldPath))) };
  const alternatives = Object.fromEntries(
    Object.entries(cur.alternatives)
      .filter(([path]) => live.has(path))
      .map(([path, fs]) => [path, fs.filter((f) => !fromPhoto(f))] as const)
      .filter(([, fs]) => fs.length > 0),
  );
  const { photo: _photo, ...drafts } = cur.drafts;
  const { photo: _file, photos: _files, ...rest } = cur;
  return { ...rest, spec: refreshQuestions(spec), alternatives, drafts };
}

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
    ...(cur?.photos ? { photos: cur.photos } : {}),
    transcripts: cur?.transcripts ?? [],
    statements: cur?.statements ?? [],
    voiceItems: kind === "voice" ? [...new Set([...voiceItems(cur), ...draft.spec.offerings.map((o) => o.id)])] : voiceItems(cur),
  };
}

/** Read every photo in one extraction and wrap it as the photo draft. */
async function readPhotos(llm: Parameters<typeof extractFromPhoto>[0], imgs: PhotoInput[], names: string[]): Promise<Draft> {
  const out = await extractFromPhoto(llm, imgs, names.join(", ") || "photo");
  return { spec: out.spec, createdAt: new Date().toISOString(), rejected: out.rejected, ...(out.notes ? { notes: out.notes } : {}) };
}

function storedInput(d: M2Deps, p: StoredPhoto): PhotoInput {
  const got = d.store.readPhoto({ photos: [p] });
  if (!got) throw new HttpError(409, "an earlier photo is missing on the server; remove it and upload it again");
  return { base64: got.bytes.toString("base64"), mediaType: got.mime as PhotoInput["mediaType"] };
}

export function intakeRoutes(d: M2Deps) {
  const r = newRouter();

  /**
   * One or more photos (multipart `image`, repeated). With `append=true` they join the photos already stored;
   * otherwise they replace them. Every photo kept is read again together, so facts across pages fit as one draft.
   */
  r.post("/intake/photo", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const one = (v: unknown) => (Array.isArray(v) ? v[0] : v);
    const businessId = checkBusinessId(one(body.businessId));
    const files = [body.image].flat().filter((f): f is File => f instanceof File);
    if (files.length === 0) throw new HttpError(400, "multipart field `image` (one or more photos) is required");
    for (const file of files) {
      if (!MEDIA.has(file.type)) throw new HttpError(415, `unsupported image type ${file.type || "unknown"}; use jpeg, png, webp or gif`);
      if (file.size > MAX_IMAGE) throw new HttpError(413, `${file.name || "a photo"} is over 5 MB`);
    }
    const cur0 = d.store.get(businessId);
    const kept = one(body.append) === "true" ? photosOf(cur0) : [];
    if (kept.length + files.length > MAX_PHOTOS) throw new HttpError(413, `up to ${MAX_PHOTOS} photos; you have ${kept.length} and sent ${files.length}`);
    const llm = requireLlm(d);
    const added = await Promise.all(files.map(async (f) => ({ bytes: Buffer.from(await f.arrayBuffer()), mime: f.type, name: f.name || "photo" })));
    const out = await readPhotos(llm, [...kept.map((p) => storedInput(d, p)), ...added.map((a) => ({ base64: a.bytes.toString("base64"), mediaType: a.mime as PhotoInput["mediaType"] }))], [...kept.map((p) => p.file), ...added.map((a) => a.name)]);
    const saved = added.map((a) => d.store.savePhoto(businessId, a.bytes, a.mime));
    const rec = await d.store.update(businessId, (cur) => ({ ...fold(cur, "photo", out), photos: [...kept, ...saved] }));
    if (cur0) d.store.deletePhoto(cur0, photosOf(cur0).filter((p) => !kept.some((k) => k.file === p.file)));
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

  /** Remove one photo (?i=N) or all of them. The rest are read again; with none left, what only the photos said is forgotten. */
  r.delete("/intake/photo/:businessId", async (c) => {
    const businessId = checkBusinessId(c.req.param("businessId"));
    const old = requireSpec(d, businessId);
    const photos = photosOf(old);
    if (photos.length === 0 && !old.drafts.photo) throw new HttpError(409, "no photo to remove");
    const i = c.req.query("i");
    const index = i === undefined ? -1 : Number(i);
    if (i !== undefined && !(Number.isInteger(index) && index >= 0 && index < photos.length)) throw new HttpError(404, "no such photo");
    const rest = index < 0 ? [] : photos.filter((_, k) => k !== index);
    let rec: StoredSpec;
    if (rest.length === 0) rec = await d.store.update(businessId, (cur) => withoutPhoto(cur!));
    else {
      const out = await readPhotos(requireLlm(d), rest.map((p) => storedInput(d, p)), rest.map((p) => p.file));
      rec = await d.store.update(businessId, (cur) => ({ ...fold(cur, "photo", out), photos: rest }));
    }
    d.store.deletePhoto(old, photos.filter((p) => !rest.includes(p)));
    return c.json(specView(rec));
  });

  r.get("/intake/photo/:businessId", (c) => {
    const rec = requireSpec(d, checkBusinessId(c.req.param("businessId")));
    const p = d.store.readPhoto(rec, Number(c.req.query("i") ?? 0) || 0);
    if (!p) throw new HttpError(404, "no photo stored");
    return new Response(new Uint8Array(p.bytes), { headers: { "content-type": p.mime, "cache-control": "no-store" } });
  });

  return r;
}
