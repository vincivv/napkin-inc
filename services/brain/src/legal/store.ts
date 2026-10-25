// Checklist persistence: <dataDir>/legal/<businessId>.json, written atomically (tmp + rename) with a
// version counter; updates for one business are serialized in-process (same pattern as SpecStore).

import fs from "node:fs";
import path from "node:path";
import { BUSINESS_ID_RE } from "../spec/store";
import type { LegalChecklist } from "./types";

export class LegalStore {
  private readonly dir: string;
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, "legal");
  }

  private file(businessId: string): string {
    if (!BUSINESS_ID_RE.test(businessId)) throw new Error(`invalid businessId "${businessId}"`);
    return path.join(this.dir, `${businessId}.json`);
  }

  get(businessId: string): LegalChecklist | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(businessId), "utf8")) as LegalChecklist;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** Atomically read-modify-write; `fn` may be async (it runs inside the business's lock). */
  update(businessId: string, fn: (cur: LegalChecklist | undefined) => Omit<LegalChecklist, "version" | "updatedAt" | "businessId"> | Promise<Omit<LegalChecklist, "version" | "updatedAt" | "businessId">>): Promise<LegalChecklist> {
    const prev = this.locks.get(businessId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        const cur = this.get(businessId);
        const next: LegalChecklist = { ...(await fn(cur)), businessId, version: (cur?.version ?? 0) + 1, updatedAt: new Date().toISOString() };
        fs.mkdirSync(this.dir, { recursive: true });
        const tmp = `${this.file(businessId)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, this.file(businessId));
        return next;
      });
    this.locks.set(businessId, run);
    return run;
  }
}
