// Public runtime configuration. NEXT_PUBLIC_* values are inlined at build time.
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const SPACETIMEDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI || "ws://localhost:3000";
export const SPACETIMEDB_DB = process.env.NEXT_PUBLIC_SPACETIMEDB_DB || "napkin";
export const BRAIN_URL = trimSlash(process.env.NEXT_PUBLIC_BRAIN_URL || "http://localhost:4000");
export const STORE_URL = trimSlash(process.env.NEXT_PUBLIC_STORE_URL || "http://localhost:3002");
export const OWNER_URL = trimSlash(process.env.NEXT_PUBLIC_OWNER_URL || "http://localhost:3001");
/** The shared phone line (E.164) where every live shop takes orders by voice; empty = not shown. */
export const PHONE_LINE = (process.env.NEXT_PUBLIC_PHONE_LINE || "").trim();

/** "+19064989806" -> "(906) 498-9806" for US numbers; anything else unchanged. */
export function formatPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
