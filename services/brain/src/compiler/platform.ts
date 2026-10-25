// What the /compile route needs from the platform and from the spec store, behind small ports so the
// route is tested with fakes. All writes run as the SYSTEM identity; the platform decides who may do what.

import type { BusinessSpec } from "@napkin/schema";
import type { SpecStore } from "../spec/store";
import { waitFor, type StdbHub } from "../stdb";

export interface ConfigVersionView {
  id: bigint;
  version: number;
  status: string;
  json: string;
}

export interface CompilePlatformPort {
  business(id: string): { id: string; name: string; activeConfigId: bigint } | undefined;
  configVersions(businessId: string): ConfigVersionView[];
  hasOwner(businessId: string): boolean;
  registerBusiness(id: string, name: string): Promise<void>;
  submitConfiguration(businessId: string, json: string, proofReportJson: string): Promise<void>;
  /** system may only do this for a brand-new business with no owner (the platform enforces it) */
  activateConfiguration(configId: bigint): Promise<void>;
  /** waits for the submitted row to reach the system cache */
  awaitConfigVersion(businessId: string, version: number, timeoutMs?: number): Promise<ConfigVersionView | undefined>;
}

export interface SpecSource {
  /** the owner-confirmed spec for a business (written by the intake/question engine) */
  get(businessId: string): Promise<BusinessSpec | undefined>;
  /** the stored spec's version (each owner edit bumps it) */
  version?(businessId: string): Promise<number | undefined>;
}

/** The intake/question engine's spec store (src/spec/store.ts): .data/specs/<businessId>.json. */
export class SpecStoreSource implements SpecSource {
  constructor(private readonly store: Pick<SpecStore, "get">) {}
  async get(businessId: string): Promise<BusinessSpec | undefined> {
    return this.store.get(businessId)?.spec;
  }
  async version(businessId: string): Promise<number | undefined> {
    return this.store.get(businessId)?.version;
  }
}

export class StdbCompilePlatform implements CompilePlatformPort {
  constructor(private readonly hub: StdbHub) {}
  private get db() {
    return this.hub.system().conn.db;
  }
  business(id: string) {
    const b = this.db.business.id.find(id);
    return b ? { id: b.id, name: b.name, activeConfigId: b.activeConfigId } : undefined;
  }
  configVersions(businessId: string): ConfigVersionView[] {
    return [...this.db.configVersion.businessId.filter(businessId)].map((c) => ({ id: c.id, version: c.version, status: c.status, json: c.json }));
  }
  hasOwner(businessId: string): boolean {
    for (const a of this.db.actor.businessId.filter(businessId)) if (a.role === "owner") return true;
    return false;
  }
  async registerBusiness(id: string, name: string): Promise<void> {
    await this.hub.call("system", "registerBusiness", (c) => c.reducers.registerBusiness({ id, name, enforce: true }));
    await waitFor(() => this.business(id));
  }
  submitConfiguration(businessId: string, json: string, proofReportJson: string): Promise<void> {
    return this.hub.call("system", "submitConfiguration", (c) => c.reducers.submitConfiguration({ businessId, json, proofReportJson }));
  }
  async activateConfiguration(configId: bigint): Promise<void> {
    await this.hub.call("system", "activateConfiguration", (c) => c.reducers.activateConfiguration({ configId }));
  }
  awaitConfigVersion(businessId: string, version: number, timeoutMs = 5_000) {
    return waitFor(() => this.configVersions(businessId).find((v) => v.version === version), timeoutMs);
  }
}
