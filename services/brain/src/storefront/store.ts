// Saved designs (dataDir/designs.json, same atomic JSON-file style as accounts.json) and owner photo
// uploads (dataDir/media/<random>.<ext>). Uploads are sniffed by magic bytes, never trusted by name or type.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StorefrontDesign } from "@napkin/schema";
import { log } from "../log";
import { JsonFileStore } from "../store";

export class DesignStore {
  private readonly file: JsonFileStore<Record<string, unknown>>;
  constructor(dataDir: string) {
    this.file = new JsonFileStore(path.join(dataDir, "designs.json"), () => ({}));
  }
  /** The saved design, if any (a row that no longer passes the schema is treated as absent). */
  get(businessId: string): StorefrontDesign | undefined {
    const raw = this.file.read()[businessId];
    if (raw === undefined) return undefined;
    const ok = StorefrontDesign.safeParse(raw);
    if (!ok.success) log.warn("design", `saved design for ${businessId} fails the schema; ignoring it`);
    return ok.success ? ok.data : undefined;
  }
  /** Forget the business's design; returns the uploaded media files it referenced, for the caller to delete. */
  remove(businessId: string): string[] {
    let media: string[] = [];
    this.file.update((all) => {
      const raw = all[businessId];
      if (raw === undefined) return;
      media = [...new Set([...JSON.stringify(raw).matchAll(/\/media\/([A-Za-z0-9_-]{22}\.(?:jpg|png|webp))\b/g)].map((m) => m[1]!))];
      delete all[businessId];
    });
    return media;
  }
  put(design: StorefrontDesign): void {
    const d = StorefrontDesign.parse(design);
    this.file.update((all) => {
      all[d.businessId] = d;
    });
  }
}

export const MAX_UPLOAD_BYTES = 6 * 1024 * 1024;
export const MEDIA_FILE_RE = /^[A-Za-z0-9_-]{22}\.(jpg|png|webp)$/;
export const MEDIA_TYPES = { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;
export type MediaExt = keyof typeof MEDIA_TYPES;

/** jpeg / png / webp from the first bytes; undefined for anything else. */
export function sniffImage(b: Uint8Array): MediaExt | undefined {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((x, i) => b[i] === x)) return "png";
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  return undefined;
}

export class MediaStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "media");
  }
  /** Saves an already-sniffed image under a random name; returns the file name. */
  save(bytes: Uint8Array, ext: MediaExt): string {
    const name = `${crypto.randomBytes(16).toString("base64url")}.${ext}`;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.dir, name), bytes, { mode: 0o600 });
    return name;
  }
  read(name: string): { bytes: Buffer; type: string } | undefined {
    const m = MEDIA_FILE_RE.exec(name);
    if (!m) return undefined;
    try {
      return { bytes: fs.readFileSync(path.join(this.dir, name)), type: MEDIA_TYPES[m[1] as MediaExt] };
    } catch {
      return undefined;
    }
  }
  remove(name: string): void {
    if (!MEDIA_FILE_RE.test(name)) return;
    fs.rmSync(path.join(this.dir, name), { force: true });
  }
}
