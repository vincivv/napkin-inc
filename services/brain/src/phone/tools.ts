// The phone line's webhook tools (Cartesia Managed Agent -> POST /phone/tools/<name>). All logic lives here;
// the voice agent only talks. Two modes:
//   customer: menu_lookup, order_status (own orders only), place_order, escalate, verify_owner
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
import { PermanentSmsError, type SmsOutbox, type SmsOutboxItem } from "./sms";
import type { FailureLimiter, OwnerSessions, PhoneOrderStore } from "./state";
import { constantTimeEqual, formatCents, localDay, maskPhone, normalizeE164, normalizeOrderId, normalizePin, sha256 } from "./util";

export interface PhoneDeps {
  platform: PhonePlatform;
  checkout: CheckoutDeps;
  /** M2 deps (spec store + LLM + platform) for owner_instruction; undefined disables it. */
  m2: M2Deps | undefined;
  sms: SmsOutbox;
  orders: PhoneOrderStore;
  sessions: OwnerSessions;
  failures: FailureLimiter;
  /** The one business this line serves. */
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
  business_id: z.string().regex(/^[a-z0-9-]{1,64}$/),
  /** {{system__caller_id}}; empty in browser previews and for hidden numbers */
  caller_id: z.string().max(40).default(""),
  /** {{system__conversation_id}} */
  conversation_id: z.string().trim().min(1).max(128),
});

export const TOOL_INPUTS = {
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

type In<T extends ToolName> = z.infer<(typeof TOOL_INPUTS)[T]>;

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

function smsSay(item: SmsOutboxItem): { sms: string; say: string } {
  if (item.status === "done" && item.result?.status === "sent") return { sms: "sent", say: "I've texted a payment link to the number you're calling from." };
  if (item.status === "done" && item.result?.status === "simulated_not_sent")
    return { sms: "simulated_not_sent", say: "Text messages are not set up on this line yet, so no text was sent. The order is saved; the shop can send you the payment link." };
  if (item.status === "failed") return { sms: "failed", say: "I couldn't text the payment link to this number. The order is saved; the shop will follow up." };
  return { sms: "queued", say: "The payment link text is queued and should arrive shortly." };
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
  let item: SmsOutboxItem;
  try {
    // Always the CALLER ID on record for this order: never a number spoken in the conversation.
    d.sms.enqueue({ key: smsKey, kind: "pay_link", businessId: input.business_id, orderId, to: caller, body: `Order ${orderId}, total ${total}. Pay here: ${link}` });
    item = await d.sms.deliver(smsKey);
  } catch (e) {
    if (!(e instanceof PermanentSmsError)) throw e;
    item = { key: smsKey, kind: "pay_link", businessId: input.business_id, orderId, to: caller, body: "", status: "failed", attempts: 0, createdAt: "", result: { error: e.message } };
  }
  const s = smsSay(item);
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
  if (!cfg) {
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
  if (parsed.data.business_id !== d.businessId) return refuse("This phone line doesn't serve that business.", { reason: "wrong_business" });
  try {
    await d.platform.ready();
    return await (HANDLERS[tool] as (d: PhoneDeps, i: unknown) => Promise<ToolResult>)(d, parsed.data);
  } catch (e) {
    if (e instanceof PlatformUnavailable) {
      log.error("phone", `${tool}: platform unavailable: ${e.message}`);
      return { status: 503, body: { ok: false, say: "The shop's system is unavailable right now. Please try again in a minute." } };
    }
    throw e;
  }
}
