// Calls to the brain (services/brain). The brain and the platform decide prices, stock and totals;
// the storefront only sends product ids and quantities.
import { BRAIN_URL } from "./env";

export type CheckoutRequest = {
  businessId: string;
  lines: { productId: string; qty: number }[];
  customerName: string;
  couponCode?: string;
};

async function errorMessage(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    for (const k of ["error", "message", "reason"]) {
      const v = j[k];
      if (typeof v === "string" && v) return v;
      if (v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string") {
        return (v as { message: string }).message;
      }
    }
  } catch {
    // not JSON
  }
  return text.trim() || `The shop could not take this order (HTTP ${res.status}).`;
}

async function post(path: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(`${BRAIN_URL}${path}`, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Can't reach the checkout service right now. Please try again in a moment.");
  }
}

/** POST /checkout -> the URL to send the shopper to (Stripe Checkout, or the dev simulator page). */
export async function startCheckout(req: CheckoutRequest): Promise<string> {
  const res = await post("/checkout", req);
  if (!res.ok) throw new Error(await errorMessage(res));
  const j = (await res.json().catch(() => ({}))) as { url?: unknown };
  if (typeof j.url !== "string" || !j.url) throw new Error("Checkout did not return a payment link.");
  return j.url;
}

/** DEV SIMULATOR only: POST /dev/simulate-payment/:orderId. */
export async function simulatePayment(orderId: string): Promise<void> {
  const res = await post(`/dev/simulate-payment/${encodeURIComponent(orderId)}`);
  if (!res.ok) throw new Error(await errorMessage(res));
}

export type StaffRole = "shopkeeper" | "support";
export type ChatToolCall = {
  tool: string;
  args: unknown;
  decision: { allow: boolean; outcome: string; ruleIds: string[]; reason: string };
  result: unknown;
};
export type ChatReply = { reply: string; toolCalls: ChatToolCall[] };

/** POST /agents/:role/message: one customer turn with the shop's AI staff (every tool call goes through the guards). */
export async function sendChat(role: StaffRole, req: { businessId: string; conversationId: string; text: string }): Promise<ChatReply> {
  const res = await post(`/agents/${role}/message`, req);
  if (!res.ok) throw new Error(res.status === 503 ? "The shop's assistant is offline right now." : await errorMessage(res));
  const j = (await res.json()) as Partial<ChatReply>;
  return { reply: typeof j.reply === "string" ? j.reply : "", toolCalls: Array.isArray(j.toolCalls) ? j.toolCalls : [] };
}
