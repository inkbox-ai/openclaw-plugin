import { randomUUID } from "node:crypto";
import { transformInkboxReplyPayload } from "./silent-reply.js";

type Context = { sessionKey?: string; runId?: string; toolCallId?: string };
type Event = {
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type Attempt = { name: string; accepted: boolean; wrapper: boolean };
type Capture = {
  sessionKey: string;
  marker: string;
  runId?: string;
  closed: boolean;
  batchStarted: boolean;
  invalid: boolean;
  attempts: Map<string, Attempt>;
};
type Result = {
  terminate?: unknown;
  isError?: unknown;
  details?: {
    inkboxSendCompletion?: { accepted?: unknown; completeSilently?: unknown };
    tool?: { name?: unknown };
    result?: unknown;
  };
};
const captures = new Set<Capture>();
const sendTools = new Set([
  "inkbox_send_sms", "inkbox_send_email", "inkbox_send_imessage", "inkbox_forward_email",
]);
const transportTools = new Set(["tool_call", "tool_search_code"]);

function matching(event: Event, context: Context): Capture[] {
  const runId = event.runId ?? context.runId;
  if (!runId || !context.sessionKey) return [];
  return [...captures].filter((capture) =>
    !capture.closed && capture.sessionKey === context.sessionKey && capture.runId === runId,
  );
}

function acceptedSendResult(value: unknown): boolean {
  const result = value as Result | undefined;
  const receipt = result?.details?.inkboxSendCompletion;
  return result?.terminate === true && result.isError !== true &&
    receipt?.accepted === true && receipt.completeSilently === true;
}

// This host-generated ID links nested lifecycle events to their transport call.
// It is never evidence of API acceptance; both lifecycle results are required.
function parentIdSegment(id: string): string {
  return id.trim().replace(/[^A-Za-z0-9_.:-]+/g, "_").slice(0, 120) || "call";
}

function acceptedWrapper(
  capture: Capture, id: string, attempt: Attempt, event: Event, result: Result,
): boolean {
  const parent = parentIdSegment(id);
  const wrappers = [...capture.attempts].filter(([, value]) => value.wrapper);
  if (wrappers.filter(([key]) => parentIdSegment(key) === parent).length !== 1) return false;
  const children = [...capture.attempts].filter(([key, child]) => {
    if (child.wrapper || !sendTools.has(child.name)) return false;
    const prefix = `tool_search_code:${parent}:${child.name}:`;
    return key.startsWith(prefix) && /^[1-9]\d*$/.test(key.slice(prefix.length));
  });
  if (!children.length || children.some(([, child]) => !child.accepted)) return false;
  if (attempt.name === "tool_call") {
    const args = event.params?.args as Record<string, unknown> | undefined;
    return children.length === 1 && args?.completeSilently === true &&
      result.details?.tool?.name === children[0][1].name &&
      acceptedSendResult(result.details?.result);
  }
  // Code can return arbitrary JSON. Trust only observed child sends and the
  // host's terminal-batch flag, never a receipt returned by the code itself.
  return attempt.name === "tool_search_code";
}

/** Scope explicit successful send completion to one dispatch, never the session. */
export function beginSilentSendCapture(sessionKey: string) {
  const capture: Capture = {
    sessionKey, marker: `[Inkbox turn correlation: ${randomUUID()}]`,
    closed: false, batchStarted: false, invalid: false, attempts: new Map(),
  };
  return {
    marker: capture.marker,
    activate() { if (!capture.closed) captures.add(capture); },
    transform<T extends {
      text?: string; media?: unknown; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean;
    }>(payload: T): T | null {
      const attempts = [...capture.attempts.values()];
      // Preserve errors and attachments. No text matching or fabricated delivery:
      // an entirely successful, explicitly final tool batch authorizes silence.
      if (!capture.closed && capture.batchStarted && !capture.invalid &&
          attempts.some((attempt) => !attempt.wrapper && attempt.accepted) &&
          attempts.every((attempt) => attempt.accepted) && !payload.isError &&
          !payload.media && !payload.mediaUrl && !payload.mediaUrls?.length) return null;
      return transformInkboxReplyPayload(payload);
    },
    shape() {
      return {
        bound: Boolean(capture.runId), batch: capture.batchStarted,
        attempts: capture.attempts.size,
        accepted: [...capture.attempts.values()].filter((attempt) => attempt.accepted).length,
        invalid: capture.invalid,
      };
    },
    finish() { capture.closed = true; captures.delete(capture); },
  };
}

export function bindSilentSendCaptureToRun(event: { prompt?: string }, context: Context): void {
  if (!context.runId || !context.sessionKey || typeof event.prompt !== "string") return;
  for (const capture of captures) {
    if (!capture.closed && !capture.runId && capture.sessionKey === context.sessionKey &&
        event.prompt.includes(capture.marker)) capture.runId = context.runId;
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
    if (!capture.batchStarted || !id || capture.attempts.has(id)) {
      capture.invalid = true;
      continue;
    }
    const name = event.toolName ?? "";
    const wrapper = transportTools.has(name);
    capture.attempts.set(id, { name, wrapper, accepted: false });
    if (!wrapper && (!sendTools.has(name) || event.params?.completeSilently !== true)) {
      capture.invalid = true;
    }
  }
}

export function recordSilentSendAfterToolCall(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    const id = event.toolCallId ?? context.toolCallId;
    const attempt = id ? capture.attempts.get(id) : undefined;
    const result = event.result as Result | undefined;
    if (!id || !attempt || attempt.name !== event.toolName || event.error ||
        result?.isError === true || result?.terminate !== true) {
      capture.invalid = true;
      continue;
    }
    const accepted = attempt.wrapper
      ? acceptedWrapper(capture, id, attempt, event, result)
      : sendTools.has(attempt.name) && event.params?.completeSilently === true &&
        acceptedSendResult(result);
    if (!accepted) capture.invalid = true;
    else attempt.accepted = true;
  }
}
