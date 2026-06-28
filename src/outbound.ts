import { createInkboxRuntime } from "./client.js";
import { checkOutboundRecipient } from "./allowlist.js";
import { resolveInkboxAccount } from "./accounts.js";
import { assertIMessageTextWithinLimit } from "./message-limits.js";

export type InkboxTargetMode =
  | "email"
  | "sms"
  | "sms-conversation"
  | "imessage"
  | "imessage-conversation";

export interface ParsedInkboxTarget {
  mode: InkboxTargetMode;
  value: string;
}

export interface InkboxChannelSendParams {
  cfg: unknown;
  accountId?: string | null;
  to: string;
  text: string;
  subject?: string | null;
  threadId?: string | number | null;
  replyToId?: string | number | null;
}

export interface InkboxChannelSendResult {
  messageId: string;
}

function stripKnownPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^(inkbox:)/i, "")
    .replace(/^(sms:conversation:|text:conversation:|phone:conversation:|imessage:conversation:)/i, "")
    .replace(/^(conversation:|thread:)/i, "")
    .replace(/^(email:|mailto:)/i, "")
    .replace(/^(sms:|text:|phone:|imessage:)/i, "");
}

function stripProviderPrefix(raw: string): string {
  return raw.trim().replace(/^(inkbox:)/i, "");
}

function looksLikeConversationId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function normalizeInkboxTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  // iMessage targets keep their channel prefix: a stripped conversation UUID
  // is indistinguishable from an SMS conversation id, so normalizing it away
  // would re-route the send to the wrong channel.
  if (/^imessage:/i.test(stripProviderPrefix(trimmed))) {
    const value = stripKnownPrefix(trimmed);
    return value ? `imessage:${value}` : undefined;
  }
  return stripKnownPrefix(trimmed);
}

export function parseInkboxTarget(raw: string): ParsedInkboxTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const withoutProvider = stripProviderPrefix(trimmed);
  const normalized = stripKnownPrefix(trimmed);
  if (!normalized) {
    return null;
  }
  // iMessage targets are always explicit (`imessage:` prefix). A `+`-shaped
  // value addresses a connected recipient by number; anything else is a
  // conversation id — iMessage rides shared Inkbox-managed numbers, so the
  // conversation is the canonical reply target.
  if (/^imessage:/i.test(withoutProvider)) {
    if (normalized.startsWith("+")) {
      return { mode: "imessage", value: normalized };
    }
    return { mode: "imessage-conversation", value: normalized };
  }
  if (
    /^(conversation:|thread:|sms:conversation:|text:conversation:|phone:conversation:)/i.test(
      withoutProvider,
    ) ||
    (/^(sms:|text:|phone:)/i.test(withoutProvider) &&
      looksLikeConversationId(normalized)) ||
    looksLikeConversationId(normalized)
  ) {
    return { mode: "sms-conversation", value: normalized };
  }
  if (/^(sms:|text:|phone:)/i.test(trimmed) || normalized.startsWith("+")) {
    return { mode: "sms", value: normalized };
  }
  if (/^(email:|mailto:)/i.test(trimmed) || normalized.includes("@")) {
    return { mode: "email", value: normalized };
  }
  return null;
}

function replySubject(subject?: string | null): string | undefined {
  const trimmed = subject?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase().startsWith("re:") ? trimmed : `Re: ${trimmed}`;
}

function fallbackOutboundSubject(
  threadId?: string | number | null,
  replyToId?: string | number | null,
): string {
  if (
    (threadId !== undefined && threadId !== null && String(threadId).trim()) ||
    (replyToId !== undefined && replyToId !== null && String(replyToId).trim())
  ) {
    return "Re: Inkbox message";
  }
  return "Inkbox message";
}

function normalizeEmailThreadId(threadId?: string | number | null): string | undefined {
  if (threadId === undefined || threadId === null) {
    return undefined;
  }
  const raw = String(threadId).trim();
  if (!raw) {
    return undefined;
  }
  const withoutPrefix = raw.replace(/^email:/i, "").trim();
  return looksLikeConversationId(withoutPrefix) ? withoutPrefix : undefined;
}

function normalizeMessageId(messageId?: string | number | null): string | undefined {
  if (messageId === undefined || messageId === null) {
    return undefined;
  }
  const trimmed = String(messageId).trim();
  return trimmed || undefined;
}

function readThreadSubject(thread: any): string | undefined {
  const direct = typeof thread?.subject === "string" ? thread.subject.trim() : "";
  if (direct) {
    return direct;
  }
  if (Array.isArray(thread?.messages)) {
    for (const message of thread.messages) {
      const subject = typeof message?.subject === "string" ? message.subject.trim() : "";
      if (subject) {
        return subject;
      }
    }
  }
  return undefined;
}

async function resolveEmailReplySubject(
  identity: any,
  params: InkboxChannelSendParams,
): Promise<string> {
  const explicit = replySubject(params.subject);
  if (explicit) {
    return explicit;
  }

  const threadId = normalizeEmailThreadId(params.threadId);
  if (threadId && typeof identity.getThread === "function") {
    try {
      const subject = readThreadSubject(await identity.getThread(threadId));
      const resolved = replySubject(subject);
      if (resolved) {
        return resolved;
      }
    } catch {
      // Keep generic message sends best-effort; a failed thread lookup should
      // not prevent the visible reply from being sent.
    }
  }

  const replyToId = normalizeMessageId(params.replyToId);
  if (replyToId && typeof identity.iterEmails === "function") {
    try {
      let checked = 0;
      for await (const message of identity.iterEmails({ pageSize: 25 })) {
        checked += 1;
        if (normalizeMessageId(message?.messageId) === replyToId) {
          const subject = replySubject(message?.subject);
          if (subject) {
            return subject;
          }
          const messageThreadId = normalizeEmailThreadId(message?.threadId);
          if (messageThreadId && typeof identity.getThread === "function") {
            const threadSubject = readThreadSubject(await identity.getThread(messageThreadId));
            const resolved = replySubject(threadSubject);
            if (resolved) {
              return resolved;
            }
          }
          break;
        }
        if (checked >= 100) {
          break;
        }
      }
    } catch {
      // Fall through to the safe generic subject.
    }
  }

  return fallbackOutboundSubject(params.threadId, params.replyToId);
}

export async function sendInkboxChannelText(
  params: InkboxChannelSendParams,
): Promise<InkboxChannelSendResult> {
  const account = resolveInkboxAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  if (!account.configured) {
    throw new Error(`Inkbox account "${account.accountId}" is not configured.`);
  }

  const target = parseInkboxTarget(params.to);
  if (!target) {
    throw new Error(
      `Inkbox target must be an email address, E.164 phone number, or SMS conversation id (got ${JSON.stringify(params.to)}).`,
    );
  }
  if (target.mode === "imessage" || target.mode === "imessage-conversation") {
    assertIMessageTextWithinLimit(params.text);
  }
  if (target.mode === "sms-conversation" || target.mode === "imessage-conversation") {
    if (account.config.allowedRecipients?.length) {
      throw new Error(
        "Cannot send to a conversation id while allowedRecipients is configured; recipients cannot be locally verified.",
      );
    }
  } else {
    const block = checkOutboundRecipient(target.value, account.config.allowedRecipients);
    if (block) {
      throw new Error(block);
    }
  }

  const identity = await createInkboxRuntime(account.config).getIdentity();
  if (target.mode === "sms-conversation") {
    const msg = await identity.sendText({
      conversationId: target.value,
      text: params.text,
    });
    return { messageId: msg.id };
  }
  if (target.mode === "sms") {
    const msg = await identity.sendText({ to: target.value, text: params.text });
    return { messageId: msg.id };
  }
  // Recipient-first channel: sends only work toward people already connected
  // to this identity through the Inkbox iMessage router. Server-side gates
  // surface as thrown API errors.
  if (target.mode === "imessage-conversation") {
    const msg = await identity.sendIMessage({
      conversationId: target.value,
      text: params.text,
    });
    return { messageId: msg.id };
  }
  if (target.mode === "imessage") {
    const msg = await identity.sendIMessage({ to: target.value, text: params.text });
    return { messageId: msg.id };
  }

  const msg = await identity.sendEmail({
    to: [target.value],
    subject: await resolveEmailReplySubject(identity, params),
    bodyText: params.text,
    inReplyToMessageId:
      params.replyToId !== undefined && params.replyToId !== null
        ? String(params.replyToId)
        : undefined,
  });
  return { messageId: msg.id };
}
