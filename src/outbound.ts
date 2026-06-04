import { createInkboxRuntime } from "./client.js";
import { checkOutboundRecipient } from "./allowlist.js";
import { resolveInkboxAccount } from "./accounts.js";

export type InkboxTargetMode = "email" | "sms" | "sms-conversation";

export interface ParsedInkboxTarget {
  mode: InkboxTargetMode;
  value: string;
}

export interface InkboxChannelSendParams {
  cfg: unknown;
  accountId?: string | null;
  to: string;
  text: string;
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
    .replace(/^(sms:conversation:|text:conversation:|phone:conversation:)/i, "")
    .replace(/^(conversation:|thread:)/i, "")
    .replace(/^(email:|mailto:)/i, "")
    .replace(/^(sms:|text:|phone:)/i, "");
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

function outboundSubject(threadId?: string | number | null): string {
  if (threadId !== undefined && threadId !== null && String(threadId).trim()) {
    return "Re: Inkbox message";
  }
  return "Inkbox message";
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
  if (target.mode === "sms-conversation") {
    if (account.config.allowedRecipients?.length) {
      throw new Error(
        "Cannot send to an SMS conversation id while allowedRecipients is configured; recipients cannot be locally verified.",
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

  const msg = await identity.sendEmail({
    to: [target.value],
    subject: outboundSubject(params.threadId),
    bodyText: params.text,
    inReplyToMessageId:
      params.replyToId !== undefined && params.replyToId !== null
        ? String(params.replyToId)
        : undefined,
  });
  return { messageId: msg.id };
}
