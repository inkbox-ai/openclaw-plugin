import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createReplyDispatcher, dispatchInboundMessageWithDispatcher, SILENT_REPLY_TOKEN } from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import { transformInkboxReplyPayload, withInkboxGroupSilenceDefault } from "../../src/silent-reply.js";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/reply-runtime")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
// The supported May baseline predates the host's no-visible-reply finalizer.
// Public dispatcher behavior is tested there; newer hosts also exercise
// end-to-end fallback and policy-permitted silence through native dispatch.
const baselineWithoutFinalizer = hostVersion === "2026.5.27";
// Earlier supported hosts let canonical silence waive a required source reply.
const nativeRequiredReplyPolicy = hostVersion.localeCompare("2026.9.6", undefined, { numeric: true }) >= 0;

// Exercise native dispatch through its public entry point. Private finalizer
// booleans changed in September; host-owned reply expectations are authoritative.
async function finishInvisibleReply(text: string, transformed = false, ambient = false, options: { eventKind?: "user_request" | "room_event"; wasMentioned?: boolean; policy?: "allow" | "disallow"; deliveryNotification?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "inkbox-host-silence-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  const deliver = vi.fn(async (payload: any) => ({ visibleReplySent: payload.text !== "[SILENT]" }));
  const transform = vi.fn(transformInkboxReplyPayload);
  const resolver = vi.fn(async () => ({ text }));
  try {
    const result = await dispatchInboundMessageWithDispatcher({
      ctx: {
        Body: "Synthetic silence contract.", From: "inkbox:sms:peer", To: "inkbox:sms:peer",
        OriginatingChannel: "inkbox", OriginatingTo: "inkbox:sms:peer", Provider: "inkbox", Surface: "inkbox",
        ChatType: ambient ? "group" : "direct", WasMentioned: options.wasMentioned ?? false,
        InboundEventKind: options.eventKind,
        InputProvenance: options.deliveryNotification
          ? { kind: "internal_system", sourceChannel: "inkbox", sourceTool: "inkbox_delivery_failure" } : undefined,
        SessionKey: `agent:main:inkbox:${ambient ? "group" : "direct"}:${randomUUID()}`,
        MessageSid: randomUUID(), CommandAuthorized: true,
      },
      cfg: withInkboxGroupSilenceDefault({
        session: { store: join(directory, "sessions.json") },
        agents: { defaults: { workspace: directory } },
        ...(options.policy ? { surfaces: { inkbox: { silentReply: { group: options.policy } } } } : {}),
      }),
      dispatcherOptions: { deliver, ...(transformed ? { transformReplyPayload: transform } : {}) },
      replyResolver: resolver,
    });
    expect(resolver).toHaveBeenCalledOnce();
    return { deliver, transform, result };
  } finally {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
}

describe("actual host intentional-silence contract", () => {
  it.skipIf(baselineWithoutFinalizer)("reproduces fallback after a private sentinel is hidden only by the adapter", async () => {
    const { deliver, result } = await finishInvisibleReply("[SILENT]");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0][0].text).toBe("[SILENT]");
    expect(deliver.mock.calls[1][0].text).not.toBe("[SILENT]");
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
  });

  it.skipIf(baselineWithoutFinalizer)("does not manufacture a fallback when ambient group policy permits canonical silence", async () => {
    expect(SILENT_REPLY_TOKEN).toBe("NO_REPLY");
    const { deliver, result } = await finishInvisibleReply(SILENT_REPLY_TOKEN, true, true);
    expect(deliver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.counts.final).toBe(0);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(baselineWithoutFinalizer)("does not send a fallback for an ambient reaction", async () => {
    const { deliver, result } = await finishInvisibleReply("NO_REPLY", true, false, { eventKind: "room_event" });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.counts.final).toBe(0);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(baselineWithoutFinalizer)("preserves automatic corrected replies for a generated delivery notification", async () => {
    const text = "Here is the corrected reply.";
    const { deliver, result } = await finishInvisibleReply(text, true, false, { deliveryNotification: true });
    expect(deliver).toHaveBeenCalledOnce();
    expect(deliver.mock.calls[0][0]).toMatchObject({ text });
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(!nativeRequiredReplyPolicy)("uses native optional completion for a generated delivery notification", async () => {
    const { deliver, result } = await finishInvisibleReply("NO_REPLY", true, false, { deliveryNotification: true });
    expect(deliver).not.toHaveBeenCalled();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(baselineWithoutFinalizer)("keeps ordinary and question-tapback visible replies available", async () => {
    for (const eventKind of [undefined, "user_request"] as const) {
      const { deliver, result } = await finishInvisibleReply("The answer is thirteen.", true, false, { eventKind, wasMentioned: true });
      expect(deliver).toHaveBeenCalledOnce();
      expect(deliver.mock.calls[0][0]).toMatchObject({ text: "The answer is thirteen." });
      expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
    }
  });

  it.skipIf(baselineWithoutFinalizer)("keeps a normal ambient-group answer available", async () => {
    const { deliver, result } = await finishInvisibleReply("The answer is thirteen.", true, true);
    expect(deliver).toHaveBeenCalledOnce();
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
  });

  it.skipIf(!nativeRequiredReplyPolicy).each([
    { name: "ordinary direct request", ambient: false, wasMentioned: false, policy: undefined },
    { name: "current group mention", ambient: true, wasMentioned: true, policy: undefined },
    { name: "explicit required group policy", ambient: true, wasMentioned: false, policy: "disallow" as const },
  ])("keeps native required replies explicit for $name", async ({ ambient, wasMentioned, policy }) => {
    const { deliver, transform, result } = await finishInvisibleReply("NO_REPLY", true, ambient, { wasMentioned, policy });
    expect(deliver).toHaveBeenCalledOnce();
    expect(result.noVisibleReplyFallbackDelivered).toBe(true);
    expect(transform.mock.calls.some(([payload]) => payload.text === "NO_REPLY")).toBe(false);
  });

  it.skipIf(baselineWithoutFinalizer)("honors channel-transform suppression for legacy silent completion", async () => {
    const { deliver, transform, result } = await finishInvisibleReply("[SILENT]", true);
    expect(transform).toHaveBeenCalledWith(expect.objectContaining({ text: "[SILENT]" }));
    expect(deliver).not.toHaveBeenCalled();
    expect(result.queuedFinal).toBe(false);
    expect(result.counts.final).toBe(0);
    expect(result.noVisibleReplyFallbackDelivered).toBeUndefined();
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
