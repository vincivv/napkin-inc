// Brain entry point: `pnpm --filter @napkin/brain start` (port 4000, env from the repo-root .env).

import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import Stripe from "stripe";
import { createApp } from "./app";
import { bootstrap, SEED_BUSINESSES } from "./bootstrap";
import { describeEnv, loadEnv, UnsafeEnvError, type Env } from "./env";
import { banner, log } from "./log";
import { StdbPlatform } from "./platform";
import { actorKey, StdbHub } from "./stdb";
import { IdentityStore } from "./store";
import { SessionStore } from "./payments/checkout";
import { SimulatorGateway, StripeGateway, type ProcessorGateway } from "./payments/gateway";
import { OutboxWorker, RefundExecutor, type OutboxExecutor } from "./payments/outbox";
import { registerM2Routes } from "./m2";
import { mountCompiler } from "./compiler/routes";
import { registerPhoneRoutes } from "./phone";
import { mountAgents } from "./agents";
import { AccountStore, businessGate, ensureSeedAccount, GATED_PATHS, registerAccountRoutes } from "./accounts";
import { SpecStore } from "./spec/store";
import { activeConfigReader, designInputFromConfig, mountStorefront } from "./storefront";
import { StdbCompilePlatform } from "./compiler/platform";
import { llmFromEnv } from "./llm";
import { RateLimiter } from "./auth";

let env: Env;
try {
  env = loadEnv();
} catch (e) {
  console.error(`brain refused to start: ${(e as Error).message}`);
  process.exit(e instanceof UnsafeEnvError ? 2 : 1);
}

log.info("brain", `config ${JSON.stringify(describeEnv(env))}`);

const hub = new StdbHub({ uri: env.stdbUri, db: env.stdbDb, identities: new IdentityStore(env.dataDir, `${env.stdbUri}#${env.stdbDb}`) });
const platform = new StdbPlatform(hub);

let gateway: ProcessorGateway;
if (env.stripeMode === "test") {
  gateway = new StripeGateway(new Stripe(env.stripeSecretKey!, { maxNetworkRetries: 2, appInfo: { name: "napkin-brain" } }));
  log.info("brain", "Stripe TEST MODE");
  if (!env.stripeWebhookSecret) log.warn("brain", "STRIPE_WEBHOOK_SECRET is not set: /webhooks/stripe will answer 503 until it is");
} else {
  gateway = new SimulatorGateway(platform);
  banner([
    "PAYMENTS ARE SIMULATED (DEV SIMULATOR). No STRIPE_SECRET_KEY is configured.",
    "No money moves. Fees use the list-price formula round(2.9% + 30c) and all ids start with sim_.",
    "POST /dev/simulate-payment/:orderId marks an order paid. Add an sk_test_ key to use real Stripe test mode.",
  ]);
}

const state: { bootstrapped: boolean; error?: string; lastAttempt?: string; steps: string[] } = { bootstrapped: false, steps: [] };
const executors: OutboxExecutor[] = [new RefundExecutor(platform, gateway)];
const worker = new OutboxWorker({ platform, executors, staleMs: env.outboxStaleSeconds * 1000 });

async function runBootstrap(): Promise<void> {
  state.lastAttempt = new Date().toISOString();
  try {
    const r = await bootstrap(hub);
    state.bootstrapped = true;
    state.steps = r.steps;
    for (const shop of phone.deps.platform.shops()) phone.deps.codes.codeFor(shop.id); // every live shop has its phone code
    delete state.error;
    worker.start();
    log.info("brain", "bootstrap complete; outbox worker running");
  } catch (e) {
    state.error = `${(e as Error).name}: ${(e as Error).message}`;
    log.error("brain", `bootstrap failed (retrying in 15s): ${state.error}`);
    setTimeout(runBootstrap, 15_000).unref();
  }
}

function health(): Record<string, unknown> {
  const connected = platform.isConnected();
  const businesses: Record<string, unknown> = {};
  for (const b of SEED_BUSINESSES) {
    const row = connected ? platform.business(b.id) : undefined;
    businesses[b.id] = {
      registered: Boolean(row),
      activeConfigId: row?.activeConfigId ?? 0n,
      enforce: row?.enforce,
      storefrontReady: Boolean(hub.get(actorKey("storefront", b.id))),
    };
  }
  const outbox = connected ? platform.outboxItems() : [];
  return {
    ok: connected && state.bootstrapped,
    stdb: { connected, uri: env.stdbUri, db: env.stdbDb, systemIdentity: hub.get("system")?.identityHex },
    stripe: { mode: env.stripeMode, simulated: env.stripeMode === "simulator", webhookSecret: Boolean(env.stripeWebhookSecret) },
    bootstrap: { ok: state.bootstrapped, error: state.error, lastAttempt: state.lastAttempt, businesses },
    outbox: { pending: outbox.filter((o) => o.status === "pending").length, claimed: outbox.filter((o) => o.status === "claimed").length },
    phone: {
      toolSecret: Boolean(env.phoneToolSecret),
      business: env.phoneBusinessId,
      ownerMode: Boolean(env.ownerPhone && env.ownerPin),
      sms: phone.deps.smsMode === "twilio" ? "twilio" : "SMS SIMULATOR (nothing is sent)",
      smsPending: outbox.filter((o) => o.kind === "sms" && (o.status === "pending" || o.status === "claimed")).length,
      payLinkBase: env.brainUrl,
    },
  };
}

/** Rate-limit key: the caller's address; behind the Cloudflare tunnel every request comes from loopback, so use the address Cloudflare saw. */
function clientKey(c: Parameters<NonNullable<Parameters<typeof createApp>[0]["clientKey"]>>[0]): string {
  let remote = "unknown";
  try {
    remote = getConnInfo(c).remote.address ?? "unknown";
  } catch {
    /* not a node request */
  }
  const viaTunnel = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  return (viaTunnel && c.req.header("cf-connecting-ip")) || remote;
}

const sessions = new SessionStore(env.dataDir);
const hasStorefront = (businessId: string) => Boolean(hub.get(actorKey("storefront", businessId)));
const app = createApp({
  platform,
  gateway,
  sessions,
  storePublicUrl: env.storePublicUrl,
  corsOrigins: env.corsOrigins,
  webhookSecret: env.stripeWebhookSecret,
  ownerPin: env.ownerPin,
  pinBusinessId: env.phoneBusinessId,
  hasStorefront,
  health,
  clientKey,
});

// Owner accounts (one business per account). The gate runs before the setup routes below, so intake,
// questions, owner statements and compile only ever touch the signed-in account's own business.
const accounts = new AccountStore(env.dataDir);
const specs = new SpecStore(env.dataDir);
ensureSeedAccount(accounts, { email: process.env["MAYA_ACCOUNT_EMAIL"], password: process.env["MAYA_ACCOUNT_PASSWORD"], businessId: "maya-cookies", businessName: "Maya's Cookies" });
registerAccountRoutes(app, {
  store: accounts,
  businessIdTaken: (id) => Boolean(platform.business(id)) || Boolean(specs.get(id)),
  businessExists: (id) => Boolean(platform.business(id)),
  createOwnerGrant: (g) => platform.createRoleGrant({ ...g, role: "owner", name: "Owner" }),
  clientKey,
});
const gate = businessGate(accounts);
for (const p of GATED_PATHS) app.use(p, gate);

const m2 = registerM2Routes(app, hub, env.dataDir); // M2: intake + question engine
// Storefront designs: public GET for the store, owner edits/uploads behind the same account gate.
const designs = mountStorefront(app, { dataDir: env.dataDir, mediaBaseUrl: env.brainUrl, gate, activeConfig: activeConfigReader(new StdbCompilePlatform(hub)), llm: llmFromEnv() });
// M3-K: phone line webhook tools. Orders go through the same createCheckout path as the storefront.
const phone = registerPhoneRoutes(app, { env, hub, m2, checkout: { platform, gateway, sessions, storePublicUrl: env.storePublicUrl, hasStorefront } });
executors.push(phone.smsExecutor); // drains the platform outbox rows of kind "sms" queued by place_order
// M2: compiler (POST /compile, SSE). After a successful compile the business gets its phone code right away
// (the store, dashboard and phone agent all read this one saved code), and, if it has no saved design, one
// generated in the background (Claude + Openverse); the compile stream never waits for it.
mountCompiler(app, hub, env.dataDir, {
  afterCompile: ({ businessId, config }) => {
    log.info("phone", `${businessId}: phone code ${phone.deps.codes.codeFor(businessId)}`);
    designs.ensureInBackground(designInputFromConfig(config));
  },
});
// M3: AI staff. Bookkeeper and /ask are owner-only; the storefront chat (Shopkeeper, Support) is public but
// rate-limited: 40 turns per caller per 15 minutes, 600 per hour overall.
mountAgents(app, hub, { platform, gateway, sessions, storePublicUrl: env.storePublicUrl, hasStorefront }, {
  ownerGate: gate,
  customerLimits: { perClient: new RateLimiter(40, 15 * 60_000), global: new RateLimiter(600, 60 * 60_000), clientKey },
});

serve({ fetch: app.fetch, port: env.port }, (info) => log.info("brain", `listening on http://localhost:${info.port}`));
void runBootstrap();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop();
    hub.disconnectAll();
    process.exit(0);
  });
}
