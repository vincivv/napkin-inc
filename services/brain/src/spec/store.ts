// Draft BusinessSpec persistence: services/brain/.data/specs/<businessId>.json (gitignored), with a version
// counter bumped on every write. Updates for one business are serialized in-process.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseBusinessSpec, type BusinessSpec } from "@napkin/schema";
import type { Alternatives } from "../intake/merge";
import type { StatementDiff } from "../questions/statement";

export interface Draft {
  spec: BusinessSpec;
  createdAt: string;
  rejected: string[];
  notes?: string;
}
export interface PendingStatement {
  id: string;
  text: string;
  channel: "app" | "phone";
  diff: StatementDiff;
  status: "pending" | "confirmed" | "rejected" | "applied";
  createdAt: string;
  decidedAt?: string;
}
export interface StoredSpec {
  businessId: string;
  version: number;
  updatedAt: string;
  spec: BusinessSpec;
  alternatives: Alternatives;
  drafts: { photo?: Draft; voice?: Draft };
  /** the owner's photos, in the order they were read (regions point at them by index) */
  photos?: StoredPhoto[];
  /** before several photos: the one photo (read as photos[0]) */
  photo?: StoredPhoto;
  transcripts: { id: string; text: string; source: "voice" | "typed"; createdAt: string }[];
  statements: PendingStatement[];
  /** ids of the items the owner named in any voice or typed note (they survive a replacement photo) */
  voiceItems?: string[];
}

export interface StoredPhoto {
  file: string;
  mime: string;
}

/** Photos of a record, old single-photo records included. */
export const photosOf = (rec: Pick<StoredSpec, "photos" | "photo"> | undefined): StoredPhoto[] => rec?.photos ?? (rec?.photo ? [rec.photo] : []);

export const MAX_PHOTOS = 6;

export const BUSINESS_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class SpecStore {
  private readonly dir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "specs");
  }

  private file(businessId: string, ext = "json"): string {
    if (!BUSINESS_ID_RE.test(businessId)) throw new Error(`invalid businessId "${businessId}"`);
    return path.join(this.dir, `${businessId}.${ext}`);
  }

  get(businessId: string): StoredSpec | undefined {
    try {
      const s = JSON.parse(fs.readFileSync(this.file(businessId), "utf8")) as StoredSpec;
      s.spec = parseBusinessSpec(s.spec);
      if (s.photo && !s.photos) s.photos = [s.photo];
      delete s.photo;
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Atomically read-modify-write. `fn` receives the current record (or undefined) and returns the next one (version is set here). */
  update(businessId: string, fn: (cur: StoredSpec | undefined) => Omit<StoredSpec, "version" | "updatedAt" | "businessId">): Promise<StoredSpec> {
    const prev = this.locks.get(businessId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      const cur = this.get(businessId);
      const next: StoredSpec = { ...fn(cur), businessId, version: (cur?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file(businessId)}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, this.file(businessId));
      return next;
    });
    this.locks.set(businessId, run);
    return run;
  }

  /** Saves one photo under a fresh name (several photos live side by side). */
  savePhoto(businessId: string, bytes: Buffer, mime: string): StoredPhoto {
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(businessId, `photo-${crypto.randomBytes(6).toString("hex")}.${ext}`);
    fs.writeFileSync(file, bytes);
    return { file: path.basename(file), mime };
  }
  /** Start over: the draft spec and its photo are gone (waits for any in-flight update of this business). */
  async remove(businessId: string): Promise<void> {
    const prev = this.locks.get(businessId) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(() => {
      const cur = this.get(businessId);
      if (cur) this.deletePhoto(cur);
      fs.rmSync(this.file(businessId), { force: true });
    });
    this.locks.set(businessId, run);
    return run;
  }
  /** Deletes the record's photo files (all of them, or just `only`). */
  deletePhoto(rec: Pick<StoredSpec, "photos" | "photo">, only?: StoredPhoto[]): void {
    for (const p of only ?? photosOf(rec)) fs.rmSync(path.join(this.dir, path.basename(p.file)), { force: true });
  }
  readPhoto(rec: Pick<StoredSpec, "photos" | "photo">, index = 0): { bytes: Buffer; mime: string } | undefined {
    const p = photosOf(rec)[index];
    if (!p) return undefined;
    try {
      return { bytes: fs.readFileSync(path.join(this.dir, path.basename(p.file))), mime: p.mime };
    } catch {
      return undefined;
    }
  }
}
