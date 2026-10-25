// Public runtime settings (inlined by Next at build time).
export const STDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI || "ws://localhost:3000";
export const STDB_DB = process.env.NEXT_PUBLIC_SPACETIMEDB_DB || "napkin";
export const BRAIN_URL = (process.env.NEXT_PUBLIC_BRAIN_URL || "http://localhost:4000").replace(/\/+$/, "");
/** The app's own SpacetimeDB identity token, one per account (an identity can hold only one business role). */
export const tokenKey = (uri: string, db: string, accountId: string) => `napkin-owner:stdb-token:${uri}:${db}:${accountId}`;
export const SESSION_KEY = "napkin-owner:session";
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
export const STORE_URL = (process.env.NEXT_PUBLIC_STORE_URL || "http://localhost:3002").replace(/\/+$/, "");

/** The shared phone line (E.164) every live shop takes orders on; empty = not shown. */
export const PHONE_LINE = (process.env.NEXT_PUBLIC_PHONE_LINE || "").trim();

/** "+19064989806" -> "(906) 498-9806" for US numbers; anything else unchanged. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
