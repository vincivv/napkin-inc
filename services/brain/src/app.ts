// HTTP surface of the brain (M1: payments + owner auth + health). Built from injected deps so tests
// can run it with a fake platform and no network.

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { ownerLogin, RateLimiter } from "./auth";
import { log } from "./log";
import type { PlatformPort } from "./platform";
import { PlatformUnavailable, ReducerRefused } from "./stdb";
import { CheckoutError, CheckoutRequest, createCheckout, resolvePaymentLink, type SessionStore } from "./payments/checkout";
import { handlePaymentSucceeded } from "./payments/events";
import { PermanentProcessorError, TransientProcessorError, type ProcessorGateway } from "./payments/gateway";
import { ORDER_ID_RE, SIM } from "./payments/ids";
import { dispatchStripeEvent, verifyStripeEvent, WebhookSignatureError } from "./payments/webhook";

export interface AppDeps {
  platform: PlatformPort;
  gateway: ProcessorGateway;
  sessions: Pick<SessionStore, "get" | "put">;
  storePublicUrl: string;
  corsOrigins: string[];
  webhookSecret: string | undefined;
  ownerPin: string | undefined;
  /** the one business the shared OWNER_PIN signs in to (the phone line's) */
  pinBusinessId?: string;
  hasStorefront: (businessId: string) => boolean;
  health: () => Record<string, unknown>;
  clientKey?: (c: Context) => string;
  limiters?: { perClient: RateLimiter; global: RateLimiter };
  newOrderId?: (businessId: string) => string;
}

const jsonSafe = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const limiters = deps.limiters ?? { perClient: new RateLimiter(5, 5 * 60_000), global: new RateLimiter(30, 5 * 60_000) };
  const checkoutDeps = () => ({
    platform: deps.platform,
    gateway: deps.gateway,
    sessions: deps.sessions,
    storePublicUrl: deps.storePublicUrl,
    hasStorefront: deps.hasStorefront,
    ...(deps.newOrderId ? { newOrderId: deps.newOrderId } : {}),
  });

  app.use(
    "*",
    cors({
      origin: deps.corsOrigins,
      allowMethods: ["GET", "POST", "PATCH", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
      maxAge: 600,
    }),
  );

  app.onError((err, c) => {
    if (err instanceof CheckoutError) return c.json({ error: err.message }, err.status);
    if (err instanceof ReducerRefused) return c.json({ error: err.message, refusedBy: err.reducer }, 422);
    if (err instanceof PlatformUnavailable) return c.json({ error: `platform unavailable: ${err.message}` }, 503);
    if (err instanceof TransientProcessorError || err instanceof PermanentProcessorError) {
      log.error("http", `processor error: ${err.message}`);
      return c.json({ error: `payment processor error: ${err.message}` }, 502);
    }
    if (err instanceof ZodError) return c.json({ error: "invalid request", issues: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
    if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
    log.error("http", `${c.req.method} ${c.req.path}: ${err.stack ?? err.message}`);
    return c.json({ error: "internal error" }, 500);
  });

  app.get("/health", (c) => c.json(jsonSafe(deps.health()) as Record<string, unknown>));

  app.post("/checkout", async (c) => {
    const req = CheckoutRequest.parse(await c.req.json());
    const r = await createCheckout(req, checkoutDeps());
    log.info("checkout", `order ${r.orderId} for ${req.businessId}${r.simulated ? " [SIMULATED PAYMENT]" : ""}`);
    return c.json(r);
  });

  app.get("/p/:orderId", async (c) => {
    const orderId = c.req.param("orderId");
    if (!ORDER_ID_RE.test(orderId)) return c.json({ error: "not an order id" }, 404);
    return c.redirect(await resolvePaymentLink(orderId, checkoutDeps()), 303);
  });

  app.post("/webhooks/stripe", async (c) => {
    if (deps.gateway.mode !== "test") return c.json({ error: "Stripe is not configured (DEV SIMULATOR mode)" }, 503);
    if (!deps.webhookSecret) return c.json({ error: "STRIPE_WEBHOOK_SECRET is not set" }, 503);
    const raw = Buffer.from(await c.req.arrayBuffer());
    let event;
    try {
      event = verifyStripeEvent(raw, c.req.header("stripe-signature"), deps.webhookSecret);
    } catch (e) {
      if (e instanceof WebhookSignatureError) {
        log.warn("webhook", `rejected: ${e.message}`);
        return c.json({ error: "invalid signature" }, 400);
      }
      throw e;
    }
    try {
      const outcome = await dispatchStripeEvent(event, { platform: deps.platform, gateway: deps.gateway });
      log.info("webhook", `${event.type} ${event.id}: ${outcome.status}${outcome.status === "ignored" ? ` (${outcome.reason})` : ""}`);
      return c.json(jsonSafe({ received: true, eventId: event.id, ...outcome }) as Record<string, unknown>);
    } catch (e) {
      // Non-2xx makes Stripe redeliver; the platform dedupes, so retries are safe. Never drop silently.
      log.error("webhook", `${event.type} ${event.id} failed: ${(e as Error).message}`);
      throw e;
    }
  });

  app.post("/dev/simulate-payment/:orderId", async (c) => {
    if (deps.gateway.mode !== "simulator") return c.json({ error: "the payment simulator is disabled when a Stripe test key is configured" }, 404);
    const orderId = c.req.param("orderId");
    const order = deps.platform.order(orderId);
    if (!order) return c.json({ error: `unknown order ${orderId}` }, 404);
    log.warn("SIMULATOR", `SIMULATED payment for ${orderId}: ${order.totalCents} cents. No money moved; this is not Stripe.`);
    const r = await handlePaymentSucceeded(
      { eventId: SIM.eventId(orderId), businessId: order.businessId, orderId, amountCents: order.totalCents, paymentIntentId: SIM.paymentIntentId(orderId) },
      { platform: deps.platform, fees: deps.gateway },
    );
    return c.json(jsonSafe({ simulated: true, warning: "DEV SIMULATOR: no real payment, fee is the list-price formula", orderId, ...r }) as Record<string, unknown>);
  });

  app.post("/auth/owner", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }
    const key = deps.clientKey?.(c) ?? "unknown";
    const r = await ownerLogin(body, key, { platform: deps.platform, ownerPin: deps.ownerPin, ...(deps.pinBusinessId ? { pinBusinessId: deps.pinBusinessId } : {}), ...limiters });
    if (r.status !== 200) log.warn("auth", `owner login ${r.status} from ${key}`);
    else log.info("auth", `owner grant minted for ${r.body.businessId}`);
    return c.json(r.body, r.status);
  });

  return app;
}
