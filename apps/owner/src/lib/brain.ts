// Client for the brain's M2 endpoints (intake, questions, owner statements, spec).

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

/** What the brain read off a receipt photo: a pre-fill only. "" = not read (the owner fills it in). */
export interface ReceiptRead {
  vendor: string;
  date: string;
  total: string;
  tax: string;
  currency: string;
  category: string;
  /** the suggested category's expense account code, or "" */
  account: string;
  items: { description: string; amount: string }[];
  notes: string;
  confidence: number;
  itemsMatchTotal: boolean | null;
  dropped: string[];
}
export interface ReceiptResponse {
  receiptRef: string;
  read: ReceiptRead | null;
  readError?: string;
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
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new BrainError(res.status, body.error ?? `request failed (${res.status})`);
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
  dismiss: (businessId: string, id: string) => req<SpecResponse>(`/questions/${encodeURIComponent(id)}/dismiss`, json({ businessId })),
  statement: (businessId: string, text: string, channel: "app" | "phone") => req<{ statementId: string; diff: PendingStatement["diff"] }>("/owner/statement", json({ businessId, text, channel })),
  statements: (b: string) => req<{ statements: PendingStatement[] }>(`/owner/statements?businessId=${encodeURIComponent(b)}`),
  decide: (businessId: string, id: string, confirm: boolean) => req<SpecResponse>(`/owner/statement/${id}/decide`, json({ businessId, confirm })),
  /** Store a receipt photo and read it into pre-fill values (nothing is posted). */
  readReceipt(businessId: string, file: File) {
    const fd = new FormData();
    fd.set("businessId", businessId);
    fd.set("image", file);
    return req<ReceiptResponse>("/expenses/receipt", { method: "POST", body: fd });
  },
  /** A stored receipt as an object URL (fetched with the session; an <img src> could not send it). */
  async receiptObjectUrl(businessId: string, ref: string): Promise<string> {
    const res = await fetch(`${BRAIN_URL}/expenses/receipt?businessId=${encodeURIComponent(businessId)}&ref=${encodeURIComponent(ref)}`, { headers: authHeaders() });
    if (!res.ok) throw new BrainError(res.status, `receipt unavailable (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },
};

export const provenanceLabel = { owner_said: "you said it", paper: "read from paper", inferred: "my guess" } as const;
