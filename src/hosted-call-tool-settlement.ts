import {
  recordHostedSmsAttemptPending,
  settleHostedSmsAttempt,
} from "./hosted-call-registry.js";

const HOSTED_SMS_TOOL = "inkbox_send_sms";

interface ToolHookContext {
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
}

interface ToolHookEvent {
  toolName: string;
  params?: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
}

interface ModelCallEndedEvent {
  runId: string;
  outcome: "completed" | "error";
  failureKind?: "aborted" | "connection_closed" | "connection_reset" | "terminated" | "timeout";
}

export interface HostedSmsToolAttempt {
  target?: string;
  outcome: "pending" | "success" | "failed";
  errorKind?: HostedSmsErrorKind;
  runId?: string;
  toolCallId?: string;
}

export interface HostedSmsToolReport {
  expectedTarget: string;
  attempts: HostedSmsToolAttempt[];
  aborted: boolean;
}

interface ActiveCapture extends HostedSmsToolReport {
  accountId: string;
  callId: string;
  phase: "initial" | "correction";
  sessionKey: string;
  promptMarker: string;
  runId?: string;
  closed: boolean;
}

export interface HostedSmsToolCapture {
  finish(): HostedSmsToolReport;
}

export interface HostedSmsSettlementDecision {
  outcome: "success" | "correction" | "terminal";
  reason: string;
}

export type HostedSmsErrorKind =
  | "pre_send_validation"
  | "content_rejected"
  | "recipient_terminal"
  | "ambiguous_provider_failure";

const captures = new Map<string, ActiveCapture>();

function eventRunId(event: { runId?: string }, ctx: ToolHookContext): string | undefined {
  return event.runId ?? ctx.runId;
}

function matchingCapture(
  event: { runId?: string },
  ctx: ToolHookContext,
): ActiveCapture | undefined {
  const sessionKey = ctx.sessionKey?.trim();
  if (!sessionKey) return undefined;
  const capture = captures.get(sessionKey);
  if (!capture || capture.closed) return undefined;
  const runId = eventRunId(event, ctx);
  // A session key can host overlapping work. Never let the first tool event
  // opportunistically claim a capture: before_agent_run binds the exact host
  // run, and events without that authoritative correlation fail closed.
  if (!capture.runId || !runId || capture.runId !== runId) return undefined;
  return capture;
}

function toolCallId(event: ToolHookEvent, ctx: ToolHookContext): string | undefined {
  return event.toolCallId ?? ctx.toolCallId;
}

function toolTarget(params: Record<string, unknown> | undefined): string | undefined {
  const to = params?.to;
  if (typeof to === "string") return to.trim() || undefined;
  if (Array.isArray(to) && to.length === 1 && typeof to[0] === "string") {
    return to[0].trim() || undefined;
  }
  return undefined;
}

function resultText(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((item) =>
      item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

function positiveSendResult(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const details = (result as { details?: unknown }).details;
  if (details && typeof details === "object") {
    const send = (details as { inkboxSendSms?: unknown }).inkboxSendSms;
    if (send && typeof send === "object" && (send as { sent?: unknown }).sent === true) {
      return true;
    }
  }
  // Compatibility with an older host that strips structured details before
  // after_tool_call. This is the exact success envelope emitted by send-sms.ts,
  // not a generic absence-of-error check.
  return /^Sent text id=\S+\s/m.test(resultText(result) ?? "");
}

function classifyHostedSmsError(error: string): HostedSmsErrorKind {
  const normalized = error.toLowerCase();
  if (
    /specify exactly one of|must include at least one recipient|support at most 8 recipients|maximum is \d+|too long/.test(
      normalized,
    )
  ) {
    return "pre_send_validation";
  }
  if (
    /(?:content[_ -]?(?:policy|rejected|violation)|markdown|emoji|profanity|rule[=: ]|unsafe_content)/.test(
      normalized,
    ) &&
    !/(?:unsafe|harmful|abusive|harassment|threat|illegal)/.test(normalized)
  ) {
    return "content_rejected";
  }
  if (
    /(?:not opted in|opted out|invalid (?:phone|number)|unreachable|blocked|sender_(?:sms_)?pending|no_shared_connection)/.test(
      normalized,
    )
  ) {
    return "recipient_terminal";
  }
  // Timeouts, throttles, 5xxs, carrier/backoff errors, duplicate uncertainty,
  // and unrecognized results are commit-ambiguous. Never risk a duplicate.
  return "ambiguous_provider_failure";
}

function resultIsError(result: unknown): boolean {
  return Boolean(
    result &&
      typeof result === "object" &&
      (result as { isError?: unknown }).isError === true,
  );
}

function findAttempt(
  capture: ActiveCapture,
  event: ToolHookEvent,
  ctx: ToolHookContext,
): HostedSmsToolAttempt | undefined {
  const id = toolCallId(event, ctx);
  if (!id) return undefined;
  return capture.attempts.find((attempt) => attempt.toolCallId === id);
}

/** Begin observing one hosted post-call agent turn in its resolved OpenClaw session. */
export function beginHostedSmsToolCapture(params: {
  accountId: string;
  callId: string;
  phase: "initial" | "correction";
  sessionKey: string;
  expectedTarget: string;
  promptMarker: string;
}): HostedSmsToolCapture {
  const sessionKey = params.sessionKey.trim();
  const promptMarker = params.promptMarker.trim();
  if (!sessionKey) throw new Error("Hosted SMS settlement requires a session key.");
  if (!promptMarker) throw new Error("Hosted SMS settlement requires a prompt marker.");
  if (captures.has(sessionKey)) {
    throw new Error(`Hosted SMS settlement is already active for session ${sessionKey}.`);
  }
  const capture: ActiveCapture = {
    accountId: params.accountId,
    callId: params.callId,
    phase: params.phase,
    sessionKey,
    promptMarker,
    expectedTarget: params.expectedTarget.trim(),
    attempts: [],
    aborted: false,
    closed: false,
  };
  captures.set(sessionKey, capture);
  return {
    finish() {
      if (!capture.closed) {
        capture.closed = true;
        captures.delete(sessionKey);
      }
      return {
        expectedTarget: capture.expectedTarget,
        attempts: capture.attempts.map((attempt) => ({ ...attempt })),
        aborted: capture.aborted,
      };
    },
  };
}

/** Bind a pending capture to the exact OpenClaw run before any tools execute. */
export function bindHostedSmsCaptureToRun(
  event: { prompt?: string },
  ctx: ToolHookContext,
): void {
  const sessionKey = ctx.sessionKey?.trim();
  const runId = ctx.runId?.trim();
  if (!sessionKey || !runId) return;
  const capture = captures.get(sessionKey);
  if (!capture || capture.closed || capture.runId) return;
  if (typeof event.prompt !== "string" || !event.prompt.includes(capture.promptMarker)) return;
  capture.runId = runId;
}

/** OpenClaw `before_tool_call` hook. Records an attempt before side effects begin. */
export async function recordHostedSmsBeforeToolCall(
  event: ToolHookEvent,
  ctx: ToolHookContext,
): Promise<{ block: true; blockReason: string } | void> {
  if (event.toolName !== HOSTED_SMS_TOOL) return;
  const sessionKey = ctx.sessionKey?.trim();
  const active = sessionKey ? captures.get(sessionKey) : undefined;
  if (!active || active.closed) return;
  const capture = matchingCapture(event, ctx);
  if (!capture) {
    return {
      block: true,
      blockReason: "Blocked an uncorrelated SMS call during hosted-call settlement.",
    };
  }
  const id = toolCallId(event, ctx);
  if (!id) {
    return {
      block: true,
      blockReason: "Blocked an SMS call without an authoritative tool-call ID.",
    };
  }
  if (capture.attempts.some((attempt) => attempt.toolCallId === id)) {
    return {
      block: true,
      blockReason: "Blocked a duplicate hosted SMS tool-call ID.",
    };
  }
  if (capture.attempts.length > 0) {
    // The model may try to recover inside the same turn after a tool error.
    // Settlement owns that decision: no second provider call is allowed.
    capture.attempts.push({
      target: toolTarget(event.params),
      outcome: "failed",
      errorKind: "recipient_terminal",
      runId: eventRunId(event, ctx),
      toolCallId: id,
    });
    return {
      block: true,
      blockReason: "Blocked a second SMS attempt during hosted-call settlement.",
    };
  }
  const target = toolTarget(event.params);
  const attempt: HostedSmsToolAttempt = {
    target,
    outcome: "pending",
    runId: eventRunId(event, ctx),
    toolCallId: id,
  };
  capture.attempts.push(attempt);
  try {
    await recordHostedSmsAttemptPending({
      accountId: capture.accountId,
      callId: capture.callId,
      phase: capture.phase,
      toolCallId: id,
      targetMatches: target === capture.expectedTarget,
    });
  } catch {
    attempt.outcome = "failed";
    attempt.errorKind = "ambiguous_provider_failure";
    return {
      block: true,
      blockReason: "Blocked SMS because the durable pre-send journal could not be written.",
    };
  }
  if (target !== capture.expectedTarget) {
    attempt.outcome = "failed";
    attempt.errorKind = "recipient_terminal";
    try {
      await settleHostedSmsAttempt({
        accountId: capture.accountId,
        callId: capture.callId,
        phase: capture.phase,
        toolCallId: id,
        state: "failed",
        errorKind: "wrong_target",
      });
    } catch {
      // The pending record still prevents replay. Never let a failed journal
      // update turn this policy block into a provider call.
    }
    return {
      block: true,
      blockReason: "Blocked hosted SMS to a non-authoritative call target.",
    };
  }
}

/** OpenClaw `after_tool_call` hook. Settles the exact tool result returned to the model. */
export async function recordHostedSmsAfterToolCall(
  event: ToolHookEvent,
  ctx: ToolHookContext,
): Promise<void> {
  if (event.toolName !== HOSTED_SMS_TOOL) return;
  const capture = matchingCapture(event, ctx);
  if (!capture) return;
  let attempt = findAttempt(capture, event, ctx);
  if (!attempt) {
    const id = toolCallId(event, ctx) ?? "missing";
    attempt = {
      target: toolTarget(event.params),
      outcome: "failed",
      errorKind: "ambiguous_provider_failure",
      runId: eventRunId(event, ctx),
      toolCallId: id,
    };
    capture.attempts.push(attempt);
    // The provider may already have committed. Record that ambiguity after
    // the fact if possible, but never accept success without the pre-send
    // durable journal written by before_tool_call.
    try {
      await recordHostedSmsAttemptPending({
        accountId: capture.accountId,
        callId: capture.callId,
        phase: capture.phase,
        toolCallId: id,
        targetMatches: attempt.target === capture.expectedTarget,
      });
      await settleHostedSmsAttempt({
        accountId: capture.accountId,
        callId: capture.callId,
        phase: capture.phase,
        toolCallId: id,
        state: "failed",
        errorKind: "after_hook_without_before_hook",
      });
    } catch {
      // In-memory settlement is already terminal. If pending persisted before
      // the second write failed, restart handling also treats it as terminal.
    }
    return;
  }
  // A blocked tool may still produce a lifecycle callback in some host
  // versions. Its journal is already settled (or intentionally absent).
  if (attempt.outcome !== "pending") return;
  const error = event.error?.trim() || resultText(event.result);
  if (event.error || resultIsError(event.result)) {
    attempt.outcome = "failed";
    attempt.errorKind = classifyHostedSmsError(error || "unknown tool failure");
    await settleHostedSmsAttempt({
      accountId: capture.accountId,
      callId: capture.callId,
      phase: capture.phase,
      toolCallId: attempt.toolCallId ?? "missing",
      state: "failed",
      errorKind: attempt.errorKind,
    });
    return;
  }
  if (positiveSendResult(event.result)) {
    attempt.outcome = "success";
    await settleHostedSmsAttempt({
      accountId: capture.accountId,
      callId: capture.callId,
      phase: capture.phase,
      toolCallId: attempt.toolCallId ?? "missing",
      state: "success",
    });
    return;
  }
  attempt.outcome = "failed";
  attempt.errorKind = "ambiguous_provider_failure";
  await settleHostedSmsAttempt({
    accountId: capture.accountId,
    callId: capture.callId,
    phase: capture.phase,
    toolCallId: attempt.toolCallId ?? "missing",
    state: "failed",
    errorKind: attempt.errorKind,
  });
}

/** OpenClaw `model_call_ended` hook. Abort/termination is terminal and never replayed. */
export function recordHostedModelCallEnded(
  event: ModelCallEndedEvent,
  ctx: ToolHookContext,
): void {
  const capture = matchingCapture(event, ctx);
  if (!capture) return;
  if (event.failureKind === "aborted" || event.failureKind === "terminated") {
    capture.aborted = true;
  }
}

/**
 * Enforce the hosted post-call SMS contract from observed host events.
 *
 * The initial turn gets one correction only when it made no attempt or exactly
 * one exact-target attempt failed for a recoverable content/policy reason. The
 * correction turn must produce exactly one exact-target success.
 */
export function evaluateHostedSmsSettlement(
  report: HostedSmsToolReport,
  phase: "initial" | "correction",
): HostedSmsSettlementDecision {
  if (report.aborted) {
    return { outcome: "terminal", reason: "agent_aborted" };
  }
  if (report.attempts.length === 0) {
    return phase === "initial"
      ? { outcome: "correction", reason: "missing_attempt" }
      : { outcome: "terminal", reason: "correction_missing_attempt" };
  }
  if (report.attempts.length !== 1) {
    return {
      outcome: "terminal",
      reason: "multiple_attempts",
    };
  }
  const attempt = report.attempts[0];
  if (attempt.target !== report.expectedTarget) {
    return {
      outcome: "terminal",
      reason: "wrong_target",
    };
  }
  if (attempt.outcome === "success") {
    return { outcome: "success", reason: "one exact-target inkbox_send_sms call succeeded" };
  }
  if (
    phase === "initial" &&
    attempt.outcome === "failed" &&
    (attempt.errorKind === "pre_send_validation" || attempt.errorKind === "content_rejected")
  ) {
    return { outcome: "correction", reason: attempt.errorKind };
  }
  return {
    outcome: "terminal",
    reason:
      attempt.outcome === "pending"
        ? "unknown_tool_outcome"
        : attempt.errorKind ?? "ambiguous_provider_failure",
  };
}

export function resetHostedSmsToolCapturesForTest(): void {
  captures.clear();
}
