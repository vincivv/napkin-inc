// Client for the brain's M2 endpoints (intake, questions, owner statements, spec) and the storefront design.

import type { StorefrontDesign } from "@napkin/schema/storefront-design";
import { BRAIN_URL } from "@/data/env";
import { authHeaders } from "@/data/account";

export interface FactView {
  value: unknown;
  provenance: "owner_said" | "paper" | "inferred";
  confidence: number;
  confirmed: boolean;
  source: { kind: string; ref: string; quote?: string; region?: { x: number; y: number; w: number; h: number } };
}
export interface FactRow {
  path: string;
  label: string;
  display: string | null;
  missing: boolean;
  moneyRelevant: boolean;
  moneyImpact: number;
  fact: FactView;
}
export interface SpecResponse {
  businessId: string;
  version: number;
  moneyReady: boolean;
  blockers: { path: string; why: "missing" | "guess" | "unconfirmed" | "invalid" }[];
  counts: { paper: number; owner_said: number; inferred: number; missing: number; confirmed: number; total: number };
  facts: FactRow[];
  hasPhoto: boolean;
  drafts: { photo: boolean; voice: boolean };
  transcript?: string;
  notes?: string;
  rejected?: string[];
}
export interface QuestionView {
  id: string;
  fieldPath: string;
  question: string;
  phrased: string;
  phrasedBy: "haiku" | "template";
  impactScore: number;
  moneyRelevant: boolean;
  candidates?: string[];
  current?: { display: string; provenance: FactView["provenance"]; confidence: number; source: FactView["source"]; confirmed: boolean };
}
export interface NextResponse {
  question: QuestionView | null;
  remaining: number;
  moneyReady: boolean;
}
export interface DiffChange {
  path: string;
  label: string;
  beforeText: string;
  afterText: string;
}
export interface PendingStatement {
  id: string;
  text: string;
  channel: "app" | "phone";
  status: "pending" | "confirmed" | "rejected" | "applied";
  createdAt: string;
  diff: { changes: DiffChange[]; unparsed: string[]; note?: string };
}

export interface ReviewItem {
  id: string;
  fieldPath: string;
  label: string;
  display: string;
  provenance: "owner_said" | "paper";
  quote: string;
  moneyRelevant: boolean;
}
export interface ReviewResponse {
  items: ReviewItem[];
  /** open questions that still need a typed answer (guesses, conflicts, missing values) */
  needAnswers: number;
  moneyReady: boolean;
}

export class BrainError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRAIN_URL}${path}`, { ...init, headers: { ...authHeaders(), ...(init?.headers as Record<string, string> | undefined) } });
  } catch {
    throw new BrainError(0, `Cannot reach the brain at ${BRAIN_URL}. Is it running?`);
  }
  const body = (await res.json().catch(() => ({}))) as { error?: string; reasons?: string[] };
  if (!res.ok) throw new BrainError(res.status, [body.error ?? `request failed (${res.status})`, ...(body.reasons ?? [])].join(" · "));
  return body as T;
}
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const brain = {
  /** The napkin photo as an object URL (fetched with the session; an <img src> could not send it). */
  async photoObjectUrl(businessId: string, v: number): Promise<string> {
    const res = await fetch(`${BRAIN_URL}/intake/photo/${businessId}?v=${v}`, { headers: authHeaders() });
    if (!res.ok) throw new BrainError(res.status, `photo unavailable (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },
  spec: (b: string) => req<SpecResponse>(`/spec/${b}`),
  uploadPhoto(businessId: string, file: File) {
    const fd = new FormData();
    fd.set("businessId", businessId);
    fd.set("image", file);
    return req<SpecResponse>("/intake/photo", { method: "POST", body: fd });
  },
  /** Forget the photo and everything read only from it (typed and spoken facts stay). */
  removePhoto: (b: string) => req<SpecResponse>(`/intake/photo/${encodeURIComponent(b)}`, { method: "DELETE" }),
  /** The owner types the right value for a fact (it becomes their own confirmed word). */
  editFact: (businessId: string, path: string, value: string) => req<SpecResponse>("/intake/edit", json({ businessId, path, value })),
  /** Remove an item (by its name's path) or forget a value. */
  removeFact: (businessId: string, path: string) => req<SpecResponse>("/intake/remove", json({ businessId, path })),
  /** Throw the whole setup draft away (only before the business is live). */
  resetSetup: (businessId: string) => req<{ ok: true }>("/intake/reset", json({ businessId })),
  sendVoice(businessId: string, audio: Blob) {
    const fd = new FormData();
    fd.set("businessId", businessId);
    fd.set("audio", new File([audio], "voice.webm", { type: audio.type || "audio/webm" }));
    return req<SpecResponse>("/intake/voice", { method: "POST", body: fd });
  },
  sendTranscript(businessId: string, transcript: string) {
    const fd = new FormData();
    fd.set("businessId", businessId);
    fd.set("transcript", transcript);
    return req<SpecResponse>("/intake/voice", { method: "POST", body: fd });
  },
  merge: (businessId: string) => req<SpecResponse>("/intake/merge", json({ businessId })),
  next: (b: string) => req<NextResponse>(`/questions/next?businessId=${encodeURIComponent(b)}`),
  answer: (businessId: string, id: string, body: { answer?: string; confirm?: boolean }) => req<SpecResponse & { decisionRecorded: boolean }>(`/questions/${encodeURIComponent(id)}/answer`, json({ businessId, ...body })),
  review: (b: string) => req<ReviewResponse>(`/questions/review?businessId=${encodeURIComponent(b)}`),
  confirmMany: (businessId: string, questionIds: string[]) => req<SpecResponse & { confirmed: string[]; skipped: { id: string; reason: string }[] }>("/questions/confirm", json({ businessId, questionIds })),
  dismiss: (businessId: string, id: string) => req<SpecResponse>(`/questions/${encodeURIComponent(id)}/dismiss`, json({ businessId })),
  statement: (businessId: string, text: string, channel: "app" | "phone") => req<{ statementId: string; diff: PendingStatement["diff"] }>("/owner/statement", json({ businessId, text, channel })),
  statements: (b: string) => req<{ statements: PendingStatement[] }>(`/owner/statements?businessId=${encodeURIComponent(b)}`),
  decide: (businessId: string, id: string, confirm: boolean) => req<SpecResponse>(`/owner/statement/${id}/decide`, json({ businessId, confirm })),

  /** The shop's 4-digit phone code (public; assigned when the business went live). 404 until it is live. */
  phoneCode: (b: string) => req<{ code: string }>(`/phone/code/${encodeURIComponent(b)}`, { cache: "no-store" }),
  /** The owner asks the Bookkeeper. `refs` are documents it cited that its tool results showed; `unverifiedRefs` it named without reading. */
  ask: (businessId: string, question: string) => req<{ answer: string; refs: string[]; unverifiedRefs: string[] }>("/ask", json({ businessId, question })),

  // ---- storefront design (look only: never prices, stock or policies) ----
  design: (b: string) => req<StorefrontDesign>(`/storefront/${encodeURIComponent(b)}/design`, { cache: "no-store" }),
  /** Resolves with the new design. A slow generation answers 202; then this polls the status until it lands. */
  async regenerateDesign(b: string, style?: StorefrontDesign["style"]): Promise<StorefrontDesign> {
    const id = encodeURIComponent(b);
    const r = await req<StorefrontDesign | { status: "running" }>(`/storefront/${id}/design/regenerate`, json(style ? { style } : {}));
    if (!("status" in r)) return r;
    for (let i = 0; i < 80; i++) {
      await new Promise((ok) => setTimeout(ok, 3_000));
      const s = await req<{ running: boolean; error: string | null }>(`/storefront/${id}/design/status`, { cache: "no-store" });
      if (s.running) continue;
      if (s.error) throw new BrainError(500, `the design could not be generated: ${s.error}`);
      return brain.design(b);
    }
    throw new BrainError(504, "the design is still being generated; reload this page in a minute");
  },
  patchDesign: (b: string, patch: DesignPatch) =>
    req<StorefrontDesign>(`/storefront/${encodeURIComponent(b)}/design`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }),
  uploadDesignImage(b: string, slot: string, file: File) {
    const fd = new FormData();
    fd.set("file", file);
    return req<StorefrontDesign>(`/storefront/${encodeURIComponent(b)}/images/${encodeURIComponent(slot)}`, { method: "POST", body: fd });
  },
  removeDesignImage: (b: string, slot: string) => req<StorefrontDesign>(`/storefront/${encodeURIComponent(b)}/images/${encodeURIComponent(slot)}`, { method: "DELETE" }),
};

export type DesignPatch = Partial<Pick<StorefrontDesign, "style" | "corners" | "fonts" | "palette" | "announcement" | "collection">> & {
  hero?: Partial<Pick<StorefrontDesign["hero"], "eyebrow" | "title" | "subtitle" | "cta" | "layout">>;
  banner?: Partial<Pick<StorefrontDesign["banner"], "title">>;
};

export const provenanceLabel = { owner_said: "you said it", paper: "read from paper", inferred: "my guess" } as const;
