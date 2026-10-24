// SMS for the phone line (Cartesia has no SMS). Two senders:
//   - TwilioSms: Twilio Programmable Messaging REST API, POST /2010-04-01/Accounts/{AccountSid}/Messages.json
//     (form-encoded To/From/Body, HTTP Basic auth AccountSid:AuthToken).
//     Docs: https://www.twilio.com/docs/messaging/api/message-resource
//   - SimulatorSms: the SMS SIMULATOR used when Twilio keys are absent. It logs the message and keeps it in memory.
//     It NEVER claims a message was sent (status "simulated_not_sent").
//
// Messages go through SmsOutbox: one row per idempotency key, so a retried tool call never texts twice
// once the first send succeeded. Twilio has no idempotency key for message creation, so a crash between
// Twilio accepting a message and the row being marked done can, on retry, send a duplicate (at-least-once).

import path from "node:path";
import { log } from "../log";
import type { OutboxExecutor, OutboxResult } from "../payments/outbox";
import type { OutboxView } from "../platform";
import { JsonFileStore } from "../store";
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

// ---------------- outbox ----------------

export interface SmsOutboxItem {
  key: string;
  kind: string; // e.g. "pay_link"
  businessId: string;
  orderId?: string;
  to: string;
  body: string;
  status: "pending" | "claimed" | "done" | "failed";
  attempts: number;
  createdAt: string;
  claimedAtMs?: number;
  result?: { sid?: string; status?: SmsStatus | "failed"; simulated?: boolean; error?: string };
}

export interface SmsOutboxStore {
  read(): Record<string, SmsOutboxItem>;
  update(fn: (all: Record<string, SmsOutboxItem>) => void): Record<string, SmsOutboxItem>;
}

export class FileSmsOutboxStore extends JsonFileStore<Record<string, SmsOutboxItem>> implements SmsOutboxStore {
  constructor(dataDir: string) {
    super(path.join(dataDir, "sms-outbox.json"), () => ({}));
  }
}

export class MemorySmsOutboxStore implements SmsOutboxStore {
  private data: Record<string, SmsOutboxItem> = {};
  read() {
    return structuredClone(this.data);
  }
  update(fn: (all: Record<string, SmsOutboxItem>) => void) {
    const next = structuredClone(this.data);
    fn(next);
    this.data = next;
    return structuredClone(next);
  }
}

export const MAX_SMS_ATTEMPTS = 5;

/**
 * Brain-side SMS outbox, keyed by idempotency key. The platform outbox has no reducer the brain can use to
 * queue an "sms" row (only the platform itself inserts outbox rows), so pay-link texts are queued here; the
 * same SmsExecutor also drains platform outbox rows of kind "sms" if the platform ever queues them.
 */
export class SmsOutbox {
  private readonly inflight = new Map<string, Promise<SmsOutboxItem>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly store: SmsOutboxStore,
    readonly sender: SmsSender,
    private readonly opts: { staleMs?: number; now?: () => number } = {},
  ) {}

  get(key: string): SmsOutboxItem | undefined {
    return this.store.read()[key];
  }

  all(): SmsOutboxItem[] {
    return Object.values(this.store.read());
  }

  /** Queue once per key. A second enqueue with the same key returns the existing row unchanged. */
  enqueue(item: Pick<SmsOutboxItem, "key" | "kind" | "businessId" | "orderId" | "to" | "body">): SmsOutboxItem {
    const to = normalizeE164(item.to);
    if (!to) throw new PermanentSmsError("refusing to queue an SMS to a number that is not E.164");
    let out!: SmsOutboxItem;
    this.store.update((all) => {
      const existing = all[item.key];
      if (existing) {
        out = existing;
        return;
      }
      out = { ...item, to, status: "pending", attempts: 0, createdAt: new Date((this.opts.now ?? Date.now)()).toISOString() };
      all[item.key] = out;
    });
    return out;
  }

  /** Send one queued row now (if it is pending, or claimed but stale). Concurrent calls for one key share a send. */
  deliver(key: string): Promise<SmsOutboxItem> {
    const running = this.inflight.get(key);
    if (running) return running;
    const p = this.run(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async run(key: string): Promise<SmsOutboxItem> {
    const now = (this.opts.now ?? Date.now)();
    const staleMs = this.opts.staleMs ?? 60_000;
    let claimed: SmsOutboxItem | undefined;
    this.store.update((all) => {
      const it = all[key];
      if (!it) return;
      const stale = it.status === "claimed" && it.claimedAtMs !== undefined && now - it.claimedAtMs > staleMs;
      if (it.status !== "pending" && !stale) return;
      it.status = "claimed";
      it.attempts += 1;
      it.claimedAtMs = now;
      claimed = { ...it };
    });
    if (!claimed) {
      const cur = this.get(key);
      if (!cur) throw new Error(`no SMS outbox row ${key}`);
      return cur;
    }
    let patch: Partial<SmsOutboxItem>;
    try {
      const r = await this.sender.send({ to: claimed.to, body: claimed.body });
      patch = { status: "done", result: { sid: r.sid, status: r.status, simulated: r.simulated } };
      log.info("sms", `${key} -> ${r.status} (${r.simulated ? "SIMULATOR" : r.sid}) to ${maskPhone(claimed.to)}`);
    } catch (e) {
      const err = e as Error;
      const permanent = e instanceof PermanentSmsError || claimed.attempts >= MAX_SMS_ATTEMPTS;
      patch = permanent ? { status: "failed", result: { status: "failed", error: err.message } } : { status: "pending", result: { error: err.message } };
      log.error("sms", `${key} attempt ${claimed.attempts} ${permanent ? "failed permanently" : "will be retried"}: ${err.message}`);
    }
    let out!: SmsOutboxItem;
    this.store.update((all) => {
      out = { ...all[key]!, ...patch };
      all[key] = out;
    });
    return out;
  }

  /** Retry pending and stale-claimed rows. Returns the keys attempted. */
  async drain(): Promise<string[]> {
    const now = (this.opts.now ?? Date.now)();
    const staleMs = this.opts.staleMs ?? 60_000;
    const keys = this.all()
      .filter((i) => i.status === "pending" || (i.status === "claimed" && i.claimedAtMs !== undefined && now - i.claimedAtMs > staleMs))
      .map((i) => i.key);
    await Promise.all(keys.map((k) => this.deliver(k).catch(() => undefined)));
    return keys;
  }

  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => void this.drain(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
  }
}

/**
 * Executor for platform outbox rows of kind "sms" ({to, body} payload). The platform does not queue such rows
 * today; registering it means the brain's OutboxWorker will drain them with the row's own idempotency key if it does.
 */
export class SmsExecutor implements OutboxExecutor {
  constructor(private readonly outbox: SmsOutbox) {}
  handles(kind: string): boolean {
    return kind === "sms";
  }
  async execute(item: OutboxView): Promise<OutboxResult> {
    let p: { to?: string; body?: string; orderId?: string };
    try {
      p = JSON.parse(item.payloadJson) as typeof p;
    } catch {
      return { ok: false, result: { error: "payloadJson is not JSON" } };
    }
    if (!p.to || !p.body) return { ok: false, result: { error: "payload needs to and body" } };
    let row: SmsOutboxItem;
    try {
      this.outbox.enqueue({ key: `platform:${item.idempotencyKey}`, kind: "platform_sms", businessId: item.businessId, orderId: p.orderId, to: p.to, body: p.body });
      row = await this.outbox.deliver(`platform:${item.idempotencyKey}`);
    } catch (e) {
      if (e instanceof PermanentSmsError) return { ok: false, result: { error: e.message } };
      throw e;
    }
    if (row.status === "pending" || row.status === "claimed") throw new TransientSmsError(row.result?.error ?? "SMS not sent yet");
    return { ok: row.status === "done", result: { ...row.result } };
  }
}
