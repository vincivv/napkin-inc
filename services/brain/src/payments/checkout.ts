// Checkout: the platform creates the order and prices it from the ACTIVE catalog; the brain only
// relays the platform's sale document to Stripe. Request prices are never accepted.
//
//   storefront.createOrder -> system.logPaymentIntent(orderId, key) -> Stripe session (idempotencyKey=key,
//   line items from the sale document) -> system.attachCheckoutSession

import path from "node:path";
import { z } from "zod";
import type { DocumentView, OrderView, PlatformPort } from "../platform";
import { ReducerRefused } from "../stdb";
import { JsonFileStore } from "../store";
import { log } from "../log";
import type { CheckoutSessionInfo, LineItem, ProcessorGateway } from "./gateway";
import { checkoutIdempotencyKey, decimalToCents, newOrderId, parseQty, SIM } from "./ids";

export const CheckoutRequest = z.object({
  businessId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  lines: z
    .array(z.object({ productId: z.string().min(1).max(64), qty: z.number().int().min(1).max(1000) }))
    .min(1)
    .max(50),
  customerName: z.string().trim().min(1).max(60),
  couponCode: z.string().trim().max(32).optional(),
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/** A caller-facing failure with an HTTP status. */
export class CheckoutError extends Error {
  override name = "CheckoutError";
  constructor(
    readonly status: 400 | 404 | 409 | 422 | 502 | 503,
    message: string,
  ) {
    super(message);
  }
}

export interface SessionRecord {
  orderId: string;
  generation: number;
  idempotencyKey: string;
  intentLogged: boolean;
  sessionId?: string;
  url?: string;
  expiresAt?: number;
}

/** orderId -> latest checkout session (payment_intent_log is private in the platform, so we keep our copy). */
export class SessionStore {
  private readonly store: JsonFileStore<Record<string, SessionRecord>>;
  constructor(dataDir: string) {
    this.store = new JsonFileStore(path.join(dataDir, "sessions.json"), () => ({}));
  }
  get(orderId: string): SessionRecord | undefined {
    return this.store.read()[orderId];
  }
  put(rec: SessionRecord): void {
    this.store.update((all) => {
      all[rec.orderId] = rec;
    });
  }
}

export interface CheckoutDeps {
  platform: PlatformPort;
  gateway: ProcessorGateway;
  sessions: Pick<SessionStore, "get" | "put">;
  storePublicUrl: string;
  /** storefront identity connected for this business? */
  hasStorefront: (businessId: string) => boolean;
  newOrderId?: (businessId: string) => string;
}

export const orderPageUrl = (storePublicUrl: string, businessId: string, orderId: string) =>
  `${storePublicUrl}/${encodeURIComponent(businessId)}/order/${encodeURIComponent(orderId)}`;

/**
 * Stripe line items from the platform's sale document. When the per-line sum does not equal the
 * platform's order total (a discount or tax applied), a single line for the exact total is used, so
 * Stripe always charges precisely what the platform computed.
 */
export function lineItemsFromSale(order: OrderView, sale: DocumentView, platform: Pick<PlatformPort, "catalogEntry">): LineItem[] {
  if (order.totalCents <= 0n) throw new CheckoutError(422, `order ${order.id} has a non-positive total`);
  const parsed = sale.lines.map((l, i) => {
    const productId = l.productId;
    if (!productId || l.qty === undefined || l.unitPrice === undefined) {
      throw new CheckoutError(502, `sale document ${sale.id} line ${i} is missing productId/qty/unitPrice`);
    }
    const name = platform.catalogEntry(order.businessId, productId)?.name ?? productId;
    return { productId, name, qty: parseQty(l.qty), unitCents: decimalToCents(l.unitPrice) };
  });
  if (parsed.length === 0) throw new CheckoutError(502, `sale document ${sale.id} has no lines`);
  const sum = parsed.reduce((s, l) => s + l.qty * l.unitCents, 0n);
  if (sum === order.totalCents) {
    return parsed.map((l) => ({ name: l.name, unitAmountCents: l.unitCents, quantity: Number(l.qty) }));
  }
  return [
    {
      name: `Order ${order.id}`,
      description: parsed.map((l) => `${l.qty}× ${l.name}`).join(", ") + " (discount/tax applied)",
      unitAmountCents: order.totalCents,
      quantity: 1,
    },
  ];
}

async function saleFor(order: OrderView, platform: PlatformPort): Promise<DocumentView> {
  if (order.saleDocumentId === 0n) throw new CheckoutError(502, `order ${order.id} has no sale document`);
  const sale = await platform.awaitDocument(order.saleDocumentId);
  if (!sale) throw new CheckoutError(502, `sale document ${order.saleDocumentId} for ${order.id} not visible`);
  return sale;
}

async function openStripeSession(order: OrderView, rec: SessionRecord, deps: CheckoutDeps): Promise<CheckoutSessionInfo> {
  const sale = await saleFor(order, deps.platform);
  const session = await deps.gateway.createCheckoutSession({
    orderId: order.id,
    businessId: order.businessId,
    lineItems: lineItemsFromSale(order, sale, deps.platform),
    successUrl: orderPageUrl(deps.storePublicUrl, order.businessId, order.id),
    cancelUrl: `${deps.storePublicUrl}/${encodeURIComponent(order.businessId)}`,
    idempotencyKey: rec.idempotencyKey,
  });
  deps.sessions.put({ ...rec, sessionId: session.id, url: session.url, expiresAt: session.expiresAt });
  await deps.platform.attachCheckoutSession(order.id, session.id, session.url);
  return session;
}

async function logIntent(orderId: string, deps: CheckoutDeps, tolerateExisting: boolean): Promise<SessionRecord> {
  const rec: SessionRecord = { orderId, generation: 0, idempotencyKey: checkoutIdempotencyKey(orderId), intentLogged: false };
  try {
    await deps.platform.logPaymentIntent(orderId, rec.idempotencyKey);
  } catch (e) {
    // The key is deterministic per order, so "already logged" for the same order is the same intent.
    if (!(tolerateExisting && e instanceof ReducerRefused && /already|exist|duplicate/i.test(e.message))) throw e;
    log.info("checkout", `payment intent for ${orderId} already logged`);
  }
  rec.intentLogged = true;
  deps.sessions.put(rec);
  return rec;
}

/** Which sales channel the order is recorded under. Not part of the HTTP request: only server code picks it. */
export interface CheckoutOptions {
  channel?: "storefront" | "phone";
}

export async function createCheckout(req: CheckoutRequest, deps: CheckoutDeps, opts: CheckoutOptions = {}): Promise<{ orderId: string; url: string; simulated: boolean }> {
  const biz = deps.platform.business(req.businessId);
  if (!biz) throw new CheckoutError(404, `unknown business ${req.businessId}`);
  if (biz.activeConfigId === 0n) throw new CheckoutError(409, `business ${req.businessId} has no active configuration`);
  if (!deps.hasStorefront(req.businessId)) throw new CheckoutError(503, `storefront for ${req.businessId} is not bootstrapped`);

  const mint = deps.newOrderId ?? newOrderId;
  let orderId = mint(req.businessId);
  for (let i = 0; i < 5 && deps.platform.order(orderId); i++) orderId = mint(req.businessId);
  if (deps.platform.order(orderId)) throw new CheckoutError(503, "could not allocate an order id");

  // The platform prices the order from the active catalog and refuses below-floor/oversold orders.
  await deps.platform.createOrder({
    businessId: req.businessId,
    orderId,
    customerName: req.customerName,
    channel: opts.channel ?? "storefront",
    discountRate: "0",
    couponCode: req.couponCode ?? "",
    lines: req.lines,
  });
  const order = await deps.platform.awaitOrder(orderId);
  if (!order) throw new CheckoutError(502, `order ${orderId} was created but is not visible to the brain`);

  const rec = await logIntent(orderId, deps, false);

  if (deps.gateway.mode === "simulator") {
    const url = `${orderPageUrl(deps.storePublicUrl, order.businessId, orderId)}?simulate=1`;
    deps.sessions.put({ ...rec, sessionId: SIM.sessionId(orderId), url });
    await deps.platform.attachCheckoutSession(orderId, SIM.sessionId(orderId), url);
    return { orderId, url, simulated: true };
  }
  const session = await openStripeSession(order, rec, deps);
  return { orderId, url: session.url, simulated: false };
}

/**
 * For /p/:orderId (SMS links): the existing unexpired session, or a new one. A replacement session
 * after expiry uses the next generation's idempotency key; the order can still be paid only once
 * because the platform dedupes payment events and checks the amount against the order.
 */
export async function resolvePaymentLink(orderId: string, deps: CheckoutDeps, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const order = deps.platform.order(orderId);
  if (!order) throw new CheckoutError(404, `unknown order ${orderId}`);
  const orderPage = orderPageUrl(deps.storePublicUrl, order.businessId, orderId);
  if (order.status !== "pending_payment") return orderPage;
  if (deps.gateway.mode === "simulator") return `${orderPage}?simulate=1`;

  let rec = deps.sessions.get(orderId);
  if (!rec || !rec.intentLogged) rec = await logIntent(orderId, deps, true);
  if (rec.sessionId) {
    const s = await deps.gateway.retrieveCheckoutSession(rec.sessionId);
    if (s.status === "complete") return orderPage;
    if (s.status === "open" && s.expiresAt > nowSeconds + 120) return s.url;
    rec = { orderId, generation: rec.generation + 1, idempotencyKey: checkoutIdempotencyKey(orderId, rec.generation + 1), intentLogged: true };
  }
  return (await openStripeSession(order, rec, deps)).url;
}
