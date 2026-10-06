import type { SlackRoute } from "./slack.js";

/** Trusted, short-lived source ownership captured by native tool factories. */
export type NativeSource = {
  identityId: string; conversationId: string; replyToMessageId?: string; slackRoute?: SlackRoute;
  author: string; companion?: boolean; closed: boolean; runId?: string; nativeSessionId?: string; marker?: string;
  validate(): Promise<void>;
  beforeSend(callId: string): Promise<void>;
  afterSend(callId: string, messageId: string, text?: string): Promise<void>;
  recordIMessageAccepted?(message: any): Promise<void>;
};
const key = Symbol.for("inkbox.native-source.v1");
const shared = globalThis as typeof globalThis & { [key]?: Map<string, NativeSource> };
const sources = shared[key] ??= new Map<string, NativeSource>();
export function activeNativeSource(sessionKey?: string): NativeSource | undefined { return sessionKey ? sources.get(sessionKey) : undefined; }
export function bindNativeSource(sessionKey: string, source: NativeSource): () => void {
  if (sources.has(sessionKey)) throw new Error("Native source session already has an active owner.");
  sources.set(sessionKey, source);
  return () => { source.closed = true; if (sources.get(sessionKey) === source) sources.delete(sessionKey); };
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
  if (source && !source.closed && context.runId && source.marker && event.prompt?.includes(source.marker)) { source.runId = context.runId; source.nativeSessionId = context.sessionId; }
}
export function guardNativeSourceTool(event: { toolName?: string; params?: Record<string, any> }, context: { sessionKey?: string; runId?: string; sessionId?: string }) {
  const source = [...sources.entries()].find(([sessionKey, value]) => !value.closed && value.runId && value.runId === context.runId && (sessionKey === context.sessionKey || Boolean(value.nativeSessionId && value.nativeSessionId === context.sessionId)))?.[1];
  const name = event.toolName === "tool_call" ? event.params?.name : event.toolName;
  const args = event.toolName === "tool_call" ? event.params?.args : event.params;
  if (source && name === "message" && [undefined, "send", "reply"].includes(args?.action)) return { block: true, blockReason: "Use the source-bound Inkbox send tool for this answer; generic message sends cannot preserve its native source ownership." };
}
