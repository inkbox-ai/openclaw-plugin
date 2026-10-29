import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, rename, readdir, lstat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentIdentity, WhatsAppMessage } from "@inkbox/sdk";
import { InkboxAPIError } from "@inkbox/sdk";
import type { InkboxRuntime } from "./client.js";
import { withFileLock } from "./file-lock.js";
import { contextBuffer } from "./inbound/context-buffer.js";
import { ensureStateDir, statePaths } from "./state.js";

export const WHATSAPP_MAX_BYTES = 20 * 1024 * 1024;
export const WHATSAPP_MEDIA_CACHE_BYTES = 256 * 1024 * 1024;
const MEDIA_RETENTION_MS = 24 * 60 * 60 * 1000;
export const whatsappDeliveryContext = (accountId: string, identityId: string, conversationId: string) =>
  contextBuffer(JSON.stringify(["whatsapp-delivery", accountId, identityId, conversationId]), { retainLatest: true });

async function cacheMedia(directory: string, name: string, bytes: Buffer): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withFileLock(join(directory, ".cache"), { stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 1000 } }, async () => {
    let retainedBytes = 0, retainedFiles = 0;
    for (const filename of await readdir(directory)) {
      if (!/^[a-f0-9]{64}(?:\.[a-f0-9-]+\.tmp)?$/.test(filename)) continue;
      const path = join(directory, filename);
      const info = await lstat(path).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (!info?.isFile()) continue;
      if (info.mtimeMs < Date.now() - MEDIA_RETENTION_MS) {
        await unlink(path).catch((error) => { if (error.code !== "ENOENT") throw error; });
      } else if (filename !== name) { retainedBytes += info.size; retainedFiles++; }
    }
    // Never evict a fresh file another native turn may still be reading.
    if (retainedFiles >= 256 || retainedBytes + bytes.length > WHATSAPP_MEDIA_CACHE_BYTES) throw new Error("WhatsApp local attachment cache is full; media remains available by owned ID.");
    const path = join(directory, name), temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    return path;
  });
}
export const WHATSAPP_EVENTS = [
  "whatsapp.received",
  "whatsapp.reaction_received",
  "whatsapp.sent",
  "whatsapp.delivered",
  "whatsapp.delivery_failed",
  "whatsapp.delivery_unconfirmed",
] as const;
const rejectedSendCodes: Record<number, readonly string[]> = {
  403: ["whatsapp_not_eligible", "whatsapp_access_required", "whatsapp_contact_not_allowed", "whatsapp_media_source_not_allowed"],
  409: ["whatsapp_capability_not_ready", "whatsapp_quote_unavailable", "whatsapp_membership_unresolved", "whatsapp_group_unavailable", "whatsapp_reaction_pending", "whatsapp_reaction_target_unavailable"],
  413: ["whatsapp_media_too_large"],
  422: ["whatsapp_groups_not_supported", "whatsapp_invalid_recipient", "whatsapp_text_too_long", "whatsapp_unanswered_followup_limit", "whatsapp_opening_message_too_long", "whatsapp_reply_required_for_media", "whatsapp_reply_required_for_links", "whatsapp_reply_required_for_phone_numbers", "whatsapp_reply_required_for_email_addresses"],
  429: ["whatsapp_daily_limit_exceeded", "whatsapp_unanswered_message_limit", "whatsapp_conversation_rate_limited", "whatsapp_new_contact_rate_limited", "whatsapp_new_contact_spacing", "whatsapp_follow_up_rate_limited", "whatsapp_new_group_limit", "whatsapp_group_unanswered_limit"],
};
export type WhatsAppSendRejection = { error: string; status_code: number; quota?: string; limit?: number; used?: number; retry_condition?: string; reset_at?: string; retry_after_seconds?: number };
export function whatsappSendRejection(error: unknown): WhatsAppSendRejection | undefined {
  if (!(error instanceof InkboxAPIError) || !error.detail || typeof error.detail !== "object") return;
  const row = error.detail as Record<string, unknown>, code = row.error;
  if (typeof code !== "string" || !rejectedSendCodes[error.statusCode]?.includes(code)) return;
  const policy: WhatsAppSendRejection = { error: code, status_code: error.statusCode };
  if (typeof row.quota === "string" && /^whatsapp\.[a-z0-9_.]{1,120}$/.test(row.quota)) policy.quota = row.quota;
  for (const key of ["limit", "used"] as const) if (Number.isSafeInteger(row[key]) && Number(row[key]) >= 0) policy[key] = Number(row[key]);
  if (typeof row.retry_condition === "string" && ["configuration", "window_reset", "recipient_reply", "recipient_reply_or_shorter_text", "recipient_reply_or_configuration"].includes(row.retry_condition)) policy.retry_condition = row.retry_condition;
  if (typeof row.reset_at === "string" && /^[0-9T:.+Z-]{20,40}$/.test(row.reset_at) && Number.isFinite(Date.parse(row.reset_at))) policy.reset_at = row.reset_at;
  if (Number.isSafeInteger(error.retryAfterSeconds) && Number(error.retryAfterSeconds) >= 0) policy.retry_after_seconds = Number(error.retryAfterSeconds);
  return policy;
}
export const whatsappSendKey = (parts: unknown[]) =>
  `openclaw:whatsapp:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
export function assertWhatsAppText(text: string) {
  if ([...text].length > 4000)
    throw new Error(
      "WhatsApp text must contain at most 4,000 Unicode code points.",
    );
}
export class WhatsAppReadinessPending extends Error {}

export function assertWhatsAppSendKey(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 255 || /[^\x20-\x7e]/.test(value))
    throw new Error("idempotencyKey must be a stable key of 1–255 printable ASCII characters.");
}

const whatsappUuid = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);

export type WhatsAppDestinationEvidence = { identityId: string; conversationId: string; directRecipient?: string };

/** Comparison metadata only; never substitute it for a saved request selector. */
export function whatsappDestinationEvidence(conversation: { id?: string; agentIdentityId: string; isGroup: boolean; participants: string[]; unresolvedParticipantCount?: number }, identityId: string, conversationId: string): WhatsAppDestinationEvidence {
  if (conversation.agentIdentityId !== identityId ||
      (conversation.id !== undefined && conversation.id.toLowerCase() !== conversationId.toLowerCase()) ||
      typeof conversation.isGroup !== "boolean" ||
      !Array.isArray(conversation.participants) || !conversation.participants.length ||
      (!conversation.isGroup && conversation.participants.length !== 1) ||
      conversation.participants.some(number => !/^\+[1-9]\d{6,14}$/.test(number)) ||
      (conversation.unresolvedParticipantCount ?? 0) > 0)
    throw new Error("A resolved conversation owned by this identity is required.");
  return { identityId, conversationId: conversationId.toLowerCase(),
    ...(conversation.isGroup === false && conversation.participants.length === 1 ? { directRecipient: conversation.participants[0]! } : {}) };
}

/** Validate the complete local request before recording a durable send intent. */
export function validateWhatsAppSend(params: { to?: unknown; conversationId?: unknown; replyToMessageId?: unknown; groupName?: unknown; text?: unknown; mediaIds?: unknown; idempotencyKey?: unknown }) {
  if ((params.to !== undefined) === (params.conversationId !== undefined)) throw new Error("Specify exactly one of to or conversationId.");
  const recipients = params.to === undefined ? undefined : whatsappRecipients(params.to);
  if (params.conversationId !== undefined && !whatsappUuid(params.conversationId)) throw new Error("conversationId must be a UUID.");
  if (params.replyToMessageId !== undefined && (!params.conversationId || !whatsappUuid(params.replyToMessageId))) throw new Error("replyToMessageId requires conversationId and a message UUID.");
  if (params.groupName !== undefined && (!recipients || recipients.length < 2 || typeof params.groupName !== "string" || !params.groupName.trim() || [...params.groupName].length > 100)) throw new Error("groupName requires a new group and 1–100 characters.");
  if (params.text !== undefined && typeof params.text !== "string") throw new Error("text must be a string.");
  if (params.mediaIds !== undefined && (!Array.isArray(params.mediaIds) || params.mediaIds.length > 1 || params.mediaIds.some(id => !whatsappUuid(id)))) throw new Error("Provide at most one media UUID.");
  if (!(params.text as string | undefined)?.trim() && !(params.mediaIds as unknown[] | undefined)?.length) throw new Error("Provide text or one owned media ID.");
  assertWhatsAppText(params.text as string ?? "");
  if (params.idempotencyKey !== undefined) assertWhatsAppSendKey(params.idempotencyKey);
}

export async function whatsappReady(
  identity: AgentIdentity,
  expectedId = identity.id,
) {
  if (identity.id !== expectedId)
    throw new Error("The WhatsApp identity changed.");
  const status = await identity.getWhatsAppStatus();
  if (!status?.enabled || status.status !== "ready")
    throw new Error(
      "WhatsApp is not ready. Request access in the Inkbox Console or check current channel status; do not switch channels automatically.",
    );
}
export async function whatsappFile(filePath: string) {
  if (
    typeof filePath !== "string" ||
    !filePath.trim() ||
    /[\x00-\x1f]/.test(filePath) ||
    /^[a-z][a-z\d+.-]*:\/\//i.test(filePath)
  )
    throw new Error(
      "Use a local regular file path for the WhatsApp attachment.",
    );
  const file = await open(filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > WHATSAPP_MAX_BYTES)
      throw new Error(
        "WhatsApp attachments must be regular files of 1 byte–20 MiB.",
      );
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await file.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new Error("The attachment changed while being read.");
    return {
      filename: basename(filePath),
      content: buffer.subarray(0, offset),
    };
  } finally {
    await file.close();
  }
}
/** Download only freshly authorized owned media, without forwarding API credentials. */
export async function whatsappAttachments(
  runtime: InkboxRuntime,
  message: Record<string, any>,
) {
  const identity = await runtime.getIdentity();
  if (message.agent_identity_id !== identity.id)
    throw new Error("WhatsApp attachment identity mismatch.");
  const attachments: Record<string, unknown>[] = [];
  for (const item of (Array.isArray(message.media) ? message.media : []).slice(
    0,
    1,
  )) {
    const metadata = {
      id: item.id,
      filename: item.filename,
      content_type: item.content_type,
      size: item.size,
      status: item.status,
    };
    try {
      const current = await identity.getWhatsAppMedia(item.id);
      if (current.status !== "ready" || !current.url) {
        attachments.push({
          ...metadata,
          status: current.status,
          unavailable: true,
        });
        continue;
      }
      if (
        new URL(current.url).protocol !== "https:" ||
        (current.size ?? 0) > WHATSAPP_MAX_BYTES
      )
        throw new Error("Attachment download is unavailable.");
      const response = await fetch(current.url, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (
        !response.ok ||
        !response.body ||
        Number(response.headers.get("content-length") ?? 0) > WHATSAPP_MAX_BYTES
      )
        throw new Error("Attachment download is unavailable.");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > WHATSAPP_MAX_BYTES)
            throw new Error("Attachment exceeds 20 MiB.");
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      if (size < 1 || (current.size != null && current.size !== size))
        throw new Error("Attachment bytes are incomplete.");
      if ((await runtime.getIdentity()).id !== identity.id)
        throw new Error("The WhatsApp identity changed.");
      await ensureStateDir();
      const directory = join(statePaths().dir, "whatsapp-media");
      const name = createHash("sha256")
        .update(JSON.stringify([identity.id, current.id]))
        .digest("hex");
      const path = await cacheMedia(directory, name, Buffer.concat(chunks));
      attachments.push({ ...metadata, status: "ready", local_path: path });
    } catch {
      attachments.push({
        ...metadata,
        unavailable: true,
        notice:
          "Attachment bytes unavailable; retain the media ID and metadata.",
      });
    }
  }
  if (Array.isArray(message.media) && message.media.length > 1)
    attachments.push({
      status: "unavailable",
      notice:
        "Additional attachment bytes are not supported by this one-attachment version.",
      count: message.media.length - 1,
    });
  return attachments;
}
export function acceptedWhatsApp(message: WhatsAppMessage, idempotencyKey?: string) {
  return {
    messageId: message.id,
    ...(idempotencyKey ? { idempotencyKey } : {}),
    conversationId: message.conversationId,
    status: message.status,
    deliveryState: message.deliveryState,
    note:
      message.status === "uncertain"
        ? "Send unconfirmed. Inspect the original message; do not send another copy."
        : "Accepted is not delivery confirmation. Unknown delivery does not authorize resend.",
  };
}


/** Normalize explicit phone recipients without interpreting a group address as a phone. */
export function whatsappRecipients(value: unknown): string[] {
  const entries = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const normalized = entries.map((entry) => typeof entry === "string" ? entry.replace(/[\s().-]/g, "") : "");
  if (normalized.length < 1 || normalized.length > 8 || normalized.some((number) => !/^\+[1-9]\d{6,14}$/.test(number)) || new Set(normalized).size !== normalized.length)
    throw new Error("Use one through eight unique E.164 recipients.");
  return normalized.sort();
}
