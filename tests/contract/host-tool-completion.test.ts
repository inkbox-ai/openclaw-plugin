import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import { dispatchInboundMessageWithDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { beginSilentSendCapture, bindSilentSendCaptureToRun, recordSilentSendModelStarted, recordSilentSendBeforeToolCall, recordSilentSendAfterToolCall } from "../../src/silent-send-capture.js";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/reply-runtime")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
const baselineWithoutFinalizer = hostVersion === "2026.5.27";

async function hostFunction(bundle: string, name: string): Promise<any> {
  const files = readdirSync(hostDist).filter((file) => file.startsWith(`${bundle}-`) && file.endsWith(".js") && readFileSync(join(hostDist, file), "utf8").includes(`function ${name}(`));
  expect(files, `Expected one host ${bundle} bundle`).toHaveLength(1);
  const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
  const fn = Object.values(exports).find((value) => typeof value === "function" && value.name === name);
  expect(fn, `Missing host ${name} contract`).toBeTypeOf("function");
  return fn;
}

function settledAttempt(results: Array<{ terminate?: boolean; isError?: boolean }>) {
  const assistant = {
    role: "assistant", stopReason: "toolUse",
    content: results.map((_, index) => ({ type: "toolCall", id: `send-${index}`, name: "inkbox_send_email", arguments: {} })),
  };
  return {
    currentAttemptAssistant: assistant, lastAssistant: assistant,
    messagesSnapshot: [{ role: "user", content: "Send the email only." }, assistant,
      ...results.map((result, index) => ({ role: "toolResult", toolCallId: `send-${index}`, toolName: "inkbox_send_email", isError: result.isError === true }))],
    toolMetas: results.map((result, index) => ({ toolCallId: `send-${index}`, toolName: "inkbox_send_email", ...result })),
    itemLifecycle: { startedCount: results.length, completedCount: results.length, activeCount: 0 },
    assistantTexts: [], terminal: { kind: "completed" },
    replayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
    currentAttemptReplayMetadata: { replaySafe: false, hadPotentialSideEffects: true },
  };
}

describe("public host tool-result completion envelope", () => {
  it.each([true, false, undefined])("preserves explicit terminate=%s through the host execution wrapper", async (terminate) => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "Accepted" }], details: { accepted: true }, ...(terminate === undefined ? {} : { terminate }) }));
    const tool = wrapToolWithBeforeToolCallHook({ name: "inkbox_send_email", label: "Send email", description: "Send one requested email", parameters: Type.Object({}), execute });
    const result = await tool.execute("test-completion", {});
    expect(execute).toHaveBeenCalledOnce();
    expect(result.terminate).toBe(terminate);
    expect(result.details).toEqual({ accepted: true });
  });
});

describe.skipIf(baselineWithoutFinalizer)("actual host explicit tool-batch completion", () => {
  it.each([
    { accepted: true, reply: undefined, deliveries: 0, name: "suppresses the outer fallback after an accepted explicit final send" },
    { accepted: false, reply: undefined, deliveries: 1, name: "preserves the outer fallback when the requested send failed" },
    { accepted: false, reply: "Your report is ready.", deliveries: 1, name: "preserves a normal reply without a successful explicit final send" },
  ])("actual same-source dispatch $name", async ({ accepted, reply, deliveries }) => {
    const directory = await mkdtemp(join(tmpdir(), "inkbox-host-completion-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    const sessionKey = `agent:main:inkbox:direct:${randomUUID()}`;
    const capture = beginSilentSendCapture(sessionKey);
    const transform = vi.fn(capture.transform);
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    const resolver = vi.fn(async () => {
      const context = { sessionKey, runId: randomUUID() };
      bindSilentSendCaptureToRun({ prompt: capture.marker }, context);
      recordSilentSendModelStarted({}, context);
      const event = { toolCallId: "requested-final-send", toolName: "inkbox_send_email", params: { completeSilently: true } };
      recordSilentSendBeforeToolCall(event, context);
      recordSilentSendAfterToolCall({ ...event, result: accepted
        ? { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } }
        : { isError: true } }, context);
      return reply ? { text: reply } : undefined;
    });
    capture.activate();
    try {
      const result = await dispatchInboundMessageWithDispatcher({
        ctx: { Body: "Send the email only.", From: "inkbox:sms:peer", To: "inkbox:sms:peer", OriginatingChannel: "inkbox", OriginatingTo: "inkbox:sms:peer", Provider: "inkbox", Surface: "inkbox", ChatType: "direct", SessionKey: sessionKey, MessageSid: randomUUID(), CommandAuthorized: true },
        cfg: { session: { store: join(directory, "sessions.json") }, agents: { defaults: { workspace: directory } } },
        dispatcherOptions: { deliver, transformReplyPayload: transform },
        replyResolver: resolver,
      });
      expect(resolver).toHaveBeenCalledOnce();
      expect(transform).toHaveBeenCalled();
      expect(deliver).toHaveBeenCalledTimes(deliveries);
      if (reply) expect(deliver.mock.calls[0][0]).toMatchObject({ text: reply });
      if (accepted) expect(result.noVisibleReplyFallbackDelivered).not.toBe(true);
      else if (!reply) expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    } finally {
      capture.finish();
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("recognizes only entirely successful, explicitly terminating batches", async () => {
    const evidence = await hostFunction("builtin-openclaw", "resolveSettledToolBatchEvidence");
    expect(evidence(settledAttempt([{ terminate: true }])).intentionalTermination).toBe(true);
    expect(evidence(settledAttempt([{ terminate: true }, { terminate: true }])).intentionalTermination).toBe(true);
    expect(evidence(settledAttempt([{ terminate: true }, {}])).intentionalTermination).toBe(false);
    expect(evidence(settledAttempt([{ terminate: true, isError: true }])).intentionalTermination).toBe(false);
    expect(evidence(settledAttempt([{}])).intentionalTermination).toBe(false);
  });

  it("skips isolated finalization only for intentional completed actions", async () => {
    const continuation = await hostFunction("builtin-openclaw", "resolveSettledToolTerminalContinuationInstruction");
    const input = { executionContract: "strict-agentic", allowEmptyStopContinuation: true, payloadCount: 0, aborted: false, timedOut: false };
    expect(continuation({ ...input, attempt: settledAttempt([{ terminate: true }]) })).toBeNull();
    expect(continuation({ ...input, attempt: settledAttempt([{}]) })).toBeTypeOf("string");
    expect(continuation({ ...input, attempt: settledAttempt([{ isError: true }]) })).toBeTypeOf("string");
  });

  it("does not misclassify intentional termination as an empty interactive failure", async () => {
    const classify = await hostFunction("result-fallback-classifier", "hasIntentionalTerminalCompletion");
    const empty = await hostFunction("reply-admission-ticket", "buildEmptyInteractiveReplyPayload");
    const result = { meta: { intentionalTerminalCompletion: "tool-batch" } };
    expect(classify(result)).toBe(true);
    expect(empty({ isInteractive: true, hasIntentionalTerminalCompletion: classify(result) })).toBeUndefined();
    expect(empty({ isInteractive: true, sessionCtx: { ChatType: "direct" }, cfg: {}, hasIntentionalTerminalCompletion: classify({ meta: {} }) })).toHaveProperty("text");
  });

  it("reproduces the outer dispatch propagation gap without inventing visible delivery", async () => {
    const classify = await hostFunction("result-fallback-classifier", "hasDeliberateSilentTerminalReply");
    const finalize = await hostFunction("dispatch-from-config.finalize", "finalizeDispatchAndAudit");
    const route = vi.fn(async () => ({ ok: true }));
    const deliberateSilentTerminalReply = classify({ meta: { intentionalTerminalCompletion: "tool-batch" } });
    expect(deliberateSilentTerminalReply).toBe(false);
    const result = await finalize({
      cfg: {}, ctx: {}, replyRoute: {}, deliberateSilentTerminalReply,
      noVisibleReplyFallbackDirected: true, sourceReplyDeliveryMode: "automatic",
      progressState: { accumulatedBlockTtsText: "", blockCount: 0, channelTransformSuppressed: false },
      replyOperationRunState: {}, bindingState: {}, routeState: {},
      dispatcher: { getQueuedCounts: () => ({ final: 0, block: 0, tool: 0 }) },
      turnLedger: { hasVisibleDelivery: () => false, settleQueued: async () => "settled" },
      flushPendingCommentaryProgress: async () => {}, waitForPendingDirectBlockReplyDelivery: async () => {},
      getDispatchAbortSignal: () => undefined, getObservedReplyDelivery: () => false,
      throwIfDispatchOperationAborted: () => {}, routeReplyToOriginating: route,
      isRoutedReplyDelivered: (value: any) => value.ok, getAgentRunTerminalOutcome: () => undefined,
      commitInboundDedupeIfClaimed: () => {}, recordAgentDispatchCompleted: () => {}, recordProcessed: () => {}, markIdle: () => {},
      completeDispatchReplyOperation: () => {}, attachSourceReplyDeliveryMode: (value: any) => value,
    });
    expect(route).toHaveBeenCalledOnce();
    expect(result.result.noVisibleReplyFallbackDelivered).toBe(true);
  });
});
