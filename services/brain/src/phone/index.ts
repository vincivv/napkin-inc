// Phone line wiring (M3-K): mounts POST /phone/tools/:name on the brain app.

import type { Hono } from "hono";
import type { Env } from "../env";
import { banner, log } from "../log";
import type { M2Deps } from "../m2deps";
import type { CheckoutDeps } from "../payments/checkout";
import type { StdbHub } from "../stdb";
import { StdbPhonePlatform } from "./platform";
import { phoneRoutes } from "./routes";
import { SimulatorSms, SmsExecutor, TwilioSms, type SmsSender } from "./sms";
import { FailureLimiter, FilePhoneOrderBackend, OwnerSessions, PhoneOrderStore } from "./state";
import type { PhoneDeps } from "./tools";
import { normalizeE164 } from "./util";

export function smsSenderFromEnv(env: Pick<Env, "twilio" | "twilioProblem">): SmsSender {
  if (env.twilio) return new TwilioSms(env.twilio);
  banner([
    "SMS SIMULATOR: Twilio is not configured, so NO text messages are sent.",
    `Reason: ${env.twilioProblem ?? "unknown"}.`,
    "Pay-link texts are logged here as [SMS SIMULATOR] and the phone agent says no text was sent.",
  ]);
  return new SimulatorSms();
}

export function registerPhoneRoutes(app: Hono, o: { env: Env; hub: StdbHub; m2: M2Deps; checkout: CheckoutDeps }): { deps: PhoneDeps; smsExecutor: SmsExecutor } {
  const { env } = o;
  const sender = smsSenderFromEnv(env);
  const deps: PhoneDeps = {
    platform: new StdbPhonePlatform(o.hub),
    checkout: o.checkout,
    m2: o.m2,
    smsMode: sender.mode,
    orders: new PhoneOrderStore(new FilePhoneOrderBackend(env.dataDir)),
    sessions: new OwnerSessions(),
    failures: new FailureLimiter(3, 15 * 60_000),
    businessId: env.phoneBusinessId,
    ownerPhone: env.ownerPhone,
    ownerPin: env.ownerPin,
    publicBrainUrl: env.brainUrl,
  };
  if (!env.phoneToolSecret) log.warn("phone", "PHONE_TOOL_SECRET missing or too short: every /phone/tools call answers 401");
  if (!normalizeE164(env.ownerPhone) || !env.ownerPin) log.warn("phone", "OWNER_PHONE (E.164) and OWNER_PIN are both required for phone owner mode; owner mode is disabled");
  if (/localhost|127\.0\.0\.1/.test(env.brainUrl)) log.warn("phone", `BRAIN_URL is ${env.brainUrl}: texted pay links will not open on a phone. Set it to the public tunnel URL.`);
  app.route("/", phoneRoutes(deps, env.phoneToolSecret));
  return { deps, smsExecutor: new SmsExecutor(sender) };
}
