import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { InkboxAPIError, IdempotencyKeyReusedError, type Inkbox, type SlackOperation } from "@inkbox/sdk";
import type { NativeSource } from "./native-source.js";
import { assertNativeSource } from "./native-source.js";
import { ownSlackConnection, type SlackRoute } from "./slack.js";

export const SLACK_MAX_FILE_BYTES = 10 * 1024 * 1024;
export type SlackFileOptions = { filePath: string; filename?: string; title?: string; initialComment?: string };
export type SlackUploadIntent = { idempotencyKey: string; connectionId: string; conversationId: string; workspaceId: string; automatic: boolean; fingerprint: string };
export type SlackUploadReceipt = { deduplicated?: boolean; connectionId?: string; conversationId?: string; id: string; status: "in_progress" | "succeeded" | "failed" | "unknown"; fileId?: string | null };

/** Bounded local bytes only: a filename or a model's claim is not an upload. */
export async function slackFilePayload(options: SlackFileOptions) {
  if (typeof options.filePath !== "string" || !options.filePath.trim() || /[\x00-\x1f]/.test(options.filePath) || /^[a-z][a-z\d+.-]*:\/\//i.test(options.filePath)) throw new Error("Slack filePath must be a local file path, not a URL.");
  const filename = options.filename ?? basename(options.filePath);
  if (!filename || [".", ".."].includes(filename) || /[\\/\x00-\x1f\x7f]/.test(filename) || [...filename].length > 255) throw new Error("Slack filename must be a plain filename of at most 255 characters.");
  for (const [name, value, max] of [["title", options.title, 255], ["initialComment", options.initialComment, 12_000]] as const) {
    if (value !== undefined && (typeof value !== "string" || value.includes("\0") || [...value].length > max)) throw new Error(`Invalid Slack ${name}.`);
  }
  const file = await open(options.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 1 || info.size > SLACK_MAX_FILE_BYTES) throw new Error("Slack uploads require a regular file of 1 byte–10 MiB.");
    const buffer = Buffer.alloc(Math.min(info.size + 1, SLACK_MAX_FILE_BYTES + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await file.read(buffer, offset, buffer.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    // Do not silently upload a changed/truncated prefix after the initial stat.
    const after = await file.stat();
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error("Slack upload file changed while being read.");
    bytes = buffer.subarray(0, offset);
  } finally { await file.close(); }
  return { filename, contentBase64: bytes.toString("base64"), ...(options.title !== undefined ? { title: options.title } : {}), ...(options.initialComment !== undefined ? { initialComment: options.initialComment } : {}) };
}

export function slackUploadFingerprint(connectionId: string, conversationId: string, threadTs: string | null | undefined, payload: { contentBase64: string }): string {
  return createHash("sha256").update(JSON.stringify([connectionId, conversationId, threadTs ?? null, payload.contentBase64])).digest("hex");
}

export function checkedSlackUpload(operation: SlackOperation, connectionId: string, conversationId?: string): SlackUploadReceipt {
  if (!operation || operation.operation !== "file_upload" || operation.connectionId !== connectionId ||
      (conversationId !== undefined && operation.conversationId !== conversationId) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operation.id) ||
      !["in_progress", "succeeded", "failed", "unknown"].includes(operation.status) ||
      (operation.status === "succeeded" && !operation.fileId)) throw new Error("Slack upload outcome could not be confirmed; do not resend.");
  return { connectionId: operation.connectionId, conversationId: operation.conversationId ?? undefined, id: operation.id, status: operation.status as SlackUploadReceipt["status"], fileId: operation.fileId };
}

/** Only typed pre-dispatch rejections prove this request had no effect. */
export async function recordSlackUploadRejection(source: NativeSource | undefined, callId: string, error: unknown) {
  if (error instanceof IdempotencyKeyReusedError || (error instanceof InkboxAPIError && [400, 401, 403, 404, 413, 422].includes(error.statusCode))) await source?.rejectUpload?.(callId);
}

export async function uploadSlackSourceFile(client: Inkbox, source: NativeSource, route: SlackRoute, options: SlackFileOptions, callId: string, explicitKey?: string, automatic = false) {
  assertNativeSource(source, route.identityId);
  const payload = await slackFilePayload(options);
  const connection = await ownSlackConnection(client, route.identityId, route.connectionId, route.connectionGeneration);
  if (connection.workspaceId !== route.workspaceId) throw new Error("Slack upload workspace changed.");
  if (source.validateUpload) await source.validateUpload(automatic);
  else await source.validate();
  assertNativeSource(source, route.identityId);
  const idempotencyKey = explicitKey ?? `openclaw:file:${createHash("sha256").update(JSON.stringify([route.sourceEventId, route.connectionId, route.conversationId, route.threadTs, callId, payload])).digest("hex")}`;
  if (source.beforeUpload) {
    const cached = await source.beforeUpload(callId, { idempotencyKey, automatic, connectionId: route.connectionId, conversationId: route.conversationId, workspaceId: route.workspaceId, fingerprint: slackUploadFingerprint(route.connectionId, route.conversationId, route.threadTs, payload) });
    if (cached) return cached;
  } else await source.beforeSend(callId);
  assertNativeSource(source, route.identityId);
  let operation: SlackOperation;
  try { operation = await client.slack.uploadFile(route.connectionId, { ...payload, conversationId: route.conversationId, threadTs: route.threadTs, idempotencyKey }); }
  catch (error) { await recordSlackUploadRejection(source, callId, error); throw error; }
  let receipt = checkedSlackUpload(operation, route.connectionId, route.conversationId);
  if (source.afterUpload) await source.afterUpload(callId, receipt);
  else if (receipt.status === "succeeded") await source.afterSend(callId, receipt.id);
  // Accepted work is inspected, never re-posted. Preserve every observed outcome first.
  for (let attempt = 0; automatic && receipt.status === "in_progress" && attempt < 4; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      receipt = checkedSlackUpload(await client.slack.getOperation(route.connectionId, receipt.id), route.connectionId, route.conversationId);
      await source.afterUpload?.(callId, receipt);
    } catch { break; }
  }
  return receipt;
}
