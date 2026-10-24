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
  hasStorefront,
  health,
  clientKey: (c) => {
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  },
});
const m2 = registerM2Routes(app, hub, env.dataDir); // M2: intake + question engine
mountCompiler(app, hub, env.dataDir); // M2: compiler (POST /compile, SSE)
// M3-K: phone line webhook tools. Orders go through the same createCheckout path as the storefront.
const phone = registerPhoneRoutes(app, { env, hub, m2, checkout: { platform, gateway, sessions, storePublicUrl: env.storePublicUrl, hasStorefront } });
executors.push(phone.smsExecutor); // drains the platform outbox rows of kind "sms" queued by place_order

serve({ fetch: app.fetch, port: env.port }, (info) => log.info("brain", `listening on http://localhost:${info.port}`));
void runBootstrap();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    worker.stop();
    hub.disconnectAll();
    process.exit(0);
  });
}
