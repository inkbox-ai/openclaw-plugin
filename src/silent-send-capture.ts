import { randomUUID } from "node:crypto";
import { transformInkboxReplyPayload } from "./silent-reply.js";

type Context = { sessionKey?: string; runId?: string; toolCallId?: string };
type Event = { runId?: string; toolCallId?: string; toolName?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
type Capture = { sessionKey: string; marker: string; runId?: string; closed: boolean; batchStarted: boolean; invalid: boolean; attempts: Map<string, boolean> };
const captures = new Set<Capture>();
const sendTools = new Set(["inkbox_send_sms", "inkbox_send_email", "inkbox_send_imessage", "inkbox_forward_email"]);

function matching(event: Event, context: Context): Capture[] {
  const runId = event.runId ?? context.runId;
  if (!runId || !context.sessionKey) return [];
  return [...captures].filter((capture) => !capture.closed && capture.sessionKey === context.sessionKey && capture.runId === runId);
}

/** Scope explicit successful send completion to one dispatch, never the session. */
export function beginSilentSendCapture(sessionKey: string) {
  const capture: Capture = { sessionKey, marker: `[Inkbox turn correlation: ${randomUUID()}]`, closed: false, batchStarted: false, invalid: false, attempts: new Map() };
  return {
    marker: capture.marker,
    activate() { if (!capture.closed) captures.add(capture); },
    transform<T extends { text?: string; media?: unknown; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean }>(payload: T): T | null {
      // Preserve errors and attachments. No text matching or fabricated delivery:
      // an entirely successful, explicitly final tool batch authorizes silence.
      if (!capture.closed && capture.batchStarted && !capture.invalid && capture.attempts.size > 0 && [...capture.attempts.values()].every(Boolean) && !payload.isError && !payload.media && !payload.mediaUrl && !payload.mediaUrls?.length) return null;
      return transformInkboxReplyPayload(payload);
    },
    shape() { return { bound: Boolean(capture.runId), batch: capture.batchStarted, attempts: capture.attempts.size, accepted: [...capture.attempts.values()].filter(Boolean).length, invalid: capture.invalid }; },
    finish() { capture.closed = true; captures.delete(capture); },
  };
}

export function bindSilentSendCaptureToRun(event: { prompt?: string }, context: Context): void {
  if (!context.runId || !context.sessionKey || typeof event.prompt !== "string") return;
  for (const capture of captures) {
    if (!capture.closed && !capture.runId && capture.sessionKey === context.sessionKey && event.prompt.includes(capture.marker)) capture.runId = context.runId;
  }
}

export function recordSilentSendModelStarted(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    capture.batchStarted = true;
    capture.invalid = false;
    capture.attempts.clear();
  }
}

export function recordSilentSendBeforeToolCall(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    const id = event.toolCallId ?? context.toolCallId;
    if (!capture.batchStarted || !id || capture.attempts.has(id)) { capture.invalid = true; continue; }
    capture.attempts.set(id, false);
    if (!sendTools.has(event.toolName ?? "") || event.params?.completeSilently !== true) capture.invalid = true;
  }
}

export function recordSilentSendAfterToolCall(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    const id = event.toolCallId ?? context.toolCallId;
    const result = event.result as { terminate?: unknown; isError?: unknown; details?: { inkboxSendCompletion?: { accepted?: unknown; completeSilently?: unknown } } } | undefined;
    const receipt = result?.details?.inkboxSendCompletion;
    if (!id || !capture.attempts.has(id) || !sendTools.has(event.toolName ?? "") || event.params?.completeSilently !== true || event.error || result?.isError === true || result?.terminate !== true || receipt?.accepted !== true || receipt?.completeSilently !== true) {
      capture.invalid = true;
      continue;
    }
    capture.attempts.set(id, true);
  }
}
