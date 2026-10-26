import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { AgentIdentity, WhatsAppMessage } from "@inkbox/sdk";
import type { InkboxRuntime } from "./client.js";
import { ensureStateDir, statePaths } from "./state.js";

export const WHATSAPP_MAX_BYTES = 20 * 1024 * 1024;
export const WHATSAPP_EVENTS = [
  "whatsapp.received",
  "whatsapp.sent",
  "whatsapp.delivered",
  "whatsapp.delivery_failed",
  "whatsapp.delivery_unconfirmed",
] as const;
export const whatsappSendKey = (parts: unknown[]) =>
  `openclaw:whatsapp:${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
export function assertWhatsAppText(text: string) {
  if ([...text].length > 4000)
    throw new Error(
      "WhatsApp text must contain at most 4,000 Unicode code points.",
    );
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
      if ((await runtime.getIdentity()).id !== identity.id)
        throw new Error("The WhatsApp identity changed.");
      await ensureStateDir();
      const directory = join(statePaths().dir, "whatsapp-media");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const name = createHash("sha256")
        .update(JSON.stringify([identity.id, current.id]))
        .digest("hex");
      const path = join(directory, name),
        temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(Buffer.concat(chunks));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, path);
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
export function acceptedWhatsApp(message: WhatsAppMessage) {
  return {
    messageId: message.id,
    conversationId: message.conversationId,
    status: message.status,
    deliveryState: message.deliveryState,
    note:
      message.status === "uncertain"
        ? "Send unconfirmed. Inspect the original message; do not send another copy."
        : "Accepted is not delivery confirmation. Unknown delivery does not authorize resend.",
  };
}
