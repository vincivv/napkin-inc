// Minimal structured-ish logger. Never pass secrets (keys, tokens, PINs, grant codes) to it.

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;
const silent = process.env.VITEST !== undefined && process.env.LOG_LEVEL === undefined;

function emit(level: Level, scope: string, msg: string): void {
  if (silent || order[level] < min) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  (level === "error" || level === "warn" ? console.error : console.log)(line);
}

export const log = {
  debug: (scope: string, msg: string) => emit("debug", scope, msg),
  info: (scope: string, msg: string) => emit("info", scope, msg),
  warn: (scope: string, msg: string) => emit("warn", scope, msg),
  error: (scope: string, msg: string) => emit("error", scope, msg),
};

const BANNER_LINE = "!".repeat(78);
/** Loud, unmissable banner (used for the payment simulator). */
export function banner(lines: string[]): void {
  if (silent) return;
  console.error(["", BANNER_LINE, ...lines.map((l) => `!!  ${l}`), BANNER_LINE, ""].join("\n"));
}
