// LLM-backed extraction (photo, transcript) with one retry on invalid output, plus Cartesia speech-to-text.

import { ContractError, type BusinessSpec } from "@napkin/schema";
import { ZodError } from "zod";
import { MODELS, type Llm, type UserContent } from "../llm";
import { assembleSpec, EXTRACTION_SCHEMA, Extraction, type AssembleCtx } from "./extract";

const COMMON_RULES = `Rules (never assume):
- Only record what the source shows or says. If something is not there, OMIT the field. Do not invent costs, stock, hours, tax, discounts or policies.
- provenance "paper"/"owner_said" ONLY when you can give the exact supporting quote. A guess is provenance "inferred" with confidence <= 0.4 and the evidence in quote.
- Every item for sale has at least one variant (a size/format with its own price). An item with one price gets one variant named like the item.
- One item = one pile of stock. Its variants sell that SAME stock in different amounts (a single cookie uses 1, a box of 6 uses 6: that is stockUnits). Things counted separately ("have 20 small, 10 big") or physically different products are SEPARATE items, each with its own initialStock and one variant.
- initialStock is how many the owner has now; stockUnits is how many of them ONE sale of a variant uses. Never put an inventory count in stockUnits.
- Add-ons like "+ sea salt $1" go in addOns of the item they extend, with their own price. An add-on that applies to every item goes on each of them.
- Money values are digits only (3.00). Rates and percentages keep their % sign (20%), never a bare fraction.`;

const PHOTO_SYSTEM = `You read a photo of a small business's paper (menu, price list, napkin, whiteboard) and extract a structured draft of the business.
${COMMON_RULES}
- For every fact read from the image give region = approximate bounding box of the text, normalized 0..1 from the top-left (x,y,w,h), and quote = the exact text.
- Put illegible or ambiguous things in notes.`;

const VOICE_SYSTEM = `You extract business facts from what the OWNER SAID aloud (a transcript). Everything the owner states directly is provenance "owner_said" with the owner's exact words as quote.
${COMMON_RULES}
- If a "Known names" list is given, reuse those exact names for items/variants/add-ons the owner is clearly referring to.
- Do not extract anything the owner did not say.`;

async function withRetry(call: (feedback?: string) => Promise<unknown>, ctx: AssembleCtx): Promise<{ spec: BusinessSpec; rejected: string[]; notes?: string }> {
  let feedback: string | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const ex = Extraction.parse(await call(feedback));
      const { spec, rejected } = assembleSpec(ex, ctx);
      return { spec, rejected, ...(ex.notes ? { notes: ex.notes } : {}) };
    } catch (e) {
      if (!(e instanceof ZodError || e instanceof ContractError)) throw e;
      lastErr = e;
      feedback = `Your previous output was invalid: ${e.message.slice(0, 600)}. Call the tool again with valid output.`;
    }
  }
  throw new ExtractionFailed(`the model's output was invalid twice: ${(lastErr as Error).message.slice(0, 300)}`);
}

export class ExtractionFailed extends Error {
  override name = "ExtractionFailed";
}

export function extractFromPhoto(llm: Llm, img: { base64: string; mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp" }, ref: string) {
  return withRetry(
    (feedback) => {
      const content: UserContent[] = [
        { type: "image", mediaType: img.mediaType, base64: img.base64 },
        { type: "text", text: `Extract the business draft from this image.${feedback ? `\n\n${feedback}` : ""}` },
      ];
      return llm.tool({ model: MODELS.opus, system: PHOTO_SYSTEM, content, toolName: "record_business_draft", toolDescription: "Record the extracted draft.", schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>, maxTokens: 6000 });
    },
    { mode: "photo", ref },
  );
}

export function extractFromTranscript(llm: Llm, transcript: string, ref: string, mode: "voice" | "chat", knownNames: string[] = []) {
  return withRetry(
    (feedback) =>
      llm.tool({
        model: MODELS.opus,
        system: VOICE_SYSTEM,
        content: [{ type: "text", text: `${knownNames.length ? `Known names: ${knownNames.join("; ")}\n\n` : ""}Transcript:\n"""${transcript}"""${feedback ? `\n\n${feedback}` : ""}` }],
        toolName: "record_business_draft",
        toolDescription: "Record what the owner said.",
        schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 4000,
      }),
    { mode, ref },
  );
}

// ---------- Cartesia batch STT ----------
export class SttError extends Error {
  override name = "SttError";
}

export async function transcribe(apiKey: string, audio: Blob, filename: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const form = new FormData();
  form.set("file", audio, filename);
  form.set("model", "ink-whisper");
  form.set("language", "en");
  const res = await fetchImpl("https://api.cartesia.ai/stt", { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Cartesia-Version": "2026-08-14" }, body: form });
  if (!res.ok) throw new SttError(`Cartesia STT failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { text?: string };
  if (typeof j.text !== "string") throw new SttError("Cartesia STT returned no text");
  return j.text.trim();
}
