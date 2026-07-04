// Failed outbound delivery recovery (fleet standard, issue #22).
//
// Outbound SMS/iMessage/email sends can queue successfully and then fail
// later via an async delivery webhook, after the agent has gone idle. The
// pieces here let the inbound session bridge turn a hard failure event back
// into an agent turn on the original thread:
//
//   - an outbound-context store (same in-process seam as channel-hint and
//     outbound-call-context) records what each send was, keyed by the Inkbox
//     message id every send returns, so a failure webhook can be correlated
//     back to the conversation even when the webhook payload is sparse;
//   - a failure dedup keyed by channel + event type + message id, so webhook
//     re-deliveries of the same failure don't spawn duplicate recovery turns;
//   - a per-contact recovery cap, so a permanently dead channel can't keep
//     waking the agent forever;
//   - payload extractors that normalize the three channels' failure webhooks
//     into one shape, and the prompt shown to the woken agent.

import { createHash } from "node:crypto";
import type {
  IMessageWebhookPayload,
  MailWebhookPayload,
  TextWebhookPayload,
} from "@inkbox/sdk";

export type DeliveryFailureChannel = "sms" | "imessage" | "email";

// The hard failure events that wake the agent. `text.delivery_unconfirmed`
// is deliberately absent: it signals status uncertainty (telemetry), not a
// failed delivery, and must never trigger a recovery turn.
export const DELIVERY_FAILURE_EVENT_TYPES: readonly string[] = [
  "text.delivery_failed",
  "imessage.delivery_failed",
  "message.bounced",
  "message.failed",
];

// Context recorded when an outbound send queues successfully. Everything is
// optional except the channel — a failure webhook fills gaps from its own
// payload, and vice versa.
export interface OutboundDeliveryContext {
  channel: DeliveryFailureChannel;
  contactKey?: string;
  recipient?: string;
  body?: string;
  conversationId?: string;
  emailThreadId?: string;
  subject?: string;
  // Set when the send itself was a recovery turn's reply. A failure of a
  // recovery send must not spawn another recovery turn (loop guard).
  recovery?: boolean;
}

type StoredOutboundContext = OutboundDeliveryContext & { recordedAt: number };

// Email bounces can arrive hours after the send; carrier SMS failures within
// minutes. Bound both by TTL and by entry count so a chatty agent can't grow
// the map without limit (Map iteration order is insertion order, so the
// first key is always the oldest).
const OUTBOUND_CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const OUTBOUND_CONTEXT_MAX_ENTRIES = 2000;
const outboundContexts = new Map<string, StoredOutboundContext>();

const BODY_SNIPPET_MAX_CHARS = 500;

function pruneOutboundContexts(now = Date.now()): void {
  for (const [id, ctx] of outboundContexts) {
    if (now - ctx.recordedAt > OUTBOUND_CONTEXT_TTL_MS) {
      outboundContexts.delete(id);
    }
  }
  while (outboundContexts.size > OUTBOUND_CONTEXT_MAX_ENTRIES) {
    const oldest = outboundContexts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    outboundContexts.delete(oldest);
  }
}

export function recordOutboundDelivery(
  messageId: string | undefined,
  context: OutboundDeliveryContext,
): void {
  const id = messageId?.trim();
  if (!id) {
    return;
  }
  pruneOutboundContexts();
  outboundContexts.set(id, {
    ...context,
    body: context.body?.slice(0, BODY_SNIPPET_MAX_CHARS),
    recordedAt: Date.now(),
  });
}

// Look the failed message up by any of the ids the webhook may carry (email
// events carry both the Inkbox row id and the RFC 5322 Message-ID).
export function lookupOutboundDelivery(
  ...messageIds: Array<string | undefined>
): OutboundDeliveryContext | undefined {
  pruneOutboundContexts();
  for (const raw of messageIds) {
    const id = raw?.trim();
    if (!id) continue;
    const ctx = outboundContexts.get(id);
    if (ctx) return ctx;
  }
  return undefined;
}

// Failure webhooks are re-delivered with fresh request ids, so the HTTP-level
// request-id dedup does not catch them. Dedup on what the event MEANS:
// channel + event type + failed message id, with a payload hash standing in
// when no id is present.
const FAILURE_DEDUP_TTL_MS = 30 * 60 * 1000;
const FAILURE_DEDUP_MAX_ENTRIES = 1000;
const seenFailures = new Map<string, number>();

function pruneSeenFailures(now = Date.now()): void {
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
}

// Returns true when this failure is new and should be handled; false for a
// repeat delivery of one already handled.
export function claimDeliveryFailure(params: {
  channel: DeliveryFailureChannel;
  eventType: string;
  messageId?: string;
  payload: unknown;
}): boolean {
  const id = params.messageId?.trim();
  const key = id
    ? `${params.channel}:${params.eventType}:${id}`
    : `${params.channel}:${params.eventType}:sha256:${createHash("sha256")
        .update(JSON.stringify(params.payload) ?? "")
        .digest("hex")}`;
  pruneSeenFailures();
  if (seenFailures.has(key)) {
    return false;
  }
  seenFailures.set(key, Date.now());
  return true;
}

// Cap recovery turns per contact in a sliding window. Correlation and dedup
// stop individual repeats; this stops the pathological case — a channel that
// fails every send would otherwise wake the agent once per retry, forever.
const RECOVERY_WINDOW_MS = 10 * 60 * 1000;
const MAX_RECOVERIES_PER_WINDOW = 3;
const recoveryTimestamps = new Map<string, number[]>();

// Returns true (and records the attempt) when another recovery turn is
// allowed for this contact; false once the window cap is reached.
export function claimRecoveryAttempt(contactKey: string): boolean {
  const now = Date.now();
  const cutoff = now - RECOVERY_WINDOW_MS;
  for (const [key, stamps] of recoveryTimestamps) {
    const recent = stamps.filter((at) => at > cutoff);
    if (recent.length === 0) {
      recoveryTimestamps.delete(key);
    } else {
      recoveryTimestamps.set(key, recent);
    }
  }
  const recent = recoveryTimestamps.get(contactKey) ?? [];
  if (recent.length >= MAX_RECOVERIES_PER_WINDOW) {
    return false;
  }
  recent.push(now);
  recoveryTimestamps.set(contactKey, recent);
  return true;
}

// One normalized shape for the three channels' failure webhooks.
export interface DeliveryFailure {
  channel: DeliveryFailureChannel;
  eventType: string;
  // Inkbox row id of the failed outbound message (correlation key).
  messageId?: string;
  // RFC 5322 Message-ID; email only, secondary correlation key.
  rfcMessageId?: string;
  recipient?: string;
  conversationId?: string;
  emailThreadId?: string;
  subject?: string;
  body?: string;
  reason?: string;
  createdAt?: string;
  raw: unknown;
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function textDeliveryFailure(event: TextWebhookPayload): DeliveryFailure | null {
  const message = event.data?.text_message;
  if (!message) {
    return null;
  }
  const reason =
    [nonEmpty(message.error_detail), nonEmpty(message.error_code)]
      .filter(Boolean)
      .join(" ") || undefined;
  return {
    channel: "sms",
    eventType: event.event_type,
    messageId: nonEmpty(message.id),
    // Group lifecycle events name the specific recipient the event is about.
    recipient:
      nonEmpty(event.data.recipient_phone_number) ?? nonEmpty(message.remote_phone_number),
    conversationId: nonEmpty(message.conversation_id),
    body: nonEmpty(message.text),
    reason,
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

export function imessageDeliveryFailure(
  event: IMessageWebhookPayload,
): DeliveryFailure | null {
  const message = event.data?.message;
  if (!message) {
    return null;
  }
  // Message-level error fields first; group sends carry them per recipient.
  const failedRecipient = message.recipients?.find(
    (entry) => entry.error_message || entry.error_reason || entry.error_detail || entry.error_code,
  );
  const reason =
    nonEmpty(message.error_message) ??
    nonEmpty(message.error_reason) ??
    nonEmpty(message.error_detail) ??
    nonEmpty(message.error_code) ??
    nonEmpty(failedRecipient?.error_message) ??
    nonEmpty(failedRecipient?.error_reason) ??
    nonEmpty(failedRecipient?.error_detail) ??
    nonEmpty(failedRecipient?.error_code);
  return {
    channel: "imessage",
    eventType: event.event_type,
    messageId: nonEmpty(message.id),
    recipient: nonEmpty(failedRecipient?.remote_number) ?? nonEmpty(message.remote_number),
    conversationId: nonEmpty(message.conversation_id),
    body: nonEmpty(message.content),
    reason,
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

export function mailDeliveryFailure(event: MailWebhookPayload): DeliveryFailure | null {
  const message = event.data?.message;
  if (!message) {
    return null;
  }
  return {
    channel: "email",
    eventType: event.event_type,
    messageId: nonEmpty(message.id),
    rfcMessageId: nonEmpty(message.message_id),
    recipient: message.to_addresses?.map((entry) => nonEmpty(entry)).find(Boolean),
    emailThreadId: nonEmpty(message.thread_id),
    subject: nonEmpty(message.subject),
    body: nonEmpty(message.snippet),
    // Mail webhooks carry no error detail; the event type is the reason.
    reason: event.event_type === "message.bounced" ? "bounced" : "failed",
    createdAt: nonEmpty(message.created_at) ?? nonEmpty(event.timestamp),
    raw: event,
  };
}

const CHANNEL_LABELS: Record<DeliveryFailureChannel, string> = {
  sms: "SMS",
  imessage: "iMessage",
  email: "email",
};

// The recovery turn's body (below the channel marker the session bridge
// prepends). The reply to this turn is delivered on the failed channel and
// thread by default, so the instructions spell out the three ways out:
// reword and retry, switch channel via tools, or exactly [SILENT].
export function buildDeliveryFailurePrompt(params: {
  channel: DeliveryFailureChannel;
  recipientLabel: string;
  reason?: string;
  body?: string;
}): string {
  const label = CHANNEL_LABELS[params.channel];
  const lines = [
    `Your earlier ${label} to ${params.recipientLabel} was NOT delivered` +
      `${params.reason ? ` (reason: ${params.reason})` : ""}.`,
  ];
  if (params.body) {
    lines.push("The message that failed:", `"""`, params.body, `"""`);
  }
  lines.push(
    "Decide how to recover. Your reply to this message is sent to the same recipient on the same channel and thread by default:",
    "- reply with a revised message (you may reword or shorten it) to retry on this channel",
    "- or use your messaging tools to reach them on a different channel instead",
    "- or reply exactly [SILENT] to do nothing visible.",
  );
  return lines.join("\n");
}

// Test hook — the module-level stores persist across vitest cases otherwise.
export function resetDeliveryFailureStateForTest(): void {
  outboundContexts.clear();
  seenFailures.clear();
  recoveryTimestamps.clear();
}
