import { isInkboxSilentReply } from "./silent-reply.js";

type NativeOutcome = { runId?: string; failed?: boolean };
// Dispatch and plugin registration can use separate host module graphs.
const registry = Symbol.for("inkbox.reply-outcomes.v1");
const state = globalThis as typeof globalThis & { [registry]?: Set<NativeOutcome> };
const outcomes = state[registry] ??= new Set<NativeOutcome>();

export function recordInkboxReplyLifecycle(event: {
  runId: string; stream: string; data: Record<string, unknown>;
}): void {
  if (event.stream !== "lifecycle") return;
  for (const outcome of outcomes) {
    if (outcome.runId !== event.runId) continue;
    const { phase, aborted, stopReason } = event.data;
    if (phase === "start") outcome.failed = undefined;
    if (phase === "error") outcome.failed = true;
    if (phase === "end") outcome.failed = aborted === true || stopReason === "error" || stopReason === "aborted";
  }
}

/** Capture an auxiliary agent answer without claiming delivery to a conversation. */
export function createInkboxTextReplyCapture() {
  const texts: string[] = [];
  let sawError = false;
  let native: NativeOutcome | undefined;
  return {
    trackNativeRun(): () => void {
      const outcome: NativeOutcome = {};
      native = outcome;
      outcomes.add(outcome);
      return () => { outcomes.delete(outcome); };
    },
    onAgentRunStart(runId: string): void {
      if (native && native.runId !== runId) {
        native.runId = runId;
        native.failed = undefined;
      }
    },
    transformReplyPayload(payload: { text?: string; isError?: boolean }): null {
      if (payload.isError) sawError = true;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text && !payload.isError && !isInkboxSilentReply(text)) texts.push(text);
      // The host classifies this as intentional channel transformation, so a
      // captured answer does not cause a second "nothing delivered" fallback.
      return null;
    },
    hasError(): boolean {
      // A tool warning is recoverable only when the run completed with an answer.
      return native ? native.failed !== false || (sawError && texts.length === 0) : sawError;
    },
    // Best-effort callers such as progress updates drop text only for a known failure.
    failed(): boolean { return native?.failed === true || (sawError && texts.length === 0); },
    lastText(): string { return texts.at(-1) ?? ""; },
  };
}
