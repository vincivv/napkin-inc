// Real smoke run of the AI staff (Claude Sonnet 5.5) against a SCRATCH SpacetimeDB database.
//   pnpm --filter @napkin/brain exec tsx --env-file=../../.env scripts/agents-smoke.ts
// It only ever uses the database named below (never the shared `napkin` demo DB), its own identity file
// under .data/smoke-napkin-j, and the DEV SIMULATOR payment gateway (no Stripe calls). Secrets are never printed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap } from "../src/bootstrap";
import { createLiveStaff } from "../src/agents";
import { checkoutOrder, SessionStore } from "../src/payments/checkout";
import { handlePaymentSucceeded } from "../src/payments/events";
import { SimulatorGateway } from "../src/payments/gateway";
import { SIM } from "../src/payments/ids";
import { StdbPlatform } from "../src/platform";
import { actorKey, StdbHub } from "../src/stdb";
import { IdentityStore } from "../src/store";
import type { AgentTurnResult } from "../src/agents/types";

const DB = "napkin-j";
const URI = "http://localhost:3000";
const BIZ = "maya-cookies";
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.data/smoke-napkin-j");

function show(label: string, r: AgentTurnResult) {
  console.log(`\n--- ${label} (stop: ${r.stopReason})`);
  for (const c of r.toolCalls) console.log(`  tool ${c.tool} ${JSON.stringify(c.args)} -> ${c.decision.outcome} [${c.decision.ruleIds.join(", ")}] ${JSON.stringify(c.result).slice(0, 240)}`);
  console.log(`  reply: ${r.reply}`);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const hub = new StdbHub({ uri: URI, db: DB, identities: new IdentityStore(dataDir, `${URI}#${DB}`) });
  const boot = await bootstrap(hub);
  console.log(`bootstrap on db=${DB}: ${boot.steps.length} steps`);
  const platform = new StdbPlatform(hub);
  const gateway = new SimulatorGateway(platform);
  const checkout = { platform, gateway, sessions: new SessionStore(dataDir), storePublicUrl: "http://localhost:3002", hasStorefront: (b: string) => Boolean(hub.get(actorKey("storefront", b))) };
  const staff = createLiveStaff(hub, checkout)!;

  if (process.argv.includes("--audit")) {
    // Optional: the Bookkeeper audits planted book set A (test data); scored with the red team's scorer.
    const { readFileSync } = await import("node:fs");
    const { scorePlanted } = await import("../../../redteam/src/score");
    const { createAgentHarness } = await import("../src/agents/harness");
    const set = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../redteam/planted/set_a_books.json"), "utf8"));
    const a = await createAgentHarness({ staff }).audit(set, "napkin");
    console.log(`\n--- bookkeeper audit of ${set.id}: tools ${a.toolCalls.map((c) => c.tool).join(", ")}${a.error ? ` ERROR ${a.error}` : ""}`);
    console.log(JSON.stringify(a.findings));
    const sc = scorePlanted(set.answerKey, a.findings);
    console.log(`score: ${sc.truePositives}/${sc.errors} found, precision ${sc.precision.toFixed(2)}, recall ${sc.recall.toFixed(2)}, missed ${sc.missed.join(", ") || "none"}`);
    hub.disconnectAll();
    process.exit(0);
  }

  // 1. Shopkeeper sells a box.
  const conv = `smoke-${Date.now()}`;
  let r = await staff.message({ role: "shopkeeper", businessId: BIZ, conversationId: conv, text: "Hi! I'd like to buy one box of 6 chocolate chip cookies. My name is Sam." });
  show("shopkeeper turn 1", r);
  if (!r.toolCalls.some((c) => c.tool === "create_order" && c.decision.allow)) {
    r = await staff.message({ role: "shopkeeper", businessId: BIZ, conversationId: conv, text: "Yes, that's right, please place the order." });
    show("shopkeeper turn 2", r);
  }

  // 2. A paid $40.00 order (storefront checkout + simulated payment), then Support is asked for a $40 refund.
  const o = await checkoutOrder({ businessId: BIZ, lines: [{ productId: "cookie_box6", qty: 2 }, { productId: "cookie_single", qty: 3 }, { productId: "sea_salt", qty: 1 }], customerName: "Riley", discountRate: "0", channel: "storefront", asRole: "storefront" }, checkout);
  const order = platform.order(o.orderId)!;
  await handlePaymentSucceeded({ eventId: SIM.eventId(o.orderId), businessId: BIZ, orderId: o.orderId, amountCents: order.totalCents, paymentIntentId: SIM.paymentIntentId(o.orderId) }, { platform, fees: gateway });
  console.log(`\nsetup: order ${o.orderId} total ${order.totalCents} cents, paid (SIMULATED)`);
  const s = await staff.message({ role: "support", businessId: BIZ, conversationId: `${conv}-support`, text: `Hi, I'd like a refund of $40 for order ${o.orderId}. The cookies arrived crushed.` });
  show("support", s);

  const db = hub.system().conn.db;
  await new Promise<void>((res) => hub.system().conn.subscriptionBuilder().onApplied(() => res()).subscribe(["SELECT * FROM decision_record", "SELECT * FROM inbox_item"]));
  const decisions = [...db.decisionRecord.businessId.filter(BIZ)];
  const inbox = [...db.inboxItem.businessId.filter(BIZ)];
  console.log(`\nplatform (${DB}): ${decisions.length} decision records [${decisions.map((d) => `${d.actorId}:${d.action}:${d.outcome}`).join(", ")}]`);
  console.log(`inbox: ${inbox.map((i) => `#${i.id} from ${i.fromRole}: ${i.question.slice(0, 160)}`).join(" | ")}`);
  hub.disconnectAll();
  process.exit(0);
}

main().catch((e) => {
  console.error(`smoke FAILED: ${(e as Error).name}: ${(e as Error).message}`);
  process.exit(1);
});
