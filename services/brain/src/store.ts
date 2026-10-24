// Tiny JSON-file stores under services/brain/.data (gitignored). Writes are atomic (tmp + rename).

import fs from "node:fs";
import path from "node:path";

export class JsonFileStore<T extends object> {
  constructor(
    readonly file: string,
    private readonly empty: () => T,
  ) {}

  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return this.empty();
      throw new Error(`cannot read ${this.file}: ${(e as Error).message}`);
    }
  }

  write(value: T): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  update(fn: (value: T) => void): T {
    const v = this.read();
    fn(v);
    this.write(v);
    return v;
  }
}

/** One SpacetimeDB identity (and its long-lived token) per actor, per server+database. */
export interface StoredIdentity {
  identity: string;
  token: string;
  createdAt: string;
}
export type IdentityFile = Record<string /* `${uri}#${db}` */, Record<string /* actor key */, StoredIdentity>>;

export class IdentityStore {
  private readonly store: JsonFileStore<IdentityFile>;
  constructor(
    dataDir: string,
    private readonly scope: string,
  ) {
    this.store = new JsonFileStore(path.join(dataDir, "identities.json"), () => ({}));
  }
  get(actorKey: string): StoredIdentity | undefined {
    return this.store.read()[this.scope]?.[actorKey];
  }
  set(actorKey: string, value: StoredIdentity): void {
    this.store.update((f) => {
      (f[this.scope] ??= {})[actorKey] = value;
    });
  }
}
