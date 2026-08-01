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
  sessionKey: string;
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
  if (capture.runId && runId && capture.runId !== runId) return undefined;
  if (!capture.runId && runId) capture.runId = runId;
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
  if (id) {
    const exact = capture.attempts.find((attempt) => attempt.toolCallId === id);
    if (exact) return exact;
  }
  const runId = eventRunId(event, ctx);
  return capture.attempts.find(
    (attempt) => attempt.outcome === "pending" && (!runId || attempt.runId === runId),
  );
}

/** Begin observing one hosted post-call agent turn in its resolved OpenClaw session. */
export function beginHostedSmsToolCapture(params: {
  sessionKey: string;
  expectedTarget: string;
}): HostedSmsToolCapture {
  const sessionKey = params.sessionKey.trim();
  if (!sessionKey) throw new Error("Hosted SMS settlement requires a session key.");
  if (captures.has(sessionKey)) {
    throw new Error(`Hosted SMS settlement is already active for session ${sessionKey}.`);
  }
  const capture: ActiveCapture = {
    sessionKey,
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

/** OpenClaw `before_tool_call` hook. Records an attempt before side effects begin. */
export function recordHostedSmsBeforeToolCall(
  event: ToolHookEvent,
  ctx: ToolHookContext,
): void {
  if (event.toolName !== HOSTED_SMS_TOOL) return;
  const capture = matchingCapture(event, ctx);
  if (!capture) return;
  const id = toolCallId(event, ctx);
  if (id && capture.attempts.some((attempt) => attempt.toolCallId === id)) return;
  capture.attempts.push({
    target: toolTarget(event.params),
    outcome: "pending",
    runId: eventRunId(event, ctx),
    toolCallId: id,
  });
}

/** OpenClaw `after_tool_call` hook. Settles the exact tool result returned to the model. */
export function recordHostedSmsAfterToolCall(
  event: ToolHookEvent,
  ctx: ToolHookContext,
): void {
  if (event.toolName !== HOSTED_SMS_TOOL) return;
  const capture = matchingCapture(event, ctx);
  if (!capture) return;
  let attempt = findAttempt(capture, event, ctx);
  if (!attempt) {
    attempt = {
      target: toolTarget(event.params),
      outcome: "pending",
      runId: eventRunId(event, ctx),
      toolCallId: toolCallId(event, ctx),
    };
    capture.attempts.push(attempt);
  }
  const error = event.error?.trim() || resultText(event.result);
  if (event.error || resultIsError(event.result)) {
    attempt.outcome = "failed";
    attempt.errorKind = classifyHostedSmsError(error || "unknown tool failure");
    return;
  }
  if (positiveSendResult(event.result)) {
    attempt.outcome = "success";
    return;
  }
  attempt.outcome = "failed";
  attempt.errorKind = "ambiguous_provider_failure";
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
