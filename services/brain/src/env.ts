// Typed environment for the brain. Loaded from the repo-root .env by `tsx --env-file-if-exists`.
// Secrets are never logged: describeEnv() prints only which values are present.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export class UnsafeEnvError extends Error {
  override name = "UnsafeEnvError";
}

const BRAIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim()));

const url = (fallback: string) =>
  optionalString.transform((v) => (v ?? fallback).replace(/\/+$/, "")).pipe(z.url());

const EnvSchema = z.object({
  PORT: optionalString.transform((v) => (v ? Number(v) : 4000)).pipe(z.number().int().min(1).max(65535)),
  SPACETIMEDB_URI: url("http://localhost:3000"),
  SPACETIMEDB_DB: optionalString.transform((v) => v ?? "napkin").pipe(z.string().regex(/^[a-z0-9-]+$/)),
  STRIPE_SECRET_KEY: optionalString,
  STRIPE_WEBHOOK_SECRET: optionalString,
  OWNER_PIN: optionalString,
  STORE_PUBLIC_URL: url("http://localhost:3002"),
  OWNER_APP_URL: url("http://localhost:3001"),
  BRAIN_URL: url("http://localhost:4000"),
  /** Extra comma-separated CORS origins (e.g. a tunnel URL). */
  CORS_ORIGINS: optionalString,
  /** Where identities.json and sessions.json live. Default services/brain/.data (gitignored). */
  BRAIN_DATA_DIR: optionalString,
  /** A claimed outbox item older than this is retried with the same idempotency key. */
  OUTBOX_STALE_SECONDS: optionalString.transform((v) => (v ? Number(v) : 60)).pipe(z.number().int().min(5)),
});

export type StripeMode = "test" | "simulator";

export interface Env {
  port: number;
  stdbUri: string;
  stdbDb: string;
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripeMode: StripeMode;
  ownerPin: string | undefined;
  storePublicUrl: string;
  ownerAppUrl: string;
  brainUrl: string;
  corsOrigins: string[];
  dataDir: string;
  outboxStaleSeconds: number;
}

/**
 * Refuses live Stripe keys (sk_live_/rk_live_) and anything that is not a test secret or restricted key.
 * Returns the mode: "test" when a test key is present, "simulator" when no key is configured.
 */
export function stripeModeFor(key: string | undefined): StripeMode {
  if (key === undefined) return "simulator";
  if (/^(sk|rk)_live_/.test(key)) {
    throw new UnsafeEnvError("STRIPE_SECRET_KEY is a LIVE key. Napkin Inc. runs Stripe in TEST MODE ONLY. Refusing to start.");
  }
  if (!/^(sk|rk)_test_/.test(key)) {
    throw new UnsafeEnvError("STRIPE_SECRET_KEY must be a Stripe test secret key (sk_test_... or rk_test_...). Refusing to start.");
  }
  return "test";
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    // Only field names and messages, never values.
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new UnsafeEnvError(`invalid environment: ${issues}`);
  }
  const e = parsed.data;
  const stripeMode = stripeModeFor(e.STRIPE_SECRET_KEY);
  if (e.STRIPE_WEBHOOK_SECRET !== undefined && !e.STRIPE_WEBHOOK_SECRET.startsWith("whsec_")) {
    throw new UnsafeEnvError("STRIPE_WEBHOOK_SECRET must start with whsec_");
  }
  const extra = (e.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  const corsOrigins = [...new Set(["http://localhost:3001", "http://localhost:3002", e.OWNER_APP_URL, e.STORE_PUBLIC_URL, ...extra])];
  return {
    port: e.PORT,
    stdbUri: e.SPACETIMEDB_URI,
    stdbDb: e.SPACETIMEDB_DB,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET,
    stripeMode,
    ownerPin: e.OWNER_PIN,
    storePublicUrl: e.STORE_PUBLIC_URL,
    ownerAppUrl: e.OWNER_APP_URL,
    brainUrl: e.BRAIN_URL,
    corsOrigins,
    dataDir: e.BRAIN_DATA_DIR ? path.resolve(e.BRAIN_DATA_DIR) : path.join(BRAIN_DIR, ".data"),
    outboxStaleSeconds: e.OUTBOX_STALE_SECONDS,
  };
}

/** Safe summary for logs: presence of secrets only. */
export function describeEnv(env: Env): Record<string, string | number | boolean> {
  return {
    port: env.port,
    stdb: `${env.stdbUri} db=${env.stdbDb}`,
    stripeMode: env.stripeMode,
    stripeWebhookSecret: env.stripeWebhookSecret ? "set" : "missing",
    ownerPin: env.ownerPin ? "set" : "missing (owner login disabled)",
    store: env.storePublicUrl,
    ownerApp: env.ownerAppUrl,
    cors: env.corsOrigins.join(","),
  };
}
