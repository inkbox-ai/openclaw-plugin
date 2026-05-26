import { createInkboxRuntime } from "./client.js";
import { checkOutboundRecipient } from "./allowlist.js";
import { resolveInkboxAccount } from "./accounts.js";

export type InkboxTargetMode = "email" | "sms";

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
    .replace(/^(email:|mailto:)/i, "")
    .replace(/^(sms:|text:|phone:)/i, "");
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
  const normalized = stripKnownPrefix(trimmed);
  if (!normalized) {
    return null;
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
      `Inkbox target must be an email address or E.164 phone number (got ${JSON.stringify(params.to)}).`,
    );
  }
  const block = checkOutboundRecipient(target.value, account.config.allowedRecipients);
  if (block) {
    throw new Error(block);
  }

  const identity = await createInkboxRuntime(account.config).getIdentity();
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
