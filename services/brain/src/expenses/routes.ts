// POST /expenses/receipt   multipart { businessId, image } -> { receiptRef, read | null, readError? }
// GET  /expenses/receipt?businessId=&ref=                  -> the stored receipt image
//
// Both are behind the account gate ("/expenses/*" in GATED_PATHS): only the signed-in owner of that business.
// The brain never posts an expense itself. The owner checks the pre-filled values and saves the expense from
// the owner app, which calls the platform's createDocument as the owner (AI staff are not expense creators).

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { log } from "../log";
import { LlmUnavailable, type Llm } from "../llm";
import { checkBusinessId, HttpError, newRouter } from "../m2deps";
import { BUSINESS_ID_RE } from "../spec/store";
import { readReceipt, type ReceiptMediaType, type ReceiptRead } from "./receipt";

const MAX_IMAGE = 5 * 1024 * 1024;
const EXT: Record<ReceiptMediaType, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const MIME: Record<string, ReceiptMediaType> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
/** A stored receipt's reference (what the expense document's receiptRef field holds). */
export const RECEIPT_REF_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp|gif)$/;

/** Receipt images under <dataDir>/receipts/<businessId>/<uuid>.<ext> (gitignored with the rest of .data). */
export class ReceiptStore {
  private readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "receipts");
  }
  private folder(businessId: string): string {
    if (!BUSINESS_ID_RE.test(businessId)) throw new Error(`invalid businessId "${businessId}"`);
    return path.join(this.dir, businessId);
  }
  save(businessId: string, bytes: Buffer, mime: ReceiptMediaType, id: string = randomUUID()): string {
    const ref = `${id}.${EXT[mime]}`;
    if (!RECEIPT_REF_RE.test(ref)) throw new Error("invalid receipt id");
    const dir = this.folder(businessId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ref), bytes);
    return ref;
  }
  read(businessId: string, ref: string): { bytes: Buffer; mime: ReceiptMediaType } | undefined {
    if (!RECEIPT_REF_RE.test(ref)) return undefined;
    try {
      return { bytes: fs.readFileSync(path.join(this.folder(businessId), ref)), mime: MIME[ref.slice(ref.lastIndexOf(".") + 1)]! };
    } catch {
      return undefined;
    }
  }
}

export interface ExpenseDeps {
  llm: Llm | undefined;
  receipts: ReceiptStore;
  newId?: () => string;
}

export function expenseRoutes(d: ExpenseDeps): Hono {
  const r = newRouter();

  r.post("/expenses/receipt", async (c) => {
    const body = await c.req.parseBody();
    const businessId = checkBusinessId(body.businessId);
    const file = body.image;
    if (!(file instanceof File)) throw new HttpError(400, "multipart field `image` (a receipt photo) is required");
    if (!(file.type in EXT)) throw new HttpError(415, `unsupported image type ${file.type || "unknown"}; use jpeg, png, webp or gif`);
    if (file.size === 0) throw new HttpError(400, "empty image");
    if (file.size > MAX_IMAGE) throw new HttpError(413, "image is over 5 MB");
    const mime = file.type as ReceiptMediaType;
    const bytes = Buffer.from(await file.arrayBuffer());
    // Keep the image even if reading fails: the owner can still type the values and attach the receipt.
    const receiptRef = d.receipts.save(businessId, bytes, mime, d.newId?.());
    let read: ReceiptRead | null = null;
    let readError: string | undefined;
    if (!d.llm) readError = "Receipt reading is unavailable (ANTHROPIC_API_KEY is not set). Fill in the values from the receipt.";
    else {
      try {
        read = await readReceipt(d.llm, { base64: bytes.toString("base64"), mediaType: mime });
      } catch (e) {
        const msg = e instanceof LlmUnavailable || (e as Error).name === "ReceiptUnreadable" ? (e as Error).message : "the AI service failed";
        log.warn("expenses", `receipt read failed for ${businessId}: ${(e as Error).message.slice(0, 300)}`);
        readError = `I couldn't read this receipt (${msg}). Fill in the values from the receipt.`;
      }
    }
    return c.json({ receiptRef, read, ...(readError ? { readError } : {}) });
  });

  r.get("/expenses/receipt", (c) => {
    const businessId = checkBusinessId(c.req.query("businessId"));
    const ref = c.req.query("ref") ?? "";
    if (!RECEIPT_REF_RE.test(ref)) throw new HttpError(400, "ref must be a receipt reference");
    const img = d.receipts.read(businessId, ref);
    if (!img) throw new HttpError(404, "no such receipt");
    return new Response(new Uint8Array(img.bytes), { headers: { "content-type": img.mime, "cache-control": "private, max-age=3600" } });
  });

  return r;
}

export function mountExpenses(app: Hono, deps: ExpenseDeps): void {
  if (!deps.llm) log.warn("expenses", "ANTHROPIC_API_KEY not set: receipts are stored but not read (the owner types the values)");
  app.route("/", expenseRoutes(deps));
}
