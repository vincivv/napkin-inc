// Draft BusinessSpec persistence: services/brain/.data/specs/<businessId>.json (gitignored), with a version
// counter bumped on every write. Updates for one business are serialized in-process.

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
  photo?: { file: string; mime: string };
  transcripts: { id: string; text: string; source: "voice" | "typed"; createdAt: string }[];
  statements: PendingStatement[];
}

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

  savePhoto(businessId: string, bytes: Buffer, mime: string): { file: string; mime: string } {
    const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "jpg";
    fs.mkdirSync(this.dir, { recursive: true });
    const file = this.file(businessId, `photo.${ext}`);
    fs.writeFileSync(file, bytes);
    return { file: path.basename(file), mime };
  }
  readPhoto(rec: StoredSpec): { bytes: Buffer; mime: string } | undefined {
    if (!rec.photo) return undefined;
    try {
      return { bytes: fs.readFileSync(path.join(this.dir, path.basename(rec.photo.file))), mime: rec.photo.mime };
    } catch {
      return undefined;
    }
  }
}
