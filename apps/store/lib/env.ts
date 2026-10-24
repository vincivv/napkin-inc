// Public runtime configuration. NEXT_PUBLIC_* values are inlined at build time.
const trimSlash = (s: string) => s.replace(/\/+$/, "");

export const SPACETIMEDB_URI = process.env.NEXT_PUBLIC_SPACETIMEDB_URI || "ws://localhost:3000";
export const SPACETIMEDB_DB = process.env.NEXT_PUBLIC_SPACETIMEDB_DB || "napkin";
export const BRAIN_URL = trimSlash(process.env.NEXT_PUBLIC_BRAIN_URL || "http://localhost:4000");
export const STORE_URL = trimSlash(process.env.NEXT_PUBLIC_STORE_URL || "http://localhost:3002");
