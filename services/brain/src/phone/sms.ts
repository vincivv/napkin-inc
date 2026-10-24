// SMS for the phone line (Cartesia has no SMS). Two senders:
//   - TwilioSms: Twilio Programmable Messaging REST API, POST /2010-04-01/Accounts/{AccountSid}/Messages.json
//     (form-encoded To/From/Body, HTTP Basic auth AccountSid:AuthToken).
//     Docs: https://www.twilio.com/docs/messaging/api/message-resource
//   - SimulatorSms: the SMS SIMULATOR used when Twilio keys are absent. It logs the message and keeps it in memory.
//     It NEVER claims a message was sent (status "simulated_not_sent").
//
// Messages are queued on the PLATFORM outbox (reducer enqueueOutbox, kind "sms", idempotency key
// "paylink:<orderId>") and sent by SmsExecutor under the brain's OutboxWorker. Twilio has no idempotency key
// for message creation, so a crash between Twilio accepting a message and completeOutbox makes the stale retry
// send a second text (at-most-twice, logged). See SmsExecutor.

import { log } from "../log";
import type { OutboxExecutor, OutboxResult } from "../payments/outbox";
import type { OutboxView } from "../platform";
import { maskPhone, normalizeE164 } from "./util";

export type SmsStatus = "sent" | "simulated_not_sent";

export interface SmsSendResult {
  /** Twilio message SID (SM...) or "sim_sms_<n>" */
  sid: string;
  status: SmsStatus;
  /** Twilio's own status string (queued/accepted/...) when real */
  providerStatus?: string;
  simulated: boolean;
}

/** Retry later (network, 5xx, 429). */
export class TransientSmsError extends Error {
  override name = "TransientSmsError";
}
/** Will never succeed as is (bad number, trial account sending to an unverified number, auth). */
export class PermanentSmsError extends Error {
  override name = "PermanentSmsError";
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

export interface SmsSender {
  readonly mode: "twilio" | "simulator";
  send(msg: { to: string; body: string }): Promise<SmsSendResult>;
}

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

export class TwilioSms implements SmsSender {
  readonly mode = "twilio" as const;
  constructor(
    private readonly cfg: TwilioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: { to: string; body: string }): Promise<SmsSendResult> {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.cfg.accountSid)}/Messages.json`;
    const form = new URLSearchParams({ To: msg.to, From: this.cfg.fromNumber, Body: msg.body });
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.cfg.accountSid}:${this.cfg.authToken}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new TransientSmsError(`Twilio unreachable: ${(e as Error).message}`);
    }
    let json: Record<string, unknown> = {};
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      /* non-JSON error page */
    }
    if (res.ok && typeof json.sid === "string") {
      return { sid: json.sid, status: "sent", providerStatus: typeof json.status === "string" ? json.status : undefined, simulated: false };
    }
    // Twilio REST errors: {code, message, more_info, status}. Never echo the auth header or token.
    const code = typeof json.code === "number" ? json.code : undefined;
    const message = `Twilio HTTP ${res.status}${code ? ` (error ${code})` : ""}: ${typeof json.message === "string" ? json.message.slice(0, 200) : "no message"}`;
    if (res.status === 429 || res.status >= 500) throw new TransientSmsError(message);
    throw new PermanentSmsError(message, code);
  }
}

export interface SimulatedSms {
  sid: string;
  to: string;
  body: string;
  at: string;
}

export class SimulatorSms implements SmsSender {
  readonly mode = "simulator" as const;
  readonly messages: SimulatedSms[] = [];
  private n = 0;
  async send(msg: { to: string; body: string }): Promise<SmsSendResult> {
    const sid = `sim_sms_${++this.n}`;
    this.messages.push({ sid, to: msg.to, body: msg.body, at: new Date().toISOString() });
    log.warn("SMS SIMULATOR", `NOT SENT (no Twilio keys). To ${maskPhone(msg.to)}: ${msg.body}`);
    return { sid, status: "simulated_not_sent", simulated: true };
  }
}

// ---------------- platform outbox executor ----------------

/** After this many transient failures (in one brain process) the row is completed as failed instead of retried again. */
export const MAX_SMS_ATTEMPTS = 5;

/** The payload the phone line queues with enqueueOutbox (kind "sms"). */
export interface SmsPayload {
  to: string;
  body: string;
  orderId?: string;
}

/**
 * Executor for platform outbox rows of kind "sms" ({to, body, orderId?}). The OutboxWorker claims the row,
 * calls this, then completes it; a row left "claimed" (brain crash, transient Twilio error) is executed again
 * after the stale timeout.
 *
 * Exactly-once holds up to the Twilio call: the platform row is created once per idempotency key and is
 * completed once. It does NOT hold at Twilio: message creation has no idempotency key, so a crash after
 * Twilio accepted the message and before completeOutbox makes the stale retry send a second text (at most
 * twice per crash). That window is made visible: every send logs the key, attempt number and Twilio SID, and an
 * attempt after the first logs a loud "possible duplicate" warning.
 */
export class SmsExecutor implements OutboxExecutor {
  private readonly transientFailures = new Map<string, number>();
  constructor(private readonly sender: SmsSender) {}

  handles(kind: string): boolean {
    return kind === "sms";
  }

  async execute(item: OutboxView): Promise<OutboxResult> {
    let p: Partial<SmsPayload>;
    try {
      p = JSON.parse(item.payloadJson) as Partial<SmsPayload>;
    } catch {
      return { ok: false, result: { error: "payloadJson is not JSON" } };
    }
    if (typeof p.to !== "string" || typeof p.body !== "string" || !p.body) return { ok: false, result: { error: "payload needs to and body" } };
    const to = normalizeE164(p.to);
    if (!to) return { ok: false, result: { error: "refusing to send an SMS to a number that is not E.164" } };

    const key = item.idempotencyKey;
    // The worker hands over the row as it saw it: "pending" for a first run, "claimed" for a stale retry.
    if (item.status === "claimed") {
      log.warn("sms", `${key}: re-running a stale claimed row. An earlier run may already have reached Twilio (no provider idempotency key), so this text can be a DUPLICATE`);
    }
    try {
      const r = await this.sender.send({ to, body: p.body });
      this.transientFailures.delete(key);
      // If the brain dies right after this line and before completeOutbox, the row stays "claimed" and is re-sent.
      log.info("sms", `${key}: ${r.status} (${r.simulated ? "SIMULATOR" : r.sid}) to ${maskPhone(to)}; completeOutbox pending (a crash before it means a re-send after the stale timeout)`);
      return { ok: true, result: { sid: r.sid, status: r.status, simulated: r.simulated } };
    } catch (e) {
      const err = e as Error;
      if (e instanceof PermanentSmsError) {
        log.error("sms", `${key} failed permanently: ${err.message}`);
        return { ok: false, result: { error: err.message } };
      }
      // The worker's stale retry does not bump the row's attempts, so count transient failures here (per process).
      const n = (this.transientFailures.get(key) ?? 0) + 1;
      this.transientFailures.set(key, n);
      if (n >= MAX_SMS_ATTEMPTS) {
        this.transientFailures.delete(key);
        log.error("sms", `${key} gave up after ${n} transient failures: ${err.message}`);
        return { ok: false, result: { error: err.message, transientFailures: n } };
      }
      log.error("sms", `${key} transient failure ${n}/${MAX_SMS_ATTEMPTS} (${err.message}); retried after the stale timeout`);
      throw err;
    }
  }
}
