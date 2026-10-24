// Public runtime settings (inlined by Next at build time).
export const STDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI || "ws://localhost:3000";
export const STDB_DB = process.env.NEXT_PUBLIC_SPACETIMEDB_DB || "napkin";
export const BRAIN_URL = (process.env.NEXT_PUBLIC_BRAIN_URL || "http://localhost:4000").replace(/\/+$/, "");
export const DEFAULT_BUSINESS = process.env.NEXT_PUBLIC_BUSINESS_SLUG || "maya-cookies";

export const tokenKey = (uri: string, db: string) => `napkin-owner:stdb-token:${uri}:${db}`;
export const BUSINESS_KEY = "napkin-owner:business";
export const PREVIEW_KEY = "napkin-owner:preview";

export function safeGet(storage: "local" | "session", key: string): string | null {
  try {
    return (storage === "local" ? window.localStorage : window.sessionStorage).getItem(key);
  } catch {
    return null;
  }
}
export function safeSet(storage: "local" | "session", key: string, value: string | null) {
  try {
    const s = storage === "local" ? window.localStorage : window.sessionStorage;
    if (value === null) s.removeItem(key);
    else s.setItem(key, value);
  } catch {
    /* storage unavailable */
  }
}
