import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { newGrantCode, pinMatches, RateLimiter } from "../src/auth";
import { loadEnv, stripeModeFor, UnsafeEnvError } from "../src/env";
import { CheckoutError, createCheckout, lineItemsFromSale } from "../src/payments/checkout";
import { ORDER_ID_RE, newOrderId, simulatedFeeCents } from "../src/payments/ids";
import { OutboxWorker, RefundExecutor } from "../src/payments/outbox";
import { dispatchStripeEvent, verifyStripeEvent, WebhookSignatureError } from "../src/payments/webhook";
import { FakeGateway, FakePlatform } from "./fakes";

const SECRET = "whsec_testsecret";
const sign = (payload: string) => Stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });

const completedEvent = (id = "evt_1", orderId = "MC-AAAAA") => ({
  id, object: "event", type: "checkout.session.completed",
  data: { object: { id: "cs_test_1", object: "checkout.session", payment_status: "paid", amount_total: 600, payment_intent: "pi_1", metadata: { orderId, businessId: "maya-cookies" } } },
}) as unknown as Stripe.Event;

function setup() {
  const platform = new FakePlatform();
  const gateway = new FakeGateway();
  const sessions = new Map<string, never>();
  const app = createApp({
    platform, gateway, sessions: { get: (k) => sessions.get(k), put: (r) => void sessions.set(r.orderId, r as never) },
    storePublicUrl: "http://localhost:3002", corsOrigins: ["http://localhost:3001", "http://localhost:3002"], webhookSecret: SECRET,
    ownerPin: "2468", hasStorefront: () => true, health: () => ({ ok: true }),
    limiters: { perClient: new RateLimiter(3, 60_000), global: new RateLimiter(100, 60_000) },
    newOrderId: () => "MC-AAAAA",
  });
  return { platform, gateway, app };
}

const post = (app: ReturnType<typeof setup>["app"], path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("env", () => {
  it("refuses live keys", () => {
    expect(() => stripeModeFor("sk_live_abc")).toThrow(UnsafeEnvError);
    expect(() => stripeModeFor("rk_live_abc")).toThrow(UnsafeEnvError);
    expect(() => loadEnv({ STRIPE_SECRET_KEY: "sk_live_abc" })).toThrow(/LIVE/);
    expect(() => stripeModeFor("pk_test_abc")).toThrow(UnsafeEnvError);
  });
  it("modes", () => {
    expect(stripeModeFor(undefined)).toBe("simulator");
    expect(stripeModeFor("sk_test_abc")).toBe("test");
    expect(loadEnv({}).port).toBe(4000);
    expect(loadEnv({}).corsOrigins).toContain("http://localhost:3001");
  });
});

describe("order ids", () => {
  it("match MC-<5 base32>", () => {
    for (let i = 0; i < 200; i++) expect(newOrderId("maya-cookies")).toMatch(/^MC-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(ORDER_ID_RE.test("MC-7K2Q9")).toBe(true);
    expect(ORDER_ID_RE.test("MC-7K2QI")).toBe(false);
  });
});

describe("webhook signature", () => {
  const payload = JSON.stringify(completedEvent());
  it("accepts a valid signature", () => {
    expect(verifyStripeEvent(Buffer.from(payload), sign(payload), SECRET).id).toBe("evt_1");
  });
  it("rejects tampered body, bad secret, missing header", () => {
    expect(() => verifyStripeEvent(Buffer.from(payload + " "), sign(payload), SECRET)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeEvent(Buffer.from(payload), sign(payload), "whsec_other")).toThrow(WebhookSignatureError);
    expect(() => verifyStripeEvent(Buffer.from(payload), undefined, SECRET)).toThrow(WebhookSignatureError);
  });
  it("HTTP: 400 on bad signature, 200 on good, nothing recorded on bad", async () => {
    const { app, platform } = setup();
    platform.orders.set("MC-AAAAA", { id: "MC-AAAAA", businessId: "maya-cookies", status: "pending_payment", saleDocumentId: 1n, totalCents: 600n, paidCents: 0n, refundedCents: 0n, customerName: "x", channel: "storefront" });
    expect((await post(app, "/webhooks/stripe", payload, { "stripe-signature": "t=1,v1=bad" })).status).toBe(400);
    expect(platform.events.size).toBe(0);
    expect((await post(app, "/webhooks/stripe", payload, { "stripe-signature": sign(payload) })).status).toBe(200);
    expect([...platform.events.keys()].sort()).toEqual(["evt_1", "fee:txn_1"]);
  });
});

describe("event -> reducer mapping", () => {
  it("payment_succeeded uses Stripe's event id; replay is deduped; fee uses balance transaction id", async () => {
    const { platform, gateway } = setup();
    platform.orders.set("MC-AAAAA", { id: "MC-AAAAA", businessId: "maya-cookies", status: "pending_payment", saleDocumentId: 1n, totalCents: 600n, paidCents: 0n, refundedCents: 0n, customerName: "x", channel: "storefront" });
    for (let i = 0; i < 3; i++) await dispatchStripeEvent(completedEvent(), { platform, gateway });
    expect(platform.events.size).toBe(2);
    expect(platform.events.get("evt_1")).toMatchObject({ kind: "payment_succeeded", orderId: "MC-AAAAA", amountCents: 600n, processorRef: "pi_1" });
    expect(platform.events.get("fee:txn_1")).toMatchObject({ kind: "fee", amountCents: 117n, processorRef: "txn_1" });
  });
  it("fee not settled -> charge.updated posts it later with the same id", async () => {
    const { platform, gateway } = setup();
    gateway.fee = null;
    platform.orders.set("MC-AAAAA", { id: "MC-AAAAA", businessId: "maya-cookies", status: "pending_payment", saleDocumentId: 1n, totalCents: 600n, paidCents: 0n, refundedCents: 0n, customerName: "x", channel: "storefront" });
    const r = await dispatchStripeEvent(completedEvent(), { platform, gateway });
    expect(r).toMatchObject({ status: "processed", note: expect.stringContaining("charge.updated") });
    expect(platform.events.size).toBe(1);
    const charge = { id: "evt_2", type: "charge.updated", data: { object: { id: "ch_1", payment_intent: "pi_1", metadata: { orderId: "MC-AAAAA" }, balance_transaction: { id: "txn_9", fee: 99 } } } } as unknown as Stripe.Event;
    await dispatchStripeEvent(charge, { platform, gateway });
    await dispatchStripeEvent(charge, { platform, gateway });
    expect(platform.events.get("fee:txn_9")).toMatchObject({ kind: "fee", amountCents: 99n });
    expect(platform.events.size).toBe(2);
  });
  it("unpaid sessions and foreign sessions are ignored", async () => {
    const { platform, gateway } = setup();
    const unpaid = completedEvent();
    (unpaid.data.object as unknown as { payment_status: string }).payment_status = "unpaid";
    expect((await dispatchStripeEvent(unpaid, { platform, gateway })).status).toBe("ignored");
    expect(platform.events.size).toBe(0);
  });
  it("charge.refunded -> refund_succeeded keyed by refund id", async () => {
    const { platform, gateway } = setup();
    gateway.refundsForCharge = async () => [{ id: "re_7", amountCents: 300n, status: "succeeded", orderId: "MC-AAAAA" }];
    platform.orders.set("MC-AAAAA", { id: "MC-AAAAA", businessId: "maya-cookies", status: "paid", saleDocumentId: 1n, totalCents: 600n, paidCents: 600n, refundedCents: 0n, customerName: "x", channel: "storefront" });
    const ev = { id: "evt_3", type: "charge.refunded", data: { object: { id: "ch_1", metadata: { orderId: "MC-AAAAA" } } } } as unknown as Stripe.Event;
    await dispatchStripeEvent(ev, { platform, gateway });
    await dispatchStripeEvent(ev, { platform, gateway });
    expect([...platform.events.keys()]).toEqual(["refund:re_7"]);
    expect(platform.events.get("refund:re_7")).toMatchObject({ kind: "refund_succeeded", amountCents: 300n, processorRef: "re_7" });
  });
});

describe("checkout", () => {
  it("prices from the platform sale document, not the request; metadata + idempotency key set", async () => {
    const { app, platform, gateway } = setup();
    gateway.mode = "test";
    const res = await post(app, "/checkout", { businessId: "maya-cookies", lines: [{ productId: "choc-chip", qty: 2 }], customerName: "Sam", price: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orderId: "MC-AAAAA", url: "https://checkout.stripe.test/cs_test_1", simulated: false });
    const s = gateway.sessionsCreated[0]!;
    expect(s.lineItems).toEqual([{ name: "Product choc-chip", unitAmountCents: 300n, quantity: 2 }]);
    expect(s.idempotencyKey).toBe(platform.intents[0]!.key);
    expect(s.successUrl).toBe("http://localhost:3002/maya-cookies/order/MC-AAAAA");
    expect(platform.calls).toEqual(["createOrder", "logPaymentIntent", "attachCheckoutSession"]);
  });
  it("surfaces platform refusal messages", async () => {
    const { app, platform } = setup();
    platform.refuseCreateOrder = "below the price floor";
    const res = await post(app, "/checkout", { businessId: "maya-cookies", lines: [{ productId: "x", qty: 1 }], customerName: "Sam" });
    expect(res.status).toBe(422);
    expect((await res.json() as { error: string }).error).toContain("below the price floor");
  });
  it("uses one exact-total line when a discount makes lines not sum to the total", () => {
    const platform = new FakePlatform();
    const sale = { id: 1n, businessId: "b", docType: "sale", status: "posted", externalRef: "o", fields: {}, totalCents: 540n, lines: [{ productId: "a", qty: "2", unitPrice: "3.00" }] };
    const items = lineItemsFromSale({ id: "MC-AAAAA", totalCents: 540n } as never, sale, platform);
    expect(items).toHaveLength(1);
    expect(items[0]!.unitAmountCents).toBe(540n);
  });
  it("simulator mode: simulate=1 url, no Stripe session; simulate-payment uses the same handlers and is idempotent", async () => {
    const { app, platform, gateway } = setup();
    gateway.mode = "simulator";
    gateway.fee = { balanceTransactionId: "sim_bt_MC-AAAAA", feeCents: simulatedFeeCents(600n), simulated: true };
    const res = await post(app, "/checkout", { businessId: "maya-cookies", lines: [{ productId: "a", qty: 2 }], customerName: "Sam" });
    expect((await res.json() as { url: string }).url).toBe("http://localhost:3002/maya-cookies/order/MC-AAAAA?simulate=1");
    expect(gateway.sessionsCreated).toHaveLength(0);
    for (let i = 0; i < 2; i++) expect((await post(app, "/dev/simulate-payment/MC-AAAAA", {})).status).toBe(200);
    expect([...platform.events.keys()].sort()).toEqual(["fee:sim_bt_MC-AAAAA", "sim_evt_MC-AAAAA"]);
    expect(platform.events.get("fee:sim_bt_MC-AAAAA")!.amountCents).toBe(simulatedFeeCents(600n));
  });
  it("simulator mode: /p/:orderId logs the payment intent for an order created outside checkout", async () => {
    const { app, platform, gateway } = setup();
    gateway.mode = "simulator";
    platform.orders.set("MC-BBBBB", { id: "MC-BBBBB", businessId: "maya-cookies", status: "pending_payment", saleDocumentId: 1n, totalCents: 300n, paidCents: 0n, refundedCents: 0n, customerName: "x", channel: "agent" });
    const res = await app.request("/p/MC-BBBBB");
    expect(res.status).toBe(303);
    expect(platform.intents.map((i) => i.orderId)).toEqual(["MC-BBBBB"]);
    await app.request("/p/MC-BBBBB");
    expect(platform.intents).toHaveLength(1);
  });
  it("simulate endpoint is disabled with a real Stripe key", async () => {
    const { app, platform } = setup();
    platform.orders.set("MC-AAAAA", { id: "MC-AAAAA", businessId: "maya-cookies", status: "pending_payment", saleDocumentId: 1n, totalCents: 600n, paidCents: 0n, refundedCents: 0n, customerName: "x", channel: "storefront" });
    expect((await post(app, "/dev/simulate-payment/MC-AAAAA", {})).status).toBe(404);
  });
  it("rejects unknown business", async () => {
    const { platform, gateway } = setup();
    await expect(createCheckout({ businessId: "nope", lines: [{ productId: "a", qty: 1 }], customerName: "x" }, { platform, gateway, sessions: { get: () => undefined, put: () => {} }, storePublicUrl: "http://x", hasStorefront: () => true })).rejects.toBeInstanceOf(CheckoutError);
  });
  it("simulated fee formula", () => {
    expect(simulatedFeeCents(600n)).toBe(47n); // round(17.4c)=17 + 30
    expect(simulatedFeeCents(1000n)).toBe(59n); // 29 + 30
    expect(simulatedFeeCents(0n)).toBe(0n);
  });
});

describe("/auth/owner", () => {
  it("correct PIN mints a one-time grant", async () => {
    const { app, platform } = setup();
    const res = await post(app, "/auth/owner", { pin: "2468" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string };
    expect(body.code.length).toBeGreaterThanOrEqual(20);
    expect(platform.grants).toEqual([{ code: body.code, businessId: "maya-cookies", role: "owner", name: "Owner", ttlSeconds: 120 }]);
  });
  it("wrong PIN is 401 and mints nothing; rate limit trips", async () => {
    const { app, platform } = setup();
    for (let i = 0; i < 3; i++) expect((await post(app, "/auth/owner", { pin: "0000" })).status).toBe(401);
    expect((await post(app, "/auth/owner", { pin: "2468" })).status).toBe(429);
    expect(platform.grants).toHaveLength(0);
  });
  it("refuses entirely when OWNER_PIN unset", async () => {
    const platform = new FakePlatform();
    const app = createApp({ platform, gateway: new FakeGateway(), sessions: { get: () => undefined, put: () => {} }, storePublicUrl: "http://x", corsOrigins: [], webhookSecret: undefined, ownerPin: undefined, hasStorefront: () => true, health: () => ({}) });
    expect((await post(app, "/auth/owner", { pin: "" })).status).toBe(503);
    expect((await post(app, "/auth/owner", { pin: "anything" })).status).toBe(503);
    expect(platform.grants).toHaveLength(0);
  });
  it("pin compare and codes", () => {
    expect(pinMatches("2468", "2468")).toBe(true);
    expect(pinMatches("246", "2468")).toBe(false);
    expect(newGrantCode()).not.toBe(newGrantCode());
  });
});

describe("outbox refunds", () => {
  it("claims, refunds with the row's idempotency key, completes; stale claimed items retry with the same key", async () => {
    const platform = new FakePlatform();
    const gateway = new FakeGateway();
    platform.outbox.push({ id: 5n, businessId: "maya-cookies", kind: "stripe_refund", payloadJson: JSON.stringify({ orderId: "MC-AAAAA", amountCents: 300, paymentIntentId: "pi_1" }), idempotencyKey: "refund-key-5", status: "pending", attempts: 0, claimedAtMs: undefined, resultJson: "" });
    let now = 1_000_000;
    const worker = new OutboxWorker({ platform, executors: [new RefundExecutor(platform, gateway)], staleMs: 60_000, now: () => now });
    expect(await worker.tick()).toEqual(["5"]);
    expect(gateway.refunds[0]).toMatchObject({ paymentIntentId: "pi_1", amountCents: 300n, idempotencyKey: "refund-key-5" });
    expect(platform.outbox[0]!.status).toBe("done");
    expect(platform.events.has("refund:re_1")).toBe(true);
    // simulate a crash: claimed long ago, never completed
    platform.outbox[0]!.status = "claimed";
    platform.outbox[0]!.claimedAtMs = now - 120_000;
    expect(await worker.tick()).toEqual(["5"]);
    expect(gateway.refunds[1]!.idempotencyKey).toBe("refund-key-5");
    expect(platform.events.size).toBe(1);
    // fresh claim is left alone
    platform.outbox[0]!.status = "claimed";
    platform.outbox[0]!.claimedAtMs = now;
    expect(await worker.tick()).toEqual([]);
  });
});
