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
  // Phone line (M3-K). Every /phone/tools/* call needs `Authorization: Bearer <PHONE_TOOL_SECRET>`; unset = all refused.
  PHONE_TOOL_SECRET: optionalString,
  /** The one business this phone line answers for (the Cartesia tools send it as a constant). */
  PHONE_BUSINESS_ID: optionalString.transform((v) => v ?? "maya-cookies").pipe(z.string().regex(/^[a-z0-9-]{1,64}$/)),
  /** Owner mode needs the caller ID to equal OWNER_PHONE (E.164) AND the spoken PIN to equal OWNER_PIN. */
  OWNER_PHONE: optionalString,
  TWILIO_ACCOUNT_SID: optionalString,
  TWILIO_AUTH_TOKEN: optionalString,
  TWILIO_PHONE_NUMBER: optionalString,
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
  phoneToolSecret: string | undefined;
  phoneBusinessId: string;
  ownerPhone: string | undefined;
  twilio: { accountSid: string; authToken: string; fromNumber: string } | undefined;
  /** Why Twilio is not configured (for the startup log), when it is not. */
  twilioProblem: string | undefined;
}

/** Minimum PHONE_TOOL_SECRET length; a shorter secret is treated as unset (every phone tool call refused). */
export const MIN_PHONE_TOOL_SECRET_LENGTH = 24;

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
  const twilioSet = [e.TWILIO_ACCOUNT_SID, e.TWILIO_AUTH_TOKEN, e.TWILIO_PHONE_NUMBER].filter((v) => v !== undefined).length;
  let twilio: Env["twilio"];
  let twilioProblem: string | undefined;
  if (twilioSet === 0) twilioProblem = "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER are not set";
  else if (twilioSet < 3) twilioProblem = "only some of TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER are set";
  else if (!/^AC[0-9a-fA-F]{32}$/.test(e.TWILIO_ACCOUNT_SID!)) twilioProblem = "TWILIO_ACCOUNT_SID must look like AC + 32 hex characters";
  else if (!/^\+[1-9]\d{7,14}$/.test(e.TWILIO_PHONE_NUMBER!)) twilioProblem = "TWILIO_PHONE_NUMBER must be E.164, e.g. +14155550123";
  else twilio = { accountSid: e.TWILIO_ACCOUNT_SID!, authToken: e.TWILIO_AUTH_TOKEN!, fromNumber: e.TWILIO_PHONE_NUMBER! };
  const phoneToolSecret = e.PHONE_TOOL_SECRET && e.PHONE_TOOL_SECRET.length >= MIN_PHONE_TOOL_SECRET_LENGTH ? e.PHONE_TOOL_SECRET : undefined;
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
    phoneToolSecret,
    phoneBusinessId: e.PHONE_BUSINESS_ID,
    ownerPhone: e.OWNER_PHONE,
    twilio,
    twilioProblem,
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
    phoneToolSecret: env.phoneToolSecret ? "set" : `missing or shorter than ${MIN_PHONE_TOOL_SECRET_LENGTH} chars (all /phone/tools calls refused)`,
    phoneBusiness: env.phoneBusinessId,
    ownerPhone: env.ownerPhone ? "set" : "missing (phone owner mode disabled)",
    sms: env.twilio ? "twilio" : "SMS SIMULATOR (nothing is sent)",
  };
}
