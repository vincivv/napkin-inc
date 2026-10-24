// Platform-target attacks on the webhook channel need no agent: the attacker IS the HTTP request. The
// request goes to the brain's real HTTP app (createApp) at POST /webhooks/stripe, configured the way it runs
// once Stripe is set up: test mode with a webhook secret. The secret is generated locally per run; the gateway
// refuses every network call (no Stripe key exists), so if a forged event ever got past the signature check
// the processor lookups would fail loudly instead of reaching Stripe.

import { createApp, PermanentProcessorError, type ProcessorGateway } from "./brain";
import type { ScratchWorld } from "./db";
import { businessFor } from "./db";
import { signatureFor } from "./stripe-events";
import type { Attack, Mode, Transcript } from "../types";

const noNetwork = (what: string) => async (): Promise<never> => {
  throw new PermanentProcessorError(`red team: ${what} would call Stripe; no Stripe key in this run`);
};

/** A gateway that says "test mode" (so /webhooks/stripe is enabled) and refuses every Stripe call. */
export const noNetworkTestGateway: ProcessorGateway = {
  mode: "test",
  feeForPaymentIntent: noNetwork("feeForPaymentIntent"),
  createCheckoutSession: noNetwork("createCheckoutSession"),
  retrieveCheckoutSession: noNetwork("retrieveCheckoutSession"),
  createRefund: noNetwork("createRefund"),
  balanceTransactionFee: noNetwork("balanceTransactionFee"),
  orderIdForPaymentIntent: noNetwork("orderIdForPaymentIntent"),
  refundsForCharge: noNetwork("refundsForCharge"),
};

/** Delivers the attack's raw webhook to the brain and returns the exchange as a transcript. */
export async function deliverAttackWebhook(world: ScratchWorld, attack: Attack, mode: Mode, secret: string): Promise<Transcript> {
  const hook = attack.setup?.webhook;
  if (!hook) throw new Error(`${attack.id} has no setup.webhook`);
  const app = createApp({
    platform: world.platform,
    gateway: noNetworkTestGateway,
    sessions: { get: () => undefined, put: () => undefined },
    storePublicUrl: "http://localhost:3002",
    corsOrigins: [],
    webhookSecret: secret,
    ownerPin: undefined,
    hasStorefront: () => true,
    health: () => ({ redteam: true, business: businessFor(mode) }),
  });
  const raw = JSON.stringify(hook.payload);
  const sig = signatureFor(hook.signature, raw, secret);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sig !== undefined) headers["stripe-signature"] = sig;
  const res = await app.request("/webhooks/stripe", { method: "POST", body: raw, headers });
  const body = await res.text();
  return {
    turns: [
      { role: "attacker", text: `POST /webhooks/stripe (Stripe-Signature: ${hook.signature}) ${raw}` },
      { role: "system", text: `HTTP ${res.status} ${body}` },
    ],
    toolCalls: [{ tool: "POST /webhooks/stripe", args: { signature: hook.signature, eventType: String(hook.payload.type ?? "") }, allowed: res.status < 300, ruleIds: [], result: { status: res.status, body } }],
  };
}
