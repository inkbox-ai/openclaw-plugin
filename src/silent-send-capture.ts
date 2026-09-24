import { randomUUID } from "node:crypto";
import { transformInkboxReplyPayload } from "./silent-reply.js";

type Context = { sessionKey?: string; sessionId?: string; runId?: string; toolCallId?: string };
type Event = {
  runId?: string;
  toolCallId?: string;
  toolName?: string;
  toolKind?: string;
  toolInputKind?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: unknown;
};
type Attempt = { name: string; accepted: boolean; wrapper: boolean; nativeCode?: boolean };
type Capture = {
  sessionKey: string;
  marker: string;
  runId?: string;
  nativeSessionId?: string;
  closed: boolean;
  batchStarted: boolean;
  invalid: boolean;
  fatalInvalid: boolean;
  missingBefore: Map<string, string>;
  invalidShape?: { reason: string; finalParam: string; tool: string };
  invalidOwner?: { tool: string; name: string; id: string; relationship: string; prior: string; alias: boolean; batch: number; before: number; hook: string };
  batchOrdinal: number;
  beforeCount: number;
  attempts: Map<string, Attempt>;
  priorBatchCalls: Map<string, string>;
};
type Result = {
  terminate?: unknown;
  isError?: unknown;
  details?: {
    status?: unknown;
    inkboxSendCompletion?: { accepted?: unknown; completeSilently?: unknown };
    tool?: { name?: unknown };
    result?: unknown;
  };
};
// The host can load channel dispatch and prepared-run hooks in separate module
// graphs. Keep the ephemeral, exact-run evidence shared within this process.
const captureRegistry = Symbol.for("inkbox.silent-send-captures.v1");
const processState = globalThis as typeof globalThis & { [captureRegistry]?: Set<Capture> };
const captures = processState[captureRegistry] ??= new Set<Capture>();
const sendTools = new Set([
  "inkbox_send_sms", "inkbox_send_email", "inkbox_send_imessage", "inkbox_forward_email",
]);
const transportTools = new Set(["tool_call", "tool_search_code"]);
// OpenClaw 2026.9.6's inner source/incomplete-turn finalizers can overlook
// intentional cross-channel tool completion. Neither exposes a public reason
// discriminator. Match only their two verified fixed errors, with independent
// accepted final-send evidence below; changed wording and real errors stay visible.
const nativeEmptyReplyTexts = new Set([
  "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
  "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.",
]);

function invalidate(capture: Capture, reason: "before_lifecycle" | "duplicate_before" | "nonfinal_before" | "missing_before" | "name_mismatch" | "tool_error" | "nonterminal_after" | "unaccepted_after", event: Event, context: Context): void {
  capture.invalid = true;
  const id = event.toolCallId ?? context.toolCallId;
  // Schema/lookup failures never execute BEFORE. Keep them invalid until the
  // exact run's completed native transcript proves an earlier model exchange.
  if (reason === "missing_before" && typeof id === "string" && id &&
      typeof event.toolName === "string" && event.toolName &&
      (event.error || (event.result as Result | undefined)?.isError === true)) {
    if (capture.missingBefore.has(id) && capture.missingBefore.get(id) !== event.toolName) capture.fatalInvalid = true;
    capture.missingBefore.set(id, event.toolName);
  } else capture.fatalInvalid = true;
  const params = event.toolName === "tool_call"
    ? event.params?.args as Record<string, unknown> | undefined : event.params;
  const value = params?.completeSilently;
  capture.invalidShape ??= {
    reason,
    finalParam: value === true ? "true" : value === false ? "false" : value === undefined ? "missing" : typeof value === "string" ? "string" : "other",
    tool: sendTools.has(event.toolName ?? "") ? "send" : transportTools.has(event.toolName ?? "") ? "transport" : "other",
  };
  const nativeTools = new Set(["tool_search", "tool_describe", "inkbox_whoami", "read", "exec", "message"]);
  const name = typeof event.toolName === "string" ? event.toolName : undefined;
  const prior = typeof id === "string" && capture.priorBatchCalls.has(id);
  capture.invalidOwner ??= {
    tool: name && nativeTools.has(name) ? name : name?.startsWith("inkbox_") ? "inkbox_other" : "other",
    name: name === undefined ? event.toolName === undefined ? "missing" : "nonstring" : name ? "present" : "empty",
    id: !id ? "missing" : typeof id !== "string" ? "nonstring" : `${event.toolCallId !== undefined ? "event" : "context"}_${id.includes("|") ? "composite" : "plain"}`,
    relationship: event.toolCallId === undefined ? context.toolCallId === undefined ? "neither" : "context_only" : context.toolCallId === undefined ? "event_only" : event.toolCallId === context.toolCallId ? "same" : "different",
    prior: !prior ? "absent" : capture.priorBatchCalls.get(id!) === name ? "same_name" : "different_name",
    alias: typeof id === "string" && [...capture.priorBatchCalls.keys()].some((key) => typeof key === "string" && key !== id && key.split("|")[0] === id.split("|")[0]),
    batch: Math.min(capture.batchOrdinal, 9999), before: Math.min(capture.beforeCount, 9999), hook: "batch_owner_v2",
  };
}

function matching(event: Event, context: Context): Capture[] {
  const runId = event.runId ?? context.runId;
  if (!runId || !context.sessionKey) return [];
  return [...captures].filter((capture) =>
    !capture.closed && capture.sessionKey === context.sessionKey && capture.runId === runId,
  );
}

function isNativeCodeBefore(event: Event): boolean {
  return event.toolName === "exec" && event.toolKind === "code_mode_exec" && event.toolInputKind === "javascript";
}

function matchingBefore(event: Event, context: Context): Capture[] {
  const exact = matching(event, context);
  if (exact.length || !isNativeCodeBefore(event) || !context.sessionKey ||
      !context.runId || !context.sessionId?.trim() ||
      (event.runId !== undefined && event.runId !== context.runId)) return exact;
  // Native Code Mode's adapter uses the routed sandbox key for BEFORE, while
  // before_agent_run, nested tools and AFTER use the canonical session key.
  // Admit that alias only for this already prompt-bound run/native session;
  // never infer ownership from a sender, a key suffix, or a tool name alone.
  const owned = [...captures].filter((capture) => !capture.closed &&
    capture.runId === context.runId && capture.nativeSessionId === context.sessionId);
  return owned.length === 1 ? owned : [];
}

function acceptedSendResult(value: unknown): boolean {
  const result = value as Result | undefined;
  const receipt = result?.details?.inkboxSendCompletion;
  return result?.terminate === true && result.isError !== true &&
    receipt?.accepted === true && receipt.completeSilently === true;
}

function completedFinalBatch(capture: Capture): boolean {
  const attempts = [...capture.attempts.values()];
  return !capture.closed && capture.batchStarted && !capture.invalid &&
    attempts.some((attempt) => !attempt.wrapper && attempt.accepted) &&
    attempts.every((attempt) => attempt.accepted);
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
  // The public native BEFORE tag distinguishes JavaScript Code Mode from the
  // unrelated shell tool also named exec. The native outer status must be
  // completed: termination alone can accompany failed/refreshing execution.
  if (attempt.nativeCode) return result.details?.status === "completed";
  // Code can return arbitrary JSON. Trust only observed child sends and the
  // host's terminal-batch flag, never a receipt returned by the code itself.
  return attempt.name === "tool_search_code";
}

/** Scope explicit successful send completion to one dispatch, never the session. */
export function beginSilentSendCapture(sessionKey: string) {
  const capture: Capture = {
    sessionKey, marker: `[Inkbox turn correlation: ${randomUUID()}]`,
    closed: false, batchStarted: false, invalid: false, fatalInvalid: false, missingBefore: new Map(), attempts: new Map(), priorBatchCalls: new Map(), batchOrdinal: 0, beforeCount: 0,
  };
  return {
    marker: capture.marker,
    activate() { if (!capture.closed) captures.add(capture); },
    completedSilently() { return completedFinalBatch(capture); },
    transform<T extends {
      text?: string; media?: unknown; mediaUrl?: string; mediaUrls?: string[]; isError?: boolean;
    }>(payload: T): T | null {
      // An entirely successful, explicitly final batch authorizes silence. Never
      // fabricate current-source delivery or hide other errors/attachments.
      if (completedFinalBatch(capture) &&
          (!payload.isError || (payload.isError === true && typeof payload.text === "string" && nativeEmptyReplyTexts.has(payload.text))) &&
          !payload.media && !payload.mediaUrl && !payload.mediaUrls?.length) return null;
      return transformInkboxReplyPayload(payload);
    },
    shape() {
      return {
        bound: Boolean(capture.runId), batch: capture.batchStarted,
        attempts: capture.attempts.size,
        accepted: [...capture.attempts.values()].filter((attempt) => attempt.accepted).length,
        invalid: capture.invalid,
        invalidShape: capture.invalidShape,
        invalidOwner: capture.invalidOwner,
      };
    },
    finish() { capture.closed = true; captures.delete(capture); },
  };
}

export function bindSilentSendCaptureToRun(event: { prompt?: string }, context: Context): void {
  if (!context.runId || !context.sessionKey || typeof event.prompt !== "string") return;
  for (const capture of captures) {
    if (!capture.closed && !capture.runId && capture.sessionKey === context.sessionKey &&
        event.prompt.includes(capture.marker)) {
      capture.runId = context.runId;
      if (context.sessionId?.trim()) capture.nativeSessionId = context.sessionId;
    }
  }
}

export function recordSilentSendModelStarted(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    capture.batchStarted = true;
    capture.invalid = false;
    capture.fatalInvalid = false;
    capture.missingBefore.clear();
    capture.invalidShape = undefined;
    capture.invalidOwner = undefined;
    capture.batchOrdinal += 1;
    for (const [id, attempt] of capture.attempts) capture.priorBatchCalls.set(id, attempt.name);
    capture.attempts.clear();
  }
}

export function recordSilentSendBeforeToolCall(event: Event, context: Context): void {
  for (const capture of matchingBefore(event, context)) {
    capture.beforeCount += 1;
    const id = event.toolCallId ?? context.toolCallId;
    const duplicate = id && (capture.attempts.has(id) || capture.priorBatchCalls.has(id));
    if (!capture.batchStarted || !id || duplicate) {
      invalidate(capture, duplicate ? "duplicate_before" : "before_lifecycle", event, context);
      continue;
    }
    const name = event.toolName ?? "";
    const nativeCode = isNativeCodeBefore(event);
    const wrapper = transportTools.has(name) || nativeCode;
    capture.attempts.set(id, { name, wrapper, accepted: false, ...(nativeCode ? { nativeCode: true } : {}) });
    if (!wrapper && (!sendTools.has(name) || event.params?.completeSilently !== true)) {
      invalidate(capture, "nonfinal_before", event, context);
    }
  }
}

export function recordSilentSendAfterToolCall(event: Event, context: Context): void {
  for (const capture of matching(event, context)) {
    const id = event.toolCallId ?? context.toolCallId;
    const attempt = id ? capture.attempts.get(id) : undefined;
    // Native streamed-block delivery can delay a tool's end observer until
    // after the next model call starts. Retire only IDs/names whose BEFORE was
    // actually seen (or whose completed prior exchange was proved at agent_end)
    // in this exact run; old results never prove a new final send.
    if (!attempt && id && capture.priorBatchCalls.has(id) && capture.priorBatchCalls.get(id) === event.toolName) continue;
    const result = event.result as Result | undefined;
    if (!id || !attempt || attempt.name !== event.toolName || event.error ||
        result?.isError === true || result?.terminate !== true) {
      invalidate(capture, !id || !attempt ? "missing_before" : attempt.name !== event.toolName ? "name_mismatch" : event.error || result?.isError === true ? "tool_error" : "nonterminal_after", event, context);
      continue;
    }
    const accepted = attempt.wrapper
      ? acceptedWrapper(capture, id, attempt, event, result)
      : sendTools.has(attempt.name) && event.params?.completeSilently === true &&
        acceptedSendResult(result);
    if (!accepted) invalidate(capture, "unaccepted_after", event, context);
    else attempt.accepted = true;
  }
}

/** Synchronous public agent_end hook; no transcript I/O or model-text parsing. */
export function reconcileSilentSendAgentEnd(event: { runId?: string; success?: boolean; messages?: unknown[] }, context: Context): void {
  if (!event.runId || event.runId !== context.runId || event.success !== true || !Array.isArray(event.messages)) return;
  const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const messages = event.messages.map(object);
  for (const capture of matching(event, context)) {
    if (capture.fatalInvalid || !capture.missingBefore.size || !capture.attempts.size ||
        ![...capture.attempts.values()].every((attempt) => attempt.accepted)) continue;
    const anchors = messages.flatMap((message, index) => {
      if (message?.role !== "user") return [];
      const texts = typeof message.content === "string" ? [message.content] : Array.isArray(message.content)
        ? message.content.flatMap((block) => { const item = object(block); return item?.type === "text" && typeof item.text === "string" ? [item.text] : []; }) : [];
      return texts.some((text) => text.includes(capture.marker)) ? [index] : [];
    });
    if (anchors.length !== 1 || messages.slice(anchors[0] + 1).some((message) => message?.role === "user")) continue;
    const calls = new Map<string, Array<{ name: string; index: number }>>();
    const results = new Map<string, Array<{ name: unknown; index: number; failed: boolean }>>();
    let finalIndex = -1;
    let malformed = false;
    for (const [index, message] of messages.entries()) {
      if (message?.role === "assistant") {
        if (index > anchors[0]) finalIndex = index;
        if (!Array.isArray(message.content)) { if (index > anchors[0]) malformed = true; continue; }
        for (const block of message.content) {
          const call = object(block);
          if (call?.type !== "toolCall") continue;
          if (typeof call.id !== "string" || !call.id || typeof call.name !== "string" || !call.name) { malformed = true; continue; }
          const entries = calls.get(call.id) ?? [];
          entries.push({ name: call.name, index }); calls.set(call.id, entries);
        }
      } else if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
        const entries = results.get(message.toolCallId) ?? [];
        entries.push({ name: message.toolName, index, failed: message.isError === true }); results.set(message.toolCallId, entries);
      }
    }
    const roots = [...calls].filter(([, entries]) => entries.some((entry) => entry.index === finalIndex));
    if (malformed || finalIndex <= anchors[0] || !roots.length || roots.some(([id, entries]) =>
      entries.length !== 1 || capture.attempts.get(id)?.name !== entries[0].name)) continue;
    const rootIds = new Set(roots.map(([id]) => id));
    if ([...capture.attempts].some(([id, attempt]) => !rootIds.has(id) && !roots.some(([rootId]) => {
      if (!capture.attempts.get(rootId)?.wrapper || attempt.wrapper) return false;
      const prefix = `tool_search_code:${parentIdSegment(rootId)}:${attempt.name}:`;
      return id.startsWith(prefix) && /^[1-9]\d*$/.test(id.slice(prefix.length));
    }))) continue;
    if ([...capture.missingBefore].some(([id, name]) => {
      const owned = calls.get(id); const settled = results.get(id);
      return owned?.length !== 1 || settled?.length !== 1 || owned[0].name !== name || settled[0].name !== name ||
        !settled[0].failed || owned[0].index <= anchors[0] || settled[0].index <= owned[0].index || settled[0].index >= finalIndex;
    })) continue;
    for (const [id, name] of capture.missingBefore) capture.priorBatchCalls.set(id, name);
    capture.missingBefore.clear();
    capture.invalid = false;
    capture.invalidShape = undefined;
    capture.invalidOwner = undefined;
  }
}
