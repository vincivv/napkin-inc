// The phone line's webhook tools (Cartesia Managed Agent -> POST /phone/tools/<name>). All logic lives here;
// the voice agent only talks. One shared number serves every live shop: the caller says the shop's 4-digit
// code (or, failing that, its name), find_shop ties the call (its conversation id) to that shop server-side,
// and every other tool then acts for that shop only. Two modes:
//   customer: find_shop, menu_lookup, order_status (own orders only), place_order, escalate, verify_owner
//   owner:    owner_report, owner_instruction, available ONLY when this conversation was verified server-side by
//             verify_owner (caller ID == OWNER_PHONE and PIN == OWNER_PIN). No parameter can grant owner mode.
// Money: totals come from the platform's pricing (createOrder prices from the active catalog). Policy: owner
// instructions are only QUEUED (queueOwnerStatement); the owner confirms in the app (invariant 6).

import { z } from "zod";
import { log } from "../log";
import type { M2Deps } from "../m2deps";
import { HttpError } from "../m2deps";
import { CheckoutError, createCheckout, type CheckoutDeps } from "../payments/checkout";
import { decimalToCents } from "../payments/ids";
import { submitOwnerStatement } from "../questions/routes";
import { PlatformUnavailable, ReducerRefused } from "../stdb";
import type { PhonePlatform } from "./platform";
import type { ConversationShops, FailureLimiter, OwnerSessions, PhoneCodes, PhoneOrderStore } from "./state";
import { constantTimeEqual, formatCents, localDay, maskPhone, normalizeE164, normalizeOrderId, normalizePin, sha256 } from "./util";

export interface PhoneDeps {
  platform: PhonePlatform;
  checkout: CheckoutDeps;
  /** M2 deps (spec store + LLM + platform) for owner_instruction; undefined disables it. */
  m2: M2Deps | undefined;
  /** How the brain delivers texts: "simulator" means NO text is ever sent (the agent must say so). */
  smsMode: "twilio" | "simulator";
  orders: PhoneOrderStore;
  sessions: OwnerSessions;
  failures: FailureLimiter;
  /** Which shop each call is talking to (find_shop). */
  shops: ConversationShops;
  /** Each shop's 4-digit phone code. */
  codes: PhoneCodes;
  /** The business OWNER_PHONE / OWNER_PIN belong to: owner mode exists for this shop only. */
  businessId: string;
  /** Raw OWNER_PHONE / OWNER_PIN from the environment. Either missing = owner mode disabled for everyone. */
  ownerPhone: string | undefined;
  ownerPin: string | undefined;
  /** Public base URL of the brain (the tunnel); pay links are `${publicBrainUrl}/p/<orderId>`. */
  publicBrainUrl: string;
  now?: () => number;
  /** max escalations per conversation (inbox spam guard) */
  maxEscalationsPerConversation?: number;
}

export interface ToolResult {
  status: 200 | 400 | 404 | 503;
  body: Record<string, unknown>;
}

// ---------- input schemas (what Cartesia sends) ----------

const Base = z.object({
  /** Normally absent: the shop comes from find_shop. A direct value must name a live shop, and a call's find_shop binding wins. */
  business_id: z.string().regex(/^[a-z0-9-]{1,64}$/).optional(),
  /** {{system__caller_id}}; empty in browser previews and for hidden numbers */
  caller_id: z.string().max(40).default(""),
  /** {{system__conversation_id}} */
  conversation_id: z.string().trim().min(1).max(128),
});

export const TOOL_INPUTS = {
  /** at least one of the two; the code wins when both are given */
  find_shop: Base.extend({ shop_code: z.string().trim().max(40).optional(), shop_name: z.string().trim().max(80).optional() }),
  menu_lookup: Base,
  order_status: Base.extend({ order_id: z.string().trim().min(1).max(40) }),
  place_order: Base.extend({
    customer_name: z.string().trim().min(1).max(40),
    items: z
      .array(z.object({ product_id: z.string().trim().min(1).max(64), qty: z.number().int().min(1).max(50) }))
      .min(1)
      .max(20),
  }),
  escalate: Base.extend({
    summary: z.string().trim().min(1).max(1000),
    reason: z.enum(["question", "complaint", "refund", "order_problem", "other"]).default("other"),
  }),
  verify_owner: Base.extend({ pin: z.string().min(1).max(64) }),
  owner_report: Base,
  owner_instruction: Base.extend({ instruction: z.string().trim().min(1).max(1000) }),
} as const;

export type ToolName = keyof typeof TOOL_INPUTS;
export const TOOL_NAMES = Object.keys(TOOL_INPUTS) as ToolName[];
export const OWNER_TOOLS: readonly ToolName[] = ["owner_report", "owner_instruction"];
export const CUSTOMER_TOOLS: readonly ToolName[] = TOOL_NAMES.filter((t) => !OWNER_TOOLS.includes(t));

/** A tool's input once the shop is resolved: business_id is always set. */
type In<T extends ToolName> = z.infer<(typeof TOOL_INPUTS)[T]> & { business_id: string };

// ---------- catalog ----------

interface Product {
  productId: string;
  name: string;
  kind: string;
  addon: boolean;
  priceCents: bigint;
  description: string;
  stockItem: string;
  stockUnits: bigint;
}

function toBigInt(v: string | undefined): bigint {
  if (!v || !/^\d+$/.test(v.trim())) return 0n;
  return BigInt(v.trim());
}

function products(p: PhonePlatform, businessId: string): Product[] {
  const out: Product[] = [];
  for (const r of p.catalog(businessId)) {
    if (r.data.price === undefined) continue; // stock items etc. are not sellable
    let priceCents: bigint;
    try {
      priceCents = decimalToCents(r.data.price);
    } catch {
      continue;
    }
    out.push({
      productId: r.entryId,
      name: r.data.name || r.entryId,
      kind: r.data.kind ?? "",
      addon: r.data.kind === "addon",
      priceCents,
      description: r.data.description ?? "",
      stockItem: r.data.stockItem ?? "",
      stockUnits: toBigInt(r.data.stockUnits),
    });
  }
  return out;
}

/** stock register balances -> stockItem -> qty (dimsKey "item=<stockItem>"), same reading as the storefront. */
function stockMap(p: PhonePlatform, businessId: string): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const b of p.balances(businessId)) {
    if (b.registerId !== "stock") continue;
    const match = /^item=(.+)$/.exec(b.dimsKey);
    if (match?.[1]) m.set(match[1], b.qty);
  }
  return m;
}

const tracks = (x: Product) => x.stockItem !== "" && x.stockUnits > 0n;
function available(x: Product, stock: Map<string, bigint>): bigint | null {
  if (!tracks(x)) return null;
  const q = stock.get(x.stockItem) ?? 0n;
  return q <= 0n ? 0n : q / x.stockUnits;
}

// ---------- helpers ----------

const ok = (body: Record<string, unknown>): ToolResult => ({ status: 200, body: { ok: true, ...body } });
const refuse = (say: string, extra: Record<string, unknown> = {}): ToolResult => ({ status: 200, body: { ok: false, ...extra, say } });

const ORDER_PRIVACY_SAY =
  "I can only share order details with the phone number that placed the order. Please check the text message with your payment link, or the order page.";

const STATUS_TEXT: Record<string, string> = {
  pending_payment: "waiting for payment",
  paid: "paid and being prepared",
  ready: "ready for pickup",
  picked_up: "picked up",
  refunded: "refunded",
  partially_refunded: "partially refunded",
  cancelled: "cancelled",
};

function ownerConfig(d: PhoneDeps): { phone: string; pin: string } | undefined {
  const phone = normalizeE164(d.ownerPhone);
  if (!phone || !d.ownerPin) return undefined;
  return { phone, pin: d.ownerPin };
}

/** Owner mode = a live server-side session for this conversation + caller + business AND the caller is still OWNER_PHONE. */
function isOwner(d: PhoneDeps, input: { business_id: string; caller_id: string; conversation_id: string }): boolean {
  const cfg = ownerConfig(d);
  const caller = normalizeE164(input.caller_id);
  if (!cfg || !caller || caller !== cfg.phone) return false;
  return d.sessions.find(input.conversation_id, caller, input.business_id) !== undefined;
}

const OWNER_REQUIRED = () =>
  refuse("That is only available to the owner, after they verify on this call with their PIN.", { owner_required: true });

type SmsState = "sent" | "simulated_not_sent" | "failed" | "queued";

/** "https://napkin-store.vercel.app" -> "napkin-store.vercel.app/pay": the pay page, short enough to say aloud. */
export const spokenPayPage = (storePublicUrl: string) => `${storePublicUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/pay`;

/** What the agent may say about the pay-link text. "sent" only when the platform row is done with a real send. */
function smsSay(state: SmsState, orderId: string, storePublicUrl: string): { sms: SmsState; say: string } {
  const payByNumber = `To pay, go to ${spokenPayPage(storePublicUrl)} and enter order number ${orderId}.`;
  if (state === "sent") return { sms: "sent", say: "I've texted a payment link to the number you're calling from." };
  if (state === "simulated_not_sent") return { sms: "simulated_not_sent", say: `Text messages are not set up on this line yet, so no text was sent. ${payByNumber}` };
  if (state === "failed") return { sms: "failed", say: `I couldn't text the payment link to this number. ${payByNumber}` };
  return { sms: "queued", say: `The payment link text is queued and should arrive shortly. If it doesn't, ${payByNumber.charAt(0).toLowerCase()}${payByNumber.slice(1)}` };
}

function smsState(d: PhoneDeps, key: string): SmsState {
  if (d.smsMode === "simulator") return "simulated_not_sent"; // the worker only logs it; never claim a send
  const row = d.platform.outboxRow(key);
  if (row?.status === "failed") return "failed";
  if (row?.status === "done") {
    try {
      const r = JSON.parse(row.resultJson) as { status?: string };
      if (r.status === "sent") return "sent";
    } catch {
      /* fall through to queued */
    }
  }
  return "queued";
}

// ---------- shops ----------

/** "Maya's Cookies!" -> "mayas cookie": lowercase plain words, no apostrophes, no plural s, no filler words. */
function shopWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w && !["the", "a", "an", "shop", "store", "please", "calling"].includes(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

function bigrams(s: string): string[] {
  const t = s.replace(/ /g, "");
  return Array.from({ length: Math.max(0, t.length - 1) }, (_, i) => t.slice(i, i + 2));
}

/** 0..1: word overlap (or a partial name) or letter-pair overlap, whichever is higher (speech-to-text misspells names). */
export function shopMatchScore(said: string, shop: { id: string; name: string }): number {
  const a = shopWords(said);
  let best = 0;
  for (const b of [shopWords(shop.name), shopWords(shop.id.replace(/-/g, " "))]) {
    if (a.length === 0 || b.length === 0) continue;
    const A = new Set(a);
    const B = new Set(b);
    const shared = [...A].filter((w) => B.has(w)).length;
    // every word said is in the name ("Maya's" for "Maya's Cookies"): a good but not certain match
    const words = Math.max(shared / new Set([...A, ...B]).size, shared === A.size ? 0.75 : 0);
    const x = bigrams(a.join(" "));
    const y = bigrams(b.join(" "));
    const pool = [...y];
    let common = 0;
    for (const g of x) {
      const i = pool.indexOf(g);
      if (i >= 0) (common++, pool.splice(i, 1));
    }
    const letters = x.length + y.length ? (2 * common) / (x.length + y.length) : 0;
    best = Math.max(best, words, letters);
  }
  return best;
}

const MATCH_AT = 0.6;

function liveShop(d: PhoneDeps, id: string): { id: string; name: string } | undefined {
  return d.platform.shops().find((x) => x.id === id);
}

const DIGIT_WORDS: Record<string, string> = { zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/** "four two one seven", "42 17", "4-2-1-7" -> "4217"; undefined unless exactly 4 digits. */
export function spokenCode(said: string): string | undefined {
  const digits = said
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((w) => (/^\d+$/.test(w) ? w : (DIGIT_WORDS[w] ?? "")))
    .join("");
  return /^\d{4}$/.test(digits) ? digits : undefined;
}

async function findShop(d: PhoneDeps, input: In<"find_shop">): Promise<ToolResult> {
  if (input.shop_code) {
    const code = spokenCode(input.shop_code);
    if (!code) return refuse("A shop code has 4 digits. Ask the caller to say it again, one digit at a time.", { found: false, reason: "bad_code" });
    const id = d.codes.businessFor(code);
    const shop = id ? liveShop(d, id) : undefined;
    if (!shop) return refuse(`No shop on this line has the code ${code.split("").join(" ")}. Ask the caller to check the code on the shop's page, or for the shop's name.`, { found: false, reason: "unknown_code" });
    d.shops.bind(input.conversation_id, shop.id);
    log.info("phone", `${input.conversation_id} is calling ${shop.id} (code ${code})`);
    return ok({ shop_name: shop.name, matched_by: "code", say: `You're through to ${shop.name}. How can I help?` });
  }
  const said = input.shop_name;
  if (!said) return refuse("Ask the caller for the shop's 4-digit code, or its name if they don't have the code.", { found: false, reason: "nothing_said" });
  const shops = d.platform.shops();
  const ranked = shops.map((x) => ({ x, score: shopMatchScore(said, x) })).sort((p, q) => q.score - p.score);
  const top = ranked[0];
  const names = shops.map((x) => x.name).sort((p, q) => p.localeCompare(q));
  const someNames = names.slice(0, 6).join(", ");
  if (!top || top.score < MATCH_AT) {
    return refuse(
      shops.length === 0
        ? "No shops are taking phone orders right now."
        : `I couldn't find a shop called ${input.shop_name} on this line. Shops here include ${someNames}. Ask the caller for the shop's 4-digit code, or to say the name again.`,
      { found: false, shops: names.slice(0, 6) },
    );
  }
  const close = ranked.filter((r) => r.score >= MATCH_AT && top.score - r.score < 0.1);
  if (close.length > 1) {
    const which = close.slice(0, 4).map((r) => r.x.name);
    return refuse(`That could be ${which.join(" or ")}. Ask the caller which one.`, { found: false, ambiguous: which });
  }
  d.shops.bind(input.conversation_id, top.x.id);
  log.info("phone", `${input.conversation_id} is calling ${top.x.id} ("${input.shop_name}")`);
  return ok({ shop_name: top.x.name, matched_by: "name", say: `That's ${top.x.name}. Check with the caller that this is the shop they mean, then ask how you can help.` });
}

// ---------- tools ----------

async function menuLookup(d: PhoneDeps, input: In<"menu_lookup">): Promise<ToolResult> {
  const list = products(d.platform, input.business_id);
  if (list.length === 0) return refuse("The menu isn't available right now.", { items: [] });
  const stock = stockMap(d.platform, input.business_id);
  return ok({
    items: list.map((x) => {
      const n = available(x, stock);
      return {
        product_id: x.productId,
        name: x.name,
        price: formatCents(x.priceCents),
        add_on: x.addon,
        description: x.description,
        available: n === null ? "not limited" : n.toString(),
        in_stock: n === null || n > 0n,
      };
    }),
    say: "Prices and stock are live from the shop. Use product_id values when placing an order.",
  });
}

async function orderStatus(d: PhoneDeps, input: In<"order_status">): Promise<ToolResult> {
  const owner = isOwner(d, input);
  const id = normalizeOrderId(input.order_id);
  const order = id ? d.platform.order(id) : undefined;
  if (!id || !order || order.businessId !== input.business_id) {
    return owner ? refuse(`I can't find an order with id ${input.order_id}.`) : refuse(ORDER_PRIVACY_SAY, { private: true });
  }
  const status = STATUS_TEXT[order.status] ?? order.status;
  if (owner) {
    return ok({
      mode: "owner",
      order_id: order.id,
      status: order.status,
      status_text: status,
      total: formatCents(order.totalCents),
      paid: formatCents(order.paidCents),
      refunded: formatCents(order.refundedCents),
      customer_first_name: order.customerName,
      channel: order.channel,
      say: `Order ${order.id} is ${status}. Total ${formatCents(order.totalCents)}.`,
    });
  }
  const caller = normalizeE164(input.caller_id);
  const rec = d.orders.get(order.id);
  const mine = Boolean(caller && rec && rec.businessId === input.business_id && constantTimeEqual(rec.callerId, caller));
  if (!mine) return refuse(ORDER_PRIVACY_SAY, { private: true });
  return ok({
    mode: "customer",
    order_id: order.id,
    status: order.status,
    status_text: status,
    total: formatCents(order.totalCents),
    say: `Your order ${order.id} is ${status}. The total is ${formatCents(order.totalCents)}.`,
  });
}

const placeInflight = new WeakMap<PhoneDeps, Map<string, Promise<ToolResult>>>();

async function placeOrder(d: PhoneDeps, input: In<"place_order">): Promise<ToolResult> {
  const caller = normalizeE164(input.caller_id);
  if (!caller) {
    return refuse("I can't place a phone order without a caller ID, because the payment link is texted to the number you're calling from. You can order on the website instead.", {
      reason: "no_caller_id",
    });
  }
  // Validate lines against the LIVE catalog (the platform re-checks everything).
  const catalog = new Map(products(d.platform, input.business_id).map((x) => [x.productId, x]));
  if (catalog.size === 0) return refuse("The menu isn't available right now, so I can't place an order.");
  const merged = new Map<string, number>();
  for (const it of input.items) merged.set(it.product_id, (merged.get(it.product_id) ?? 0) + it.qty);
  const unknown = [...merged.keys()].filter((k) => !catalog.has(k));
  if (unknown.length) {
    return refuse(`I couldn't find ${unknown.join(", ")} on the menu. Use menu_lookup for the product ids.`, { unknown_products: unknown, valid_product_ids: [...catalog.keys()] });
  }
  if ([...merged.values()].some((q) => q > 50)) return refuse("That's more than I can take on one phone order (50 of one item).");
  const lines = [...merged.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([productId, qty]) => ({ productId, qty }));

  // Friendly stock pre-check (UX only; createOrder enforces invariant 3).
  const stock = stockMap(d.platform, input.business_id);
  const need = new Map<string, bigint>();
  for (const l of lines) {
    const p = catalog.get(l.productId)!;
    if (tracks(p)) need.set(p.stockItem, (need.get(p.stockItem) ?? 0n) + BigInt(l.qty) * p.stockUnits);
  }
  for (const [item, units] of need) {
    if ((stock.get(item) ?? 0n) < units) return refuse("Sorry, we don't have enough in stock for that order right now.", { reason: "out_of_stock" });
  }

  // Idempotent per conversation + caller + exact cart: a retried tool call returns the same order and never re-texts.
  const key = sha256(JSON.stringify([input.business_id, input.conversation_id, caller, input.customer_name.toLowerCase(), lines]));
  let inflight = placeInflight.get(d);
  if (!inflight) placeInflight.set(d, (inflight = new Map()));
  const running = inflight.get(key);
  if (running) return running;
  const p = placeOnce(d, input, caller, lines, key, catalog).finally(() => inflight!.delete(key));
  inflight.set(key, p);
  return p;
}

async function placeOnce(
  d: PhoneDeps,
  input: In<"place_order">,
  caller: string,
  lines: { productId: string; qty: number }[],
  key: string,
  catalog: Map<string, Product>,
): Promise<ToolResult> {
  let orderId = d.orders.placement(key);
  const duplicate = Boolean(orderId);
  if (!orderId) {
    try {
      const r = await createCheckout({ businessId: input.business_id, lines, customerName: input.customer_name }, d.checkout, { channel: "phone" });
      orderId = r.orderId;
    } catch (e) {
      if (e instanceof ReducerRefused || e instanceof CheckoutError) {
        log.warn("phone", `place_order refused for ${maskPhone(caller)}: ${e.message}`);
        if (/invariant 3|stock/i.test(e.message)) return refuse("Sorry, we don't have enough in stock for that order right now.", { reason: "out_of_stock" });
        return refuse("The shop couldn't accept that order right now.", { reason: "refused_by_shop" });
      }
      throw e;
    }
    d.orders.record({ orderId, businessId: input.business_id, callerId: caller, conversationId: input.conversation_id, createdAt: new Date((d.now ?? Date.now)()).toISOString() }, key);
  }
  const order = d.checkout.platform.order(orderId);
  if (!order) throw new PlatformUnavailable(`order ${orderId} is not visible yet`);
  const total = formatCents(order.totalCents); // deterministic platform pricing, never the model's arithmetic

  const smsKey = `paylink:${orderId}`;
  const link = `${d.publicBrainUrl}/p/${encodeURIComponent(orderId)}`;
  let state: SmsState;
  try {
    // Always the CALLER ID on record for this order: never a number spoken in the conversation. The platform row
    // is created once per key (enqueueOutbox is idempotent), so a retried place_order never queues a second text.
    await d.platform.enqueueOutbox({
      businessId: input.business_id,
      kind: "sms",
      payloadJson: JSON.stringify({ to: caller, body: `Order ${orderId}, total ${total}. Pay here: ${link}`, orderId }),
      idempotencyKey: smsKey,
    });
    state = smsState(d, smsKey);
  } catch (e) {
    if (!(e instanceof ReducerRefused)) throw e;
    log.error("phone", `enqueueOutbox ${smsKey} refused: ${e.message}`);
    state = "failed";
  }
  const s = smsSay(state, orderId, d.checkout.storePublicUrl);
  log.info("phone", `place_order ${orderId} ${total} for ${maskPhone(caller)} (${input.conversation_id})${duplicate ? " [retry: same order]" : ""}, sms ${s.sms}`);
  return ok({
    order_id: orderId,
    total,
    total_cents: order.totalCents.toString(),
    items: lines.map((l) => ({ name: catalog.get(l.productId)?.name ?? l.productId, qty: l.qty })),
    sms: s.sms,
    duplicate,
    say: `Your order number is ${orderId} and the total is ${total}. ${s.say}`,
  });
}

const escalations = new WeakMap<PhoneDeps, Map<string, number>>();

async function escalate(d: PhoneDeps, input: In<"escalate">): Promise<ToolResult> {
  let counts = escalations.get(d);
  if (!counts) escalations.set(d, (counts = new Map()));
  const n = counts.get(input.conversation_id) ?? 0;
  if (n >= (d.maxEscalationsPerConversation ?? 3)) return refuse("I've already passed this call to the owner; they'll follow up.", { reason: "already_escalated" });
  const caller = normalizeE164(input.caller_id);
  await d.platform.openInbox({
    businessId: input.business_id,
    question: `Phone call (${input.reason}): ${input.summary.slice(0, 500)}`,
    contextJson: JSON.stringify({
      channel: "phone",
      conversationId: input.conversation_id,
      caller: maskPhone(caller),
      reason: input.reason,
      untrusted: true,
      note: "Summary written by the phone agent from the caller's words. Not verified; it changes nothing by itself.",
    }),
    documentRef: `phone:${input.conversation_id}`,
  });
  counts.set(input.conversation_id, n + 1);
  log.info("phone", `escalated ${input.conversation_id} (${input.reason}) from ${maskPhone(caller)}`);
  return ok({ escalated: true, say: "I've passed this to the owner. They'll follow up with you." });
}

async function verifyOwner(d: PhoneDeps, input: In<"verify_owner">): Promise<ToolResult> {
  const cfg = ownerConfig(d);
  if (!cfg || input.business_id !== d.businessId) {
    return refuse("Owner mode isn't set up on this phone line, so I can't verify anyone as the owner.", { owner_mode: "disabled" });
  }
  const caller = normalizeE164(input.caller_id);
  const keys = [`conv:${input.conversation_id}`, `caller:${caller ?? "unknown"}`];
  const locked = Math.max(...keys.map((k) => d.failures.lockedFor(k)));
  if (locked > 0) {
    log.warn("phone", `verify_owner locked for ${input.conversation_id} / ${maskPhone(caller)}`);
    return refuse(`Too many failed attempts. Owner verification is locked; try again in about ${Math.ceil(locked / 60)} minutes.`, { locked: true, retry_after_seconds: locked });
  }
  // Both comparisons always run (constant time); the reply never says which one failed.
  const callerOk = constantTimeEqual(caller ?? "", cfg.phone) && caller !== undefined;
  const pinOk = constantTimeEqual(normalizePin(input.pin), cfg.pin);
  if (callerOk && pinOk) {
    d.sessions.grant(input.conversation_id, caller!, input.business_id);
    for (const k of keys) d.failures.clear(k);
    log.info("phone", `owner verified for conversation ${input.conversation_id}`);
    return ok({ verified: true, say: "Thanks, you're verified as the owner for this call." });
  }
  for (const k of keys) d.failures.fail(k);
  const lockedNow = keys.some((k) => d.failures.lockedFor(k) > 0);
  log.warn("phone", `verify_owner failed for ${input.conversation_id} from ${maskPhone(caller)}`);
  return refuse(lockedNow ? "I couldn't verify you as the owner, and verification is now locked for a while." : "I couldn't verify you as the owner.", { verified: false, locked: lockedNow });
}

async function ownerReport(d: PhoneDeps, input: In<"owner_report">): Promise<ToolResult> {
  if (!isOwner(d, input)) return OWNER_REQUIRED();
  const now = (d.now ?? Date.now)();
  const { day, timeZone } = localDay(now, d.platform.timezone(input.business_id) ?? "UTC");
  const isToday = (ms: number | undefined) => ms !== undefined && localDay(ms, timeZone).day === day;
  const orders = d.platform.orders(input.business_id);
  const created = orders.filter((o) => isToday(o.createdAtMs));
  const paid = orders.filter((o) => isToday(o.paidAtMs));
  const gross = paid.reduce((s, o) => s + o.paidCents, 0n);
  const refunded = paid.reduce((s, o) => s + o.refundedCents, 0n);
  const stock = stockMap(d.platform, input.business_id);
  const names = new Map(d.platform.catalog(input.business_id).filter((r) => r.data.price === undefined).map((r) => [r.entryId, r.data.name || r.entryId]));
  const stockList = [...stock.entries()].map(([item, qty]) => ({ item: names.get(item) ?? item, qty: qty.toString() }));
  const openInbox = d.platform.openInboxCount(input.business_id);
  const queued = d.m2?.platform?.ownerStatements(input.business_id).filter((s) => s.status === "queued").length;
  return ok({
    mode: "owner",
    day,
    time_zone: timeZone,
    orders_today: created.length,
    orders_by_channel: Object.fromEntries(["storefront", "phone", "agent"].map((c) => [c, created.filter((o) => o.channel === c).length])),
    awaiting_payment: created.filter((o) => o.status === "pending_payment").length,
    paid_orders_today: paid.length,
    sales_today: formatCents(gross),
    refunded_on_todays_sales: formatCents(refunded),
    net_sales_today: formatCents(gross - refunded),
    stock: stockList,
    open_inbox_items: openInbox,
    ...(queued !== undefined ? { statements_waiting_for_confirmation: queued } : {}),
    say: `Today (${day}): ${paid.length} paid orders, ${formatCents(gross - refunded)} in sales after refunds. ${openInbox} open inbox item${openInbox === 1 ? "" : "s"}.`,
  });
}

async function ownerInstruction(d: PhoneDeps, input: In<"owner_instruction">): Promise<ToolResult> {
  if (!isOwner(d, input)) return OWNER_REQUIRED();
  if (!d.m2) return refuse("I can't take instructions on the phone right now. Please use the Napkin app.", { reason: "unavailable" });
  try {
    const r = await submitOwnerStatement(d.m2, input.business_id, input.instruction, "phone");
    return ok({
      queued: true,
      applied: false,
      statement_id: r.statementId,
      changes: r.diff.changes.map((c) => ({ field: c.label, from: c.beforeText, to: c.afterText })),
      not_understood: r.diff.unparsed,
      ...(r.diff.note ? { note: r.diff.note } : {}),
      say: "Got it. I've queued that change; nothing changes until you confirm it in the Napkin app Inbox.",
    });
  } catch (e) {
    if (e instanceof HttpError) {
      log.warn("phone", `owner_instruction not queued: ${e.message}`);
      return refuse("I couldn't queue that instruction right now, so nothing changed. Please use the Napkin app.", { reason: e.message });
    }
    throw e;
  }
}

const HANDLERS: { [K in ToolName]: (d: PhoneDeps, input: In<K>) => Promise<ToolResult> } = {
  find_shop: findShop,
  menu_lookup: menuLookup,
  order_status: orderStatus,
  place_order: placeOrder,
  escalate,
  verify_owner: verifyOwner,
  owner_report: ownerReport,
  owner_instruction: ownerInstruction,
};

/** Validate and run one tool. The caller has already checked the bearer secret. */
export async function runTool(d: PhoneDeps, name: string, raw: unknown): Promise<ToolResult> {
  if (!(name in TOOL_INPUTS)) return { status: 404, body: { ok: false, error: `unknown tool ${name}` } };
  const tool = name as ToolName;
  const parsed = TOOL_INPUTS[tool].safeParse(raw);
  if (!parsed.success) {
    return { status: 400, body: { ok: false, error: "invalid parameters", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) } };
  }
  try {
    await d.platform.ready();
    const run = (businessId: string) => (HANDLERS[tool] as (d: PhoneDeps, i: unknown) => Promise<ToolResult>)(d, { ...parsed.data, business_id: businessId });
    if (tool === "find_shop") return await run("");
    // the call's shop: find_shop's binding, else a direct business_id; either way it must be live right now
    const businessId = d.shops.get(parsed.data.conversation_id) ?? parsed.data.business_id;
    if (!businessId) return refuse("First ask which shop the caller is calling, then call find_shop with the name.", { reason: "shop_required" });
    if (!liveShop(d, businessId)) return refuse("This phone line doesn't serve that shop.", { reason: "wrong_business" });
    return await run(businessId);
  } catch (e) {
    if (e instanceof PlatformUnavailable) {
      log.error("phone", `${tool}: platform unavailable: ${e.message}`);
      return { status: 503, body: { ok: false, say: "The shop's system is unavailable right now. Please try again in a minute." } };
    }
    throw e;
  }
}
