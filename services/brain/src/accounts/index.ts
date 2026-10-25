// Owner accounts: email + password, one business per account. The brain keeps accounts in
// services/brain/.data/accounts.json (gitignored, mode 0600): passwords as scrypt hashes, sessions as
// SHA-256 hashes of random bearer tokens. A session never touches money directly: it unlocks the
// account's OWN business in the setup routes (intake, questions, compile) and mints a one-time owner
// role grant that the owner app's own SpacetimeDB identity redeems, exactly like the old PIN login.

import crypto from "node:crypto";
import path from "node:path";
import type { Context, Hono, MiddlewareHandler } from "hono";
import { z } from "zod";
import { newGrantCode, RateLimiter } from "../auth";
import { log } from "../log";
import { JsonFileStore } from "../store";

export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const OWNER_GRANT_TTL_SECONDS = 120;

export interface Account {
  id: string;
  email: string;
  /** scrypt$N$r$p$salt$hash (base64url) */
  passwordHash: string;
  businessId: string | null;
  businessName: string | null;
  createdAt: string;
}
interface SessionRow {
  accountId: string;
  expiresAt: number;
}
interface AccountFile {
  accounts: Account[];
  /** sha256(token) -> session */
  sessions: Record<string, SessionRow>;
}
export interface AccountView {
  id: string;
  email: string;
  businessId: string | null;
  businessName: string | null;
}
export const view = (a: Account): AccountView => ({ id: a.id, email: a.email, businessId: a.businessId, businessName: a.businessName });

// ---- passwords ------------------------------------------------------------------------------------

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password: string, salt: Buffer = crypto.randomBytes(16)): string {
  const h = crypto.scryptSync(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64url"), h.toString("base64url")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64url"), want.length, { N: Number(n), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(got, want);
}

/** A fixed hash to compare against when the email is unknown, so timing does not reveal which emails exist. */
const DUMMY_HASH = hashPassword("napkin-dummy-password", Buffer.alloc(16));

// ---- slugs ----------------------------------------------------------------------------------------

/** "Maya's Cookies!" -> "mayas-cookies". */
export function slugify(name: string): string {
  const s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "shop";
}

// ---- store ----------------------------------------------------------------------------------------

export class AccountStore {
  private readonly file: JsonFileStore<AccountFile>;
  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.file = new JsonFileStore(path.join(dataDir, "accounts.json"), () => ({ accounts: [], sessions: {} }));
  }

  private static tokenHash(token: string) {
    return crypto.createHash("sha256").update(token, "utf8").digest("hex");
  }

  byEmail(email: string): Account | undefined {
    const e = email.trim().toLowerCase();
    return this.file.read().accounts.find((a) => a.email === e);
  }
  byId(id: string): Account | undefined {
    return this.file.read().accounts.find((a) => a.id === id);
  }
  /** businesses already claimed by some account */
  claimedBusinesses(): Set<string> {
    return new Set(this.file.read().accounts.flatMap((a) => (a.businessId ? [a.businessId] : [])));
  }

  create(email: string, password: string, business?: { id: string; name: string }): Account {
    const acct: Account = {
      id: `acct_${crypto.randomBytes(9).toString("base64url")}`,
      email: email.trim().toLowerCase(),
      passwordHash: hashPassword(password),
      businessId: business?.id ?? null,
      businessName: business?.name ?? null,
      createdAt: new Date(this.now()).toISOString(),
    };
    this.file.update((f) => {
      if (f.accounts.some((a) => a.email === acct.email)) throw new AccountError(409, "an account with this email already exists");
      if (acct.businessId && f.accounts.some((a) => a.businessId === acct.businessId)) throw new AccountError(409, `business ${acct.businessId} already belongs to an account`);
      f.accounts.push(acct);
    });
    return acct;
  }

  /** One business per account: refuses when the account already has one or the id is taken. */
  setBusiness(accountId: string, businessId: string, businessName: string): Account {
    let out: Account | undefined;
    this.file.update((f) => {
      const a = f.accounts.find((x) => x.id === accountId);
      if (!a) throw new AccountError(404, "unknown account");
      if (a.businessId) throw new AccountError(409, "this account already has a business (one business per account)");
      if (f.accounts.some((x) => x.businessId === businessId)) throw new AccountError(409, `business ${businessId} already belongs to an account`);
      a.businessId = businessId;
      a.businessName = businessName;
      out = a;
    });
    return out!;
  }

  newSession(accountId: string): string {
    const token = crypto.randomBytes(32).toString("base64url");
    const t = this.now();
    this.file.update((f) => {
      for (const [k, s] of Object.entries(f.sessions)) if (s.expiresAt <= t) delete f.sessions[k];
      f.sessions[AccountStore.tokenHash(token)] = { accountId, expiresAt: t + SESSION_TTL_MS };
    });
    return token;
  }
  session(token: string): Account | undefined {
    const s = this.file.read().sessions[AccountStore.tokenHash(token)];
    if (!s || s.expiresAt <= this.now()) return undefined;
    return this.byId(s.accountId);
  }
  endSession(token: string): void {
    this.file.update((f) => {
      delete f.sessions[AccountStore.tokenHash(token)];
    });
  }
}

export class AccountError extends Error {
  override name = "AccountError";
  constructor(readonly status: 400 | 401 | 403 | 404 | 409 | 429, message: string) {
    super(message);
  }
}

// ---- HTTP -----------------------------------------------------------------------------------------

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, "use at least 8 characters").max(200),
});
const BusinessName = z.object({ name: z.string().trim().min(2).max(60) });

export interface AccountDeps {
  store: AccountStore;
  /** is this business id already used anywhere (platform row or a spec in progress)? */
  businessIdTaken(id: string): boolean;
  businessExists(id: string): boolean;
  createOwnerGrant(g: { code: string; businessId: string; ttlSeconds: number }): Promise<void>;
  clientKey(c: Context): string;
  limits?: { perClient: RateLimiter; global: RateLimiter };
}

export function bearer(c: Context): string | undefined {
  const h = c.req.header("authorization");
  const m = h && /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(h.trim());
  return m?.[1];
}

export function currentAccount(c: Context, store: AccountStore): Account | undefined {
  const t = bearer(c);
  return t ? store.session(t) : undefined;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

export function registerAccountRoutes(app: Hono, d: AccountDeps): void {
  const limits = d.limits ?? { perClient: new RateLimiter(20, 15 * 60_000), global: new RateLimiter(300, 15 * 60_000) };
  const limited = (c: Context) => {
    for (const r of [limits.perClient.hit(d.clientKey(c)), limits.global.hit("*")]) {
      if (!r.allowed) throw new AccountError(429, `too many attempts; try again in ${r.retryAfterSeconds}s`);
    }
  };
  const requireAccount = (c: Context) => {
    const a = currentAccount(c, d.store);
    if (!a) throw new AccountError(401, "please sign in");
    return a;
  };
  const fail = (c: Context, e: unknown) => {
    if (e instanceof AccountError) return c.json({ error: e.message }, e.status);
    if (e instanceof z.ZodError) return c.json({ error: e.issues.map((i) => i.message).join("; ") }, 400);
    throw e;
  };

  app.post("/accounts/signup", async (c) => {
    try {
      limited(c);
      const { email, password } = Credentials.parse(await readJson(c));
      const acct = d.store.create(email, password);
      log.info("accounts", `signup ${acct.id}`);
      return c.json({ token: d.store.newSession(acct.id), account: view(acct) }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/accounts/login", async (c) => {
    try {
      limited(c);
      const { email, password } = Credentials.parse(await readJson(c));
      const acct = d.store.byEmail(email);
      const ok = verifyPassword(password, acct?.passwordHash ?? DUMMY_HASH) && Boolean(acct);
      if (!ok || !acct) throw new AccountError(401, "wrong email or password");
      return c.json({ token: d.store.newSession(acct.id), account: view(acct) });
    } catch (e) {
      return fail(c, e);
    }
  });

  app.post("/accounts/logout", (c) => {
    const t = bearer(c);
    if (t) d.store.endSession(t);
    return c.json({ ok: true });
  });

  app.get("/accounts/me", (c) => {
    try {
      const a = requireAccount(c);
      return c.json({ account: view(a), businessLive: a.businessId ? d.businessExists(a.businessId) : false });
    } catch (e) {
      return fail(c, e);
    }
  });

  /** Name the business: picks a free slug from the name and binds it to this account (once). */
  app.post("/accounts/business", async (c) => {
    try {
      const a = requireAccount(c);
      if (a.businessId) throw new AccountError(409, "this account already has a business (one business per account)");
      const { name } = BusinessName.parse(await readJson(c));
      const base = slugify(name);
      const claimed = d.store.claimedBusinesses();
      let id = base;
      for (let i = 2; claimed.has(id) || d.businessIdTaken(id); i++) id = `${base.slice(0, 36)}-${i}`;
      const updated = d.store.setBusiness(a.id, id, name);
      log.info("accounts", `${a.id} created business ${id}`);
      return c.json({ account: view(updated) }, 201);
    } catch (e) {
      return fail(c, e);
    }
  });

  /** One-time owner role grant for the account's own business (redeemed by the owner app's identity). */
  app.post("/accounts/owner-grant", async (c) => {
    try {
      limited(c);
      const a = requireAccount(c);
      if (!a.businessId) throw new AccountError(409, "create your business first");
      if (!d.businessExists(a.businessId)) throw new AccountError(409, "your business is not live yet: finish setup first");
      const code = newGrantCode();
      await d.createOwnerGrant({ code, businessId: a.businessId, ttlSeconds: OWNER_GRANT_TTL_SECONDS });
      log.info("accounts", `owner grant minted for ${a.businessId}`);
      return c.json({ code, businessId: a.businessId, expiresInSeconds: OWNER_GRANT_TTL_SECONDS });
    } catch (e) {
      return fail(c, e);
    }
  });
}

/**
 * Gate for the setup routes (intake, questions, owner statements, compile, storefront design edits): the
 * signed-in account must own the business named in the request. Reads businessId from the path, the query or the body (Hono
 * caches the parsed body, so the route handler can read it again).
 */
export function businessGate(store: AccountStore): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method === "OPTIONS") return next();
    const a = currentAccount(c, store);
    if (!a) return c.json({ error: "please sign in" }, 401);
    // the path wins: the handler acts on its path param, so a ?businessId= of your own must not unlock another's path
    let businessId: unknown = PATH_BUSINESS.exec(c.req.path)?.slice(1).find(Boolean) ?? c.req.query("businessId");
    if (businessId === undefined && c.req.method === "POST") {
      const type = c.req.header("content-type") ?? "";
      try {
        const body = type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded") ? await c.req.parseBody() : ((await c.req.json()) as Record<string, unknown>);
        businessId = (body as Record<string, unknown>)["businessId"];
      } catch {
        businessId = undefined;
      }
    }
    if (typeof businessId !== "string" || !businessId) return c.json({ error: "businessId is required" }, 400);
    if (a.businessId !== businessId) return c.json({ error: "you can only change your own business" }, 403);
    return next();
  };
}

/** Routes that carry the business in the path (the storefront design routes mount the gate per route). */
const PATH_BUSINESS = /^\/(?:intake\/photo|spec)\/([a-z0-9-]{1,64})$|^\/compile\/([a-z0-9-]{1,64})\/latest$|^\/storefront\/([a-z0-9-]{1,64})\/(?:design(?:\/regenerate|\/status)?|images\/[^/]+)$/;

/** The owner routes the gate protects (Hono path patterns). /expenses/* carries businessId in the query or form. */
export const GATED_PATHS = ["/intake/*", "/spec/*", "/questions/*", "/owner/*", "/compile", "/compile/*", "/expenses/*"] as const;

/** Seeds an account for an existing business (e.g. the Maya demo) from env; idempotent. */
export function ensureSeedAccount(store: AccountStore, seed: { email: string | undefined; password: string | undefined; businessId: string; businessName: string }): void {
  if (!seed.email || !seed.password) return;
  if (store.byEmail(seed.email)) return;
  if (store.claimedBusinesses().has(seed.businessId)) return;
  store.create(seed.email, seed.password, { id: seed.businessId, name: seed.businessName });
  log.info("accounts", `seeded the account for ${seed.businessId}`);
}
