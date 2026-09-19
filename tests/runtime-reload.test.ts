import { describe, expect, it, vi } from "vitest";

describe("in-flight channel state across plugin reloads", () => {
  it("keeps A2A reply ownership until the exact turn clears it", async () => {
    const channel = await import("../src/a2a-context.js");
    const turn = { taskId: "task", messageId: "message", contextId: "context", replyIntentCommitted: false };
    channel.setActiveA2ATurn("session-a", turn);
    try {
      vi.resetModules();
      const tools = await import("../src/a2a-context.js");
      expect(tools.activeA2ATurn("session-a")).toBe(turn);
      expect(tools.activeA2ATurn("session-b")).toBeUndefined();
      tools.clearActiveA2ATurn("session-a", { ...turn });
      expect(channel.activeA2ATurn("session-a")).toBe(turn);
      tools.clearActiveA2ATurn("session-a", turn);
      expect(channel.activeA2ATurn("session-a")).toBeUndefined();
    } finally {
      channel.clearActiveA2ATurn("session-a", turn);
    }
  });

  it("correlates A2A tool progress by marker and run after hook reload", async () => {
    const channel = await import("../src/a2a-progress-activity.js");
    const capture = channel.beginA2AProgressActivityCapture({ sessionKey: "session-a", promptMarker: "marker" });
    try {
      vi.resetModules();
      const hooks = await import("../src/a2a-progress-activity.js");
      const ctx = { sessionKey: "session-a", runId: "run-a" };
      hooks.bindA2AProgressActivityToRun({ prompt: "unrelated" }, ctx);
      hooks.recordA2AProgressToolActivity({ toolName: "wrong" }, ctx);
      expect(capture.snapshot()).toEqual([]);
      hooks.bindA2AProgressActivityToRun({ prompt: "marker" }, ctx);
      hooks.recordA2AProgressToolActivity({ toolName: "wrong", runId: "run-b" }, ctx);
      hooks.recordA2AProgressToolActivity({ toolName: "inkbox_list_messages" }, ctx);
      expect(capture.snapshot()).toEqual(["inkbox_list_messages"]);
      capture.finish();
      hooks.recordA2AProgressToolActivity({ toolName: "after_finish" }, ctx);
      expect(capture.snapshot()).toEqual(["inkbox_list_messages"]);
    } finally { capture.finish(); }
  });

  it("keeps hosted settlement aborts scoped to the bound run across reload", async () => {
    const channel = await import("../src/hosted-call-tool-settlement.js");
    const params = { accountId: "default", callId: "call", phase: "initial" as const, expectedTarget: "+12025550101", promptMarker: "marker" };
    const capture = channel.beginHostedSmsToolCapture({ ...params, sessionKey: "session-a" });
    const other = channel.beginHostedSmsToolCapture({ ...params, sessionKey: "session-b" });
    try {
      vi.resetModules();
      const hooks = await import("../src/hosted-call-tool-settlement.js");
      const ctx = { sessionKey: "session-a", runId: "run-a" };
      hooks.bindHostedSmsCaptureToRun({ prompt: "marker" }, ctx);
      hooks.recordHostedModelCallEnded({ runId: "run-a", outcome: "error", failureKind: "aborted" }, ctx);
      expect(capture.finish().aborted).toBe(true);
      expect(other.finish().aborted).toBe(false);
      const next = hooks.beginHostedSmsToolCapture({ ...params, sessionKey: "session-a" });
      expect(next.finish().aborted).toBe(false);
    } finally { capture.finish(); other.finish(); }
  });

  it("lets a reloaded call receiver consume outbound context exactly once", async () => {
    const tools = await import("../src/outbound-call-context.js");
    const context = tools.registerOutboundCallContext({ toNumber: "+12025550101", purpose: "Discuss the requested update" });
    const url = new URL(tools.decorateCallWebsocketUrlWithContext("wss://example.com/call", context));
    vi.resetModules();
    const channel = await import("../src/outbound-call-context.js");
    expect(channel.consumeOutboundCallContextFromUrl(url)).toBe(context);
    expect(tools.consumeOutboundCallContextFromUrl(url)).toBeUndefined();
  });

  it("retains per-recipient call origination hints while clearing current context", async () => {
    const channel = await import("../src/channel-hint.js");
    channel.resetChannelHintsForTest();
    try {
      channel.recordInboundChannelHint({ mode: "imessage", remoteAddress: "+12025550101" });
      vi.resetModules();
      const tools = await import("../src/channel-hint.js");
      expect(tools.resolveChannelHint("+12025550101")).toBe("imessage");
      tools.recordInboundChannelHint({ mode: "sms", remoteAddress: "+12025550102" });
      expect(channel.resolveChannelHint("+12025550102")).toBe("dedicated");
      expect(channel.resolveChannelHint("+12025550101")).toBe("imessage");
      tools.recordInboundChannelHint({ mode: "email" });
      expect(channel.resolveChannelHint()).toBeUndefined();
    } finally { channel.resetChannelHintsForTest(); }
  });
});
