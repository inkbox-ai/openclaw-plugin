// Outbound delivery-failure feedback loop.
//
// An outbound message can die two ways, and until now the agent never learned
// about either:
//
//   - Rejected at send time — the server's outbound content policy 422s the
//     send (markdown artifacts, emoji overload…), the recipient has opted out,
//     the address is bad, or the body is too long. The error comes back on the
//     send call (the synchronous surface).
//   - Failed after acceptance — the carrier flags it (e.g. error 40002) or the
//     receiving mail server bounces it, reported later via
//     `text.delivery_failed` / `imessage.delivery_failed` /
//     `message.bounced` / `message.failed` webhooks (the asynchronous surface).
//
// Both surfaces feed one loop: the agent is woken in the same conversation
// session with the exact error plus its own undelivered body. The recovery
// instruction is derived from both the failure classification and attempt:
// the first retryable failure requires one safe retry, later retryable
// failures make retry optional, terminal failures stop immediately, and
// unknown failures require a safety review before any retry.
// Total sends per logical reply are hard-capped: after
// OUTBOUND_FAILURE_MAX_ATTEMPTS failed sends the loop stops waking the agent
// and the thread goes quiet. The budget is shared across both surfaces (keyed
// by conversation + recipient, merged by max) and resets on a fresh inbound, a
// delivered receipt, or a TTL.
//
// This module owns the budget math, the failure-key normalization, the wake-up
// prompt, and the webhook payload extractors. `src/inbound/session.ts` wires it
// into the inbound bridge (async webhooks + the synchronous reply send path).

import { createHash } from "node:crypto";
import { InkboxAPIError } from "@inkbox/sdk";
import type {
  IMessageWebhookPayload,
  MailWebhookPayload,
  TextWebhookPayload,
} from "@inkbox/sdk";

export type DeliveryFailureChannel = "sms" | "imessage" | "email";

// Where the message died: rejected synchronously on the send call, or reported
// asynchronously by a lifecycle webhook (carrier failure / mail bounce).
export type DeliveryFailureStage = "send_rejected" | "delivery_failed" | "bounced";

// Hard cap on total sends per logical reply. Failures 1 and 2 wake the agent
// (sends 2 and 3); failure 3 goes quiet with a loud log line.
export const OUTBOUND_FAILURE_MAX_ATTEMPTS = 3;
// A retry loop is a burst affair; a stale counter must not silence an unrelated
// failure hours later.
export const OUTBOUND_FAILURE_STATE_TTL_MS = 30 * 60 * 1000;
// How much of the undelivered body to echo back into the wake-up turn.
export const OUTBOUND_FAILURE_BODY_SNIPPET_CHARS = 400;

// The async lifecycle events that wake the agent. The success transitions
// (sent/delivered/forwarded) and `text.delivery_unconfirmed` (status
// uncertainty, not a hard failure) are deliberately absent — they never
// trigger a recovery turn.
export const DELIVERY_FAILURE_EVENT_TYPES: readonly string[] = [
  "text.delivery_failed",
  "imessage.delivery_failed",
  "message.bounced",
  "message.failed",
];

// Per-channel fix-it guidance embedded in the delivery-failure wake-up turn.
// Text channels are usually fixable by rewriting; a mail bounce usually means
// the address is the problem, not the prose.
const DELIVERY_FAILURE_CHANNEL_GUIDANCE: Record<DeliveryFailureChannel, string> = {
  sms:
    "Rewrite the message so it no longer trips the stated rule and it reads " +
    "like a human text: plain conversational prose, no markdown (**bold**, # " +
    "headers, ``` fences), at most one emoji, no profanity, no test/probe " +
    "phrasing.",
  imessage:
    "Rewrite the message so it no longer trips the stated rule and it reads " +
    "like a human text: plain conversational prose, no markdown.",
  email:
    "The receiving mail server did not accept this message — the address may " +
    "be wrong or the mailbox unreachable. A plain reply here retries the SAME " +
    "address, so first check the contact card for a corrected address or reach " +
    "the person on another channel with your tools; only resend here if you " +
    "have reason to think it will now deliver.",
};

export type DeliveryFailureClassification = "retryable" | "terminal" | "unknown";

const DELIVERY_FAILURE_TERMINAL_CODES = new Set([
  "recipient_not_opted_in",
  "recipient_opted_out",
  "recipient_blocked",
  "invalid_phone_number",
  "carrier_rejected",
  "sender_sms_pending",
  "sender_sms_assignment_failed",
  "sender_not_registered",
  "sender_registration_required",
  "messaging_profile_disabled",
  "toll_free_sms_unsupported",
]);

const DELIVERY_FAILURE_TERMINAL_MARKERS = [
  "opted out",
  "opt-out",
  "not opted in",
  "invalid number",
  "invalid phone",
  "unreachable",
  "unknown subscriber",
  "cannot receive",
  "unsafe",
  "harmful",
  "abusive",
  "harassment",
  "threatening",
  "illegal content",
];

const DELIVERY_FAILURE_RETRYABLE_MARKERS = [
  "40002",
  "spam",
  "content",
  "too_long",
  "too long",
  "markdown",
  "emoji",
  "profanity",
  "temporar",
  "carrier_unavailable",
];

/**
 * Classify the agent's recovery policy for a failed outbound delivery.
 *
 * This is intentionally distinct from `classifySendRejection.retryable`,
 * which answers whether the OpenClaw host should retry the same transport
 * request. Here, `retryable` means the agent can safely make one materially
 * corrected send. Terminal signals win over broad retryable markers such as
 * "content" so unsafe content can never be forced through the retry path.
 */
export function classifyDeliveryFailure(
  errorCode?: string | null,
  errorDetail?: string | null,
): DeliveryFailureClassification {
  const code = normalizeKeyPart(errorCode);
  const combined = `${code} ${normalizeKeyPart(errorDetail)}`;
  if (
    DELIVERY_FAILURE_TERMINAL_CODES.has(code) ||
    DELIVERY_FAILURE_TERMINAL_MARKERS.some((marker) => combined.includes(marker))
  ) {
    return "terminal";
  }
  if (DELIVERY_FAILURE_RETRYABLE_MARKERS.some((marker) => combined.includes(marker))) {
    return "retryable";
  }
  return "unknown";
}

function deliveryFailureReplyInstruction(
  channel: DeliveryFailureChannel,
  classification: DeliveryFailureClassification,
  attempts: number,
): string {
  const label = channel === "sms" ? "SMS" : channel === "imessage" ? "iMessage" : "Email";
  if (classification === "retryable") {
    if (attempts === 1) {
      return (
        `${label} failure classification: FIRST SAFE RETRY REQUIRED. This is the first ` +
        `failure and it is retryable. You MUST now send exactly one safe, materially ` +
        `corrected ${label} message; do not reuse the failed wording.`
      );
    }
    return (
      `${label} failure classification: RETRY OPTIONAL. A safe, materially corrected ` +
      `${label} message may use the remaining retry budget, but the first retry has ` +
      `already failed. You may instead reply exactly [SILENT].`
    );
  }
  if (classification === "terminal") {
    return (
      `${label} failure classification: DO NOT RETRY. The recipient has not consented, ` +
      `the destination is invalid or unreachable, or the content is unsafe or harmful. ` +
      `Do not resend this message; reply exactly [SILENT].`
    );
  }
  return (
    `${label} failure classification: REVIEW BEFORE RETRY. Send one corrected message ` +
    `only if it is safe, permitted, and likely to deliver. Otherwise reply exactly ` +
    `[SILENT].`
  );
}

// ── Failure-counter store (the shared budget) ───────────────────────────────
//
// failure-key → { attempts, at }. Tracks how many sends of the current logical
// reply have already failed, per conversation/recipient (see
// outboundFailureKeys), so the loop can stop waking the agent after
// OUTBOUND_FAILURE_MAX_ATTEMPTS. Reset on inbound / delivered / TTL.

interface FailureEntry {
  attempts: number;
  at: number;
}

let outboundFailureState = new Map<string, FailureEntry>();
const OUTBOUND_FAILURE_STORE_MAX_ENTRIES = 512;

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function normalizeKeyPart(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * Normalize a failed send's routing facts into failure-counter keys.
 *
 * The sync path may only know a conversation id while the async webhook knows
 * both the conversation and the remote number (or vice versa), so the counter
 * is kept under every key we can derive and read back as the max across them —
 * one logical reply, one budget, however it is named. `chatId` is a FALLBACK
 * key only (e.g. the local too-long guard, which fires before the
 * conversation/number are resolved) — never alongside conv/to keys.
 */
export function outboundFailureKeys(
  channel: DeliveryFailureChannel,
  conversationId?: string | null,
  target?: string | null,
  chatId?: string | null,
): string[] {
  const keys: string[] = [];
  const conv = normalizeKeyPart(conversationId);
  if (conv) {
    keys.push(`${channel}:conv:${conv}`);
  }
  const raw = normalizeKeyPart(target);
  if (raw) {
    if (channel === "email") {
      keys.push(`${channel}:to:${raw}`);
    } else {
      // Phones compare by digits so +1 (603) 494-5490 and +16034945490 land
      // on the same counter.
      keys.push(`${channel}:to:${digitsOnly(raw) || raw}`);
    }
  }
  const chat = String(chatId ?? "").trim();
  if (keys.length === 0 && chat) {
    keys.push(`${channel}:chat:${chat}`);
  }
  return keys;
}

/**
 * Bump the failed-send counter for one logical reply. Returns the total failed
 * sends now recorded — the max across all keys plus one, written back under
 * every key so sync- and webhook-reported failures share one budget.
 */
export function recordOutboundFailure(keys: string[], now = Date.now()): number {
  let attempts = 0;
  for (const key of keys) {
    const entry = outboundFailureState.get(key);
    if (entry && now - entry.at <= OUTBOUND_FAILURE_STATE_TTL_MS) {
      attempts = Math.max(attempts, entry.attempts);
    }
  }
  attempts += 1;
  for (const key of keys) {
    outboundFailureState.set(key, { attempts, at: now });
  }
  // Opportunistic prune so the map can't grow unbounded.
  if (outboundFailureState.size > OUTBOUND_FAILURE_STORE_MAX_ENTRIES) {
    const cutoff = now - OUTBOUND_FAILURE_STATE_TTL_MS;
    outboundFailureState = new Map(
      [...outboundFailureState].filter(([, entry]) => entry.at > cutoff),
    );
  }
  return attempts;
}

/**
 * Forget the failure counter — a fresh reply gets a fresh budget. Clears the
 * superset of derivable keys: unlike recording (where the chat key is a
 * fallback), a known chat id is always cleared too, so an inbound reset also
 * wipes a budget recorded chat-only (e.g. by the local too-long guard).
 */
export function clearOutboundFailures(
  channel: DeliveryFailureChannel,
  conversationId?: string | null,
  target?: string | null,
  chatId?: string | null,
): void {
  const keys = outboundFailureKeys(channel, conversationId, target);
  const chat = String(chatId ?? "").trim();
  if (chat) {
    keys.push(`${channel}:chat:${chat}`);
  }
  for (const key of keys) {
    outboundFailureState.delete(key);
  }
}

// ── Failure dedup (async webhook replays) ───────────────────────────────────
//
// An outbound message fails at most once; replays of the same event
// (redelivery, subscription overlap) must not double-bill the retry budget or
// wake the agent twice. Keyed on what the event MEANS — channel + event type +
// failed message id — with a payload hash standing in when no id is present.

const FAILURE_DEDUP_TTL_MS = 30 * 60 * 1000;
const FAILURE_DEDUP_MAX_ENTRIES = 1000;
let seenFailures = new Map<string, number>();

/**
 * Returns true when this failure is new and should be handled; false for a
 * repeat delivery of one already handled.
 */
export function claimDeliveryFailure(params: {
  channel: DeliveryFailureChannel;
  eventType: string;
  messageId?: string;
  payload: unknown;
}): boolean {
  const now = Date.now();
  for (const [key, at] of seenFailures) {
    if (now - at > FAILURE_DEDUP_TTL_MS) {
      seenFailures.delete(key);
    }
  }
  while (seenFailures.size > FAILURE_DEDUP_MAX_ENTRIES) {
    const oldest = seenFailures.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    seenFailures.delete(oldest);
  }
  const id = params.messageId?.trim();
  const key = id
    ? `${params.channel}:${params.eventType}:${id}`
    : `${params.channel}:${params.eventType}:sha256:${createHash("sha256")
        .update(JSON.stringify(params.payload) ?? "")
        .digest("hex")}`;
  if (seenFailures.has(key)) {
    return false;
  }
  seenFailures.set(key, now);
  return true;
}

// ── Synchronous send-rejection classification ───────────────────────────────

// Statuses the host gateway retries on its own — waking the agent about them
// too would produce double sends.
const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface SendRejection {
  // Transient/network failure — excluded from the loop; the host retries it.
  retryable: boolean;
  errorCode?: string;
  errorDetail?: string;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function errorDetailRecord(err: unknown): Record<string, unknown> | undefined {
  if (err instanceof InkboxAPIError && err.detail && typeof err.detail === "object") {
    return err.detail as Record<string, unknown>;
  }
  // Test doubles and non-SDK errors may hang the fields off the error itself.
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (record.detail && typeof record.detail === "object") {
      return record.detail as Record<string, unknown>;
    }
    if ("error" in record || "rule" in record || "message" in record) {
      return record;
    }
  }
  return undefined;
}

function statusCodeOf(err: unknown): number | undefined {
  if (err instanceof InkboxAPIError) return err.statusCode;
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    const raw = record.statusCode ?? record.status;
    if (typeof raw === "number") return raw;
  }
  return undefined;
}

/**
 * Classify a thrown send error for the delivery-failure loop.
 *
 * Transient failures stay with the host gateway's retry; the local too-long
 * guard and non-retryable server rejections wake the agent. Surfaces the policy
 * rule slug (e.g. `emoji_overload`) alongside the error code — it names exactly
 * what to fix.
 */
export function classifySendRejection(
  channel: DeliveryFailureChannel,
  err: unknown,
): SendRejection {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const status = statusCodeOf(err);
  // Local length guard (assertSmsTextWithinLimit / assertIMessageTextWithinLimit)
  // throws a plain Error with no status — a fixable, non-retryable rejection.
  if (status === undefined && /maximum is \d+/i.test(message)) {
    return { retryable: false, errorCode: `${channel}_too_long`, errorDetail: message };
  }
  if (status !== undefined && TRANSIENT_STATUS_CODES.has(status)) {
    return { retryable: true };
  }
  const fields = errorDetailRecord(err);
  let errorCode = nonEmpty(fields?.error) ?? (status ? `http_${status}` : undefined);
  const rule = nonEmpty(fields?.rule);
  if (errorCode && rule) {
    errorCode = `${errorCode} rule=${rule}`;
  }
  const errorDetail =
    nonEmpty(fields?.message) ?? nonEmpty(message) ?? "the send was rejected";
  return { retryable: false, errorCode, errorDetail };
}

// ── Normalized webhook failure shape + extractors ───────────────────────────

export interface DeliveryFailure {
  channel: DeliveryFailureChannel;
  eventType: string;
  stage: DeliveryFailureStage;
  direction?: string;
  messageId?: string;
  // RFC 5322 Message-ID; email only, threads a resend under the bounced message.
  rfcMessageId?: string;
  recipient?: string;
  conversationId?: string;
  emailThreadId?: string;
  subject?: string;
  failedBody?: string;
  errorCode?: string;
  errorDetail?: string;
  createdAt?: string;
  raw: unknown;
}

export function textDeliveryFailure(event: TextWebhookPayload): DeliveryFailure | null {
  const message = event.data?.text_message;
  if (!message) return null;
  let errorCode = nonEmpty(message.error_code);
  let errorDetail = nonEmpty(message.error_detail);
  // Group outbound rows carry per-recipient delivery state in recipients[];
  // the legacy 1:1 error fields are NULL there.
  let recipient =
    nonEmpty(event.data.recipient_phone_number) ?? nonEmpty(message.remote_phone_number);
  if (!errorCode && Array.isArray(message.recipients)) {
    const remoteDigits = recipient ? digitsOnly(recipient) : "";
    for (const row of message.recipients) {
      if (!row || !nonEmpty(row.error_code)) continue;
      const rowNumber = String(row.recipient_phone_number ?? "");
      if (remoteDigits && digitsOnly(rowNumber) !== remoteDigits) continue;
      errorCode = nonEmpty(row.error_code);
      errorDetail = nonEmpty(row.error_detail);
      if (!recipient) recipient = nonEmpty(rowNumber);
      break;
    }
  }
  return {
    channel: "sms",
    eventType: event.event_type,
    stage: "delivery_failed",
    direction: nonEmpty(message.direction),
    messageId: nonEmpty(message.id),
    recipient,
    conversationId: nonEmpty(message.conversation_id),
    failedBody: nonEmpty(message.text),
    errorCode,
    errorDetail,
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

export function imessageDeliveryFailure(
  event: IMessageWebhookPayload,
): DeliveryFailure | null {
  const message = event.data?.message;
  if (!message) return null;
  const failedRecipient = message.recipients?.find(
    (row) => row && (row.error_code || row.error_message),
  );
  const errorCode =
    nonEmpty(message.error_code) ?? nonEmpty(failedRecipient?.error_code);
  const errorDetail =
    nonEmpty(message.error_detail) ??
    nonEmpty(message.error_message) ??
    nonEmpty(message.error_reason) ??
    nonEmpty(failedRecipient?.error_message) ??
    nonEmpty(failedRecipient?.error_reason);
  return {
    channel: "imessage",
    eventType: event.event_type,
    stage: "delivery_failed",
    direction: nonEmpty(message.direction),
    messageId: nonEmpty(message.id),
    recipient: nonEmpty(failedRecipient?.remote_number) ?? nonEmpty(message.remote_number),
    conversationId: nonEmpty(message.conversation_id),
    failedBody: nonEmpty(message.content),
    errorCode,
    errorDetail,
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

export function mailDeliveryFailure(event: MailWebhookPayload): DeliveryFailure | null {
  const message = event.data?.message;
  if (!message) return null;
  const to = message.to_addresses?.map((entry) => nonEmpty(entry)).find(Boolean);
  const status = nonEmpty(message.status) ?? event.event_type.split(".").pop();
  const subject = nonEmpty(message.subject);
  return {
    channel: "email",
    eventType: event.event_type,
    stage: event.event_type === "message.bounced" ? "bounced" : "delivery_failed",
    direction: nonEmpty(message.direction),
    messageId: nonEmpty(message.id),
    rfcMessageId: nonEmpty(message.message_id),
    recipient: to,
    emailThreadId: nonEmpty(message.thread_id),
    subject,
    failedBody: nonEmpty(message.snippet) ?? subject,
    // Mail webhooks carry no carrier error detail; the status is the reason.
    errorCode: status,
    errorDetail: to
      ? `The email to ${to}${subject ? ` (subject ${JSON.stringify(subject)})` : ""} was returned as ${status ?? "undeliverable"} by the receiving server.`
      : undefined,
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

// ── The wake-up decision + prompt ───────────────────────────────────────────

export interface DeliveryFailureNoteInput {
  channel: DeliveryFailureChannel;
  stage: DeliveryFailureStage;
  conversationId?: string | null;
  target?: string | null;
  chatId?: string | null;
  contactMarker?: string;
  failedBody?: string;
  errorCode?: string | null;
  errorDetail?: string | null;
  now?: number;
}

export type DeliveryFailureNote =
  | { woke: true; attempts: number; remaining: number; body: string }
  | { woke: false; reason: "no_key" | "capped"; attempts: number };

/**
 * Record a failed send against the shared budget and, unless the budget is
 * exhausted, build the wake-up turn body. Both surfaces funnel here — the
 * caller (session bridge) dispatches the returned body as an inbound turn. The
 * body carries the failure marker, the failure line, the undelivered-body
 * snippet, the per-channel guidance, the attempt accounting, and one
 * classification-specific recovery instruction.
 */
export function noteOutboundDeliveryFailure(
  input: DeliveryFailureNoteInput,
): DeliveryFailureNote {
  const now = input.now ?? Date.now();
  const keys = outboundFailureKeys(input.channel, input.conversationId, input.target, input.chatId);
  if (keys.length === 0) {
    // Nothing stable to count against — an uncapped budget would risk a loop,
    // so treat unkeyable failures as capped (don't wake).
    return { woke: false, reason: "no_key", attempts: 0 };
  }
  const attempts = recordOutboundFailure(keys, now);
  if (attempts >= OUTBOUND_FAILURE_MAX_ATTEMPTS) {
    return { woke: false, reason: "capped", attempts };
  }
  const remaining = OUTBOUND_FAILURE_MAX_ATTEMPTS - attempts;
  const { channel, stage } = input;
  let snippet = (input.failedBody ?? "").trim();
  if (snippet.length > OUTBOUND_FAILURE_BODY_SNIPPET_CHARS) {
    snippet = snippet.slice(0, OUTBOUND_FAILURE_BODY_SNIPPET_CHARS) + "…";
  }
  const errorCode = nonEmpty(input.errorCode);
  const errorDetail = nonEmpty(input.errorDetail);
  const failureLine = [errorCode ? `[${errorCode}]` : "", errorDetail || "the message was not delivered"]
    .filter(Boolean)
    .join(" ");
  const guidance = DELIVERY_FAILURE_CHANNEL_GUIDANCE[channel];
  const classification = classifyDeliveryFailure(errorCode, errorDetail);
  const recoveryInstruction = deliveryFailureReplyInstruction(channel, classification, attempts);
  const target = nonEmpty(input.target);
  const conversationId = nonEmpty(input.conversationId);
  const targetPart = target ? ` to=${target}` : "";
  const conversationPart = conversationId ? ` conversation_id=${conversationId}` : "";
  const contactBlock = input.contactMarker?.trim() || "contact=unknown_in_inkbox";
  const body =
    `[inkbox:delivery_failure channel=${channel} stage=${stage} ` +
    `attempt=${attempts}/${OUTBOUND_FAILURE_MAX_ATTEMPTS}${targetPart}${conversationPart} | ${contactBlock}]\n` +
    `Your outbound ${channel} message was NOT delivered — the recipient never saw it.\n` +
    `Failure: ${failureLine}\n` +
    `Undelivered message:\n` +
    `«${snippet}»\n` +
    `${guidance}\n` +
    `This reply has now failed ${attempts} of ${OUTBOUND_FAILURE_MAX_ATTEMPTS} allowed sends; ` +
    `${remaining} left before the thread goes quiet. Any permitted recovery must be sent as ` +
    `a normal reply in this conversation. Do not mention this delivery problem to the recipient. ` +
    recoveryInstruction;
  return { woke: true, attempts, remaining, body };
}

// Test hook — the module-level stores persist across vitest cases otherwise.
export function resetDeliveryFailureStateForTest(): void {
  outboundFailureState = new Map();
  seenFailures = new Map();
}
