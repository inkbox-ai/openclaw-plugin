import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createReplyDispatcher, SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { transformInkboxReplyPayload } from "../../src/silent-reply.js";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/reply-runtime")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
// The supported May baseline predates the host's no-visible-reply finalizer.
// Public dispatcher behavior is tested there; every newer host must satisfy
// the additional finalizer contract, with missing internals treated as drift.
const baselineWithoutFinalizer = hostVersion === "2026.5.27";

// These two host internals have no public test entry point. Discover their
// bundled filenames instead of pinning build hashes; fail on contract drift.
async function hostFunction(bundle: string, name: string): Promise<any> {
  const files = readdirSync(hostDist).filter((file) => file.startsWith(`${bundle}-`) && file.endsWith(".js"));
  expect(files, `Expected one host ${bundle} bundle`).toHaveLength(1);
  const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
  const fn = Object.values(exports).find((value) => typeof value === "function" && value.name === name);
  expect(fn, `Missing host ${name} contract`).toBeTypeOf("function");
  return fn;
}

async function finishInvisibleReply(text: string, transformed = false) {
  const classify = await hostFunction("result-fallback-classifier", "hasDeliberateSilentTerminalReply");
  const finalize = await hostFunction("dispatch-from-config.finalize", "finalizeDispatchAndAudit");
  const route = vi.fn(async () => ({ ok: true }));
  const result = await finalize({
    cfg: {}, ctx: {}, replyRoute: {},
    deliberateSilentTerminalReply: classify({ meta: { finalAssistantRawText: text } }),
    noVisibleReplyFallbackDirected: true,
    sourceReplyDeliveryMode: "automatic",
    progressState: { accumulatedBlockTtsText: "", blockCount: 0, channelTransformSuppressed: transformed },
    replyOperationRunState: {}, bindingState: {}, routeState: {},
    dispatcher: { getQueuedCounts: () => ({ final: 0, block: 0, tool: 0 }) },
    turnLedger: { hasVisibleDelivery: () => false, settleQueued: async () => "settled" },
    flushPendingCommentaryProgress: async () => {},
    waitForPendingDirectBlockReplyDelivery: async () => {},
    getDispatchAbortSignal: () => undefined,
    getObservedReplyDelivery: () => false,
    throwIfDispatchOperationAborted: () => {},
    routeReplyToOriginating: route,
    isRoutedReplyDelivered: (value: any) => value.ok,
    getAgentRunTerminalOutcome: () => undefined,
    commitInboundDedupeIfClaimed: () => {},
    recordAgentDispatchCompleted: () => {}, recordProcessed: () => {}, markIdle: () => {},
    completeDispatchReplyOperation: () => {}, attachSourceReplyDeliveryMode: (value: any) => value,
  });
  return { route, result: result.result };
}

describe("actual host intentional-silence contract", () => {
  it.skipIf(baselineWithoutFinalizer)("reproduces fallback after a private sentinel is hidden only by the adapter", async () => {
    const { route, result } = await finishInvisibleReply("[SILENT]");
    expect(route).toHaveBeenCalledOnce();
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it.skipIf(baselineWithoutFinalizer)("does not manufacture a fallback after canonical silent completion", async () => {
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
    const { route, result } = await finishInvisibleReply(SILENT_REPLY_TOKEN);
    expect(route).not.toHaveBeenCalled();
    expect(result.deliberateSilentTerminalReply).toBe(true);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(baselineWithoutFinalizer)("honors channel-transform suppression for legacy silent completion", async () => {
    const prepare = await hostFunction("reply-dispatcher", "prepareReplyPayloadForDispatcher");
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    const dispatcher = createReplyDispatcher({ deliver, transformReplyPayload: transformInkboxReplyPayload });
    const outcome = prepare(dispatcher, "final", { text: "[SILENT]" });
    expect(outcome).toMatchObject({ kind: "suppress", reason: "channel_transform" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliver).not.toHaveBeenCalled();
    const { route, result } = await finishInvisibleReply("[SILENT]", outcome.reason === "channel_transform");
    expect(route).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackEligible).toBeUndefined();
  });

  it("suppresses canonical silence without dropping a normal final reply", async () => {
    const deliver = vi.fn(async () => ({ visibleReplySent: true }));
    const dispatcher = createReplyDispatcher({ deliver, transformReplyPayload: transformInkboxReplyPayload });
    expect(dispatcher.sendFinalReply({ text: SILENT_REPLY_TOKEN })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "[SILENT]" })).toBe(false);
    expect(dispatcher.sendFinalReply({ text: "Your report is ready." })).toBe(true);
    expect(dispatcher.sendFinalReply({ text: "[SILENT]", mediaUrl: "https://example.com/report.pdf" })).toBe(true);
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0]).toMatchObject({ text: "Your report is ready." });
    expect(deliver.mock.calls[1][0]).toMatchObject({ mediaUrl: "https://example.com/report.pdf" });
  });
});
