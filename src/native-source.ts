import { type WhatsAppSendRejection, type WhatsAppDestinationEvidence } from "./whatsapp.js";
import type { SlackRoute } from "./slack.js";
import type { SlackUploadReceipt, SlackUploadIntent } from "./slack-files.js";

export type WhatsAppSendIntent = { idempotencyKey: string; text?: string; mediaIds?: string[]; replyToMessageId?: string; destinationEvidence?: WhatsAppDestinationEvidence; destination?: { conversationId?: string; to?: string } };

/** Trusted, short-lived source ownership captured by native tool factories. */
export type NativeSource = {
  replyChannel?: "email" | "sms"; replySourceId?: string; replyRoute?: string;
  whatsapp?: boolean; whatsappGroup?: boolean; sourceMessageId?: string;
  identityId: string; conversationId: string; replyToMessageId?: string; slackRoute?: SlackRoute;
  author: string; companion?: boolean; closed: boolean; runId?: string; nativeSessionId?: string; marker?: string;
  validate(): Promise<void>;
  validateUpload?(automatic: boolean, ownCallId?: string): Promise<void>;
  whatsappMediaUpload?(fingerprint: string, prepare: () => Promise<() => Promise<string>>): Promise<string>;
  whatsappReplyTarget?(idempotencyKey: string): Promise<string | undefined>;
  whatsappReplyDestination?(idempotencyKey: string): Promise<WhatsAppSendIntent["destination"]>;
  beforeSend(callId: string, intent?: WhatsAppSendIntent, automatic?: boolean): Promise<void>;
  afterSend(callId: string, messageId: string, text?: string, uncertain?: boolean, conversationId?: string): Promise<void>;
  rejectSend?(callId: string, idempotencyKey: string, policy: WhatsAppSendRejection): Promise<void>;
  progress?(update: { tool: string; id: string; status: "running" | "completed" | "error" }): void;
  afterUpload?(callId: string, receipt: SlackUploadReceipt): Promise<void>;
  rejectUpload?(callId: string): Promise<void>;
  inspectUpload?(receipt: SlackUploadReceipt): Promise<void>;
  beforeUpload?(callId: string, intent: SlackUploadIntent): Promise<SlackUploadReceipt | undefined>;
  uploadCalls?: Set<string>;
  recordIMessageAccepted?(message: any): Promise<void>;
};
const key = Symbol.for("inkbox.native-source.v1");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, NativeSource> };
const sources = shared[key] ??= new Map<string, NativeSource>();
export function activeNativeSource(sessionKey?: string): NativeSource | undefined { return sessionKey ? sources.get(sessionKey) : undefined; }
const waitKey = Symbol.for("inkbox.native-source-waiters.v1");
const sharedWaiters = globalThis as typeof globalThis & { [waitKey]?: Map<string, Set<() => void>> };
const waiters = sharedWaiters[waitKey] ??= new Map<string, Set<() => void>>();
export async function acquireNativeSource(sessionKey: string, source: NativeSource, signal?: AbortSignal): Promise<() => void> {
  while (sources.has(sessionKey)) {
    signal?.throwIfAborted();
    const queue = waiters.get(sessionKey) ?? new Set<() => void>();
    if (queue.size >= 8) throw new Error("The incoming conversation queue is full.");
    waiters.set(sessionKey, queue);
    let wake!: () => void;
    const waiting = new Promise<void>(resolve => { wake = resolve; });
    queue.add(wake); signal?.addEventListener("abort", wake, { once: true });
    try { await waiting; } finally { queue.delete(wake); signal?.removeEventListener("abort", wake); if (!queue.size) waiters.delete(sessionKey); }
  }
  signal?.throwIfAborted();
  return bindNativeSource(sessionKey, source);
}
export function bindNativeSource(sessionKey: string, source: NativeSource): () => void {
  if (sources.has(sessionKey)) throw new Error("Native source session already has an active owner.");
  sources.set(sessionKey, source);
  return () => { source.closed = true; if (sources.get(sessionKey) === source) { sources.delete(sessionKey); for (const wake of waiters.get(sessionKey) ?? []) wake(); } };
}
export function assertNativeSource(source: NativeSource, identityId: string): void {

  if (source.closed || source.identityId !== identityId) throw new Error("The native reply source is no longer active.");
}
export function revokeNativeSourceRun(sessionKey: string, runId: string): void {
  const source = sources.get(sessionKey);
  if (source?.runId === runId) source.closed = true;
}

export function bindNativeSourceRun(event: { prompt?: string }, context: { sessionKey?: string; runId?: string; sessionId?: string }) {
  const source = activeNativeSource(context.sessionKey);
  if (source && !source.closed && !source.runId && context.runId && source.marker && event.prompt?.includes(source.marker)) { source.runId = context.runId; source.nativeSessionId = context.sessionId; }
}
export function guardNativeSourceTool(event: { toolName?: string; params?: Record<string, any> }, context: { sessionKey?: string; runId?: string; sessionId?: string }) {
  const source = [...sources.entries()].find(([sessionKey, value]) => !value.closed && value.runId && value.runId === context.runId && (sessionKey === context.sessionKey || Boolean(value.nativeSessionId && value.nativeSessionId === context.sessionId)))?.[1];
  const name = ["tool_call", "dispatch_action"].includes(event.toolName ?? "") ? (event.params?.id ?? event.params?.name) : event.toolName;
  const args = ["tool_call", "dispatch_action"].includes(event.toolName ?? "") ? event.params?.args : event.params;
  if (source && name === "message" && [undefined, "send", "reply"].includes(args?.action)) return { block: true, blockReason: "Use the source-bound Inkbox send tool for this answer; generic message sends cannot preserve its native source ownership." };
}

/** Progress requires the same proven run binding as source-owned tools. */
export function recordNativeSourceProgress(event: { toolName?: string; toolCallId?: string; error?: unknown; result?: unknown }, context: { sessionKey?: string; sessionId?: string; runId?: string; toolCallId?: string }, finished = false) {
  const id = event.toolCallId ?? context.toolCallId;
  if (!context.runId || !id || !event.toolName) return;
  const matches = [...sources.entries()].filter(([sessionKey, source]) => !source.closed && source.runId === context.runId && (sessionKey === context.sessionKey || Boolean(source.nativeSessionId && source.nativeSessionId === context.sessionId)));
  if (matches.length !== 1) return;
  const owner = matches[0]![1];
  if (event.toolName === "inkbox_slack_upload_file") {
    owner.uploadCalls ??= new Set();
    if (finished) owner.uploadCalls.delete(id); else owner.uploadCalls.add(id);
  }
  const failed = Boolean(event.error) || Boolean(event.result && typeof event.result === "object" && (event.result as { isError?: unknown }).isError === true);
  matches[0]![1].progress?.({ tool: event.toolName, id, status: finished ? failed ? "error" : "completed" : "running" });
}
