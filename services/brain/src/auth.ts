// Owner login for the owner app: PIN -> one-time role grant code. The owner app's OWN SpacetimeDB
// identity redeems the code (redeemRoleGrant), so the brain never holds the owner identity.

import crypto from "node:crypto";
import { z } from "zod";
import type { PlatformPort } from "./platform";

export const OWNER_GRANT_TTL_SECONDS = 120;

/** One-time role grant codes: 160 random bits. Never logged. */
export function newGrantCode(): string {
  return crypto.randomBytes(20).toString("base64url");
}

/** Constant-time PIN comparison (hashing first makes the lengths equal, so length does not leak). */
export function pinMatches(given: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(given, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

/** Fixed-window counter per key. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const t = this.now();
    let h = this.hits.get(key);
    if (!h || t >= h.resetAt) {
      h = { count: 0, resetAt: t + this.windowMs };
      this.hits.set(key, h);
    }
    h.count++;
    return { allowed: h.count <= this.max, retryAfterSeconds: Math.max(0, Math.ceil((h.resetAt - t) / 1000)) };
  }
}

export const OwnerLoginRequest = z.object({
  pin: z.string().min(1).max(64),
  businessId: z.string().regex(/^[a-z0-9-]{1,64}$/).default("maya-cookies"),
});

export interface OwnerLoginDeps {
  platform: Pick<PlatformPort, "business" | "createRoleGrant">;
  ownerPin: string | undefined;
  /** the one business the shared PIN is for (the phone line's); every other business signs in with its account */
  pinBusinessId?: string;
  /** per client address */
  perClient: RateLimiter;
  /** across all clients (a tunnel makes every client look the same) */
  global: RateLimiter;
  newCode?: () => string;
}

export type OwnerLoginResult =
  | { status: 200; body: { code: string; businessId: string; role: "owner"; expiresInSeconds: number } }
  | { status: 400 | 401 | 404 | 429 | 503; body: { error: string; retryAfterSeconds?: number } };

export async function ownerLogin(input: unknown, clientKey: string, deps: OwnerLoginDeps): Promise<OwnerLoginResult> {
  if (!deps.ownerPin) return { status: 503, body: { error: "owner login is disabled: OWNER_PIN is not set" } };
  for (const limiter of [deps.perClient.hit(clientKey), deps.global.hit("*")]) {
    if (!limiter.allowed) return { status: 429, body: { error: "too many attempts; try again later", retryAfterSeconds: limiter.retryAfterSeconds } };
  }
  const parsed = OwnerLoginRequest.safeParse(input);
  if (!parsed.success) return { status: 400, body: { error: "expected {pin, businessId?}" } };
  const { pin, businessId } = parsed.data;
  if (!pinMatches(pin, deps.ownerPin)) return { status: 401, body: { error: "wrong PIN" } };
  if (deps.pinBusinessId && businessId !== deps.pinBusinessId) return { status: 401, body: { error: "the PIN only signs in to the phone line's business; use your account" } };
  if (!deps.platform.business(businessId)) return { status: 404, body: { error: `unknown business ${businessId}` } };
  const code = (deps.newCode ?? newGrantCode)();
  await deps.platform.createRoleGrant({ code, businessId, role: "owner", name: "Owner", ttlSeconds: OWNER_GRANT_TTL_SECONDS });
  return { status: 200, body: { code, businessId, role: "owner", expiresInSeconds: OWNER_GRANT_TTL_SECONDS } };
}
