// What the checklist generator may know about a business, built only from facts the owner gave:
// the draft BusinessSpec during setup, or the active Configuration once live. Missing facts, guessed
// locations and placeholder (unconfirmed) configuration fields are left out, never filled in.

import type { BusinessSpec, Configuration } from "@napkin/schema";
import { isMissing } from "../spec/paths";
import type { LegalProfile } from "./types";

type F = BusinessSpec["business"]["name"];
const text = (f: F | undefined): string | undefined => {
  if (!f || isMissing(f)) return undefined;
  const v = String(f.value ?? "").trim();
  return v ? v : undefined;
};

export function profileFromSpec(spec: BusinessSpec): LegalProfile {
  const b = spec.business;
  const loc = b.location;
  // a location the model guessed is not a fact: ask the owner instead
  const location = loc.provenance === "inferred" && !loc.confirmed ? undefined : text(loc);
  const fulfillment = isMissing(spec.operations.fulfillment) ? undefined : String(spec.operations.fulfillment.value);
  const offerings = spec.offerings
    .map((o) => {
      const name = text(o.name);
      const desc = text(o.description);
      return name ? (desc ? `${name} (${desc})` : name) : undefined;
    })
    .filter((x): x is string => Boolean(x));
  return strip({
    name: text(b.name),
    oneLiner: text(b.oneLiner),
    community: text(b.community),
    location,
    hours: text(b.hours),
    fulfillment,
    pickupLocation: text(spec.operations.pickupLocation),
    offerings,
  });
}

export function profileFromConfig(cfg: Configuration): LegalProfile {
  const unconfirmed = new Set(cfg._unconfirmed?.paths ?? []);
  const keep = (p: string, v: string | undefined) => (v && v.trim() && !unconfirmed.has(p) ? v.trim() : undefined);
  const offerings = cfg.catalogs
    .flatMap((c) => c.entries.map((e) => e.data["name"]))
    .filter((n): n is string => typeof n === "string" && n.trim() !== "");
  return strip({
    name: keep("business.name", cfg.business.name),
    oneLiner: keep("business.oneLiner", cfg.business.oneLiner),
    community: keep("business.community", cfg.business.community),
    hours: keep("business.hours", cfg.business.hours),
    fulfillment: cfg.policies.fulfillment,
    pickupLocation: keep("business.pickupLocation", cfg.business.pickupLocation),
    offerings: [...new Set(offerings)],
  });
}

function strip(p: LegalProfile): LegalProfile {
  return Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as unknown as LegalProfile;
}

/** Enough to tailor anything: we know what the business is or sells. */
export const knowsBusiness = (p: LegalProfile | undefined): p is LegalProfile => Boolean(p && (p.oneLiner || p.offerings.length > 0));
