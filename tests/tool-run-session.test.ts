import { beforeEach, describe, expect, it, vi } from "vitest";

const journalMock = vi.hoisted(() => ({
  pending: vi.fn(async () => undefined),
  settle: vi.fn(async () => undefined),
}));
vi.mock("../src/hosted-call-registry.js", () => ({
  recordHostedSmsAttemptPending: journalMock.pending,
  settleHostedSmsAttempt: journalMock.settle,
}));

import { bindToolRunSession, releaseToolRunSession, routedToolContext } from "../src/tool-run-session.js";
import {
  beginHostedSmsToolCapture,
  bindHostedSmsCaptureToRun,
  recordHostedSmsAfterToolCall,
  recordHostedSmsBeforeToolCall,
  resetHostedSmsToolCapturesForTest,
} from "../src/hosted-call-tool-settlement.js";

const routed = { sessionKey: "agent:main:main", sessionId: "native-session", runId: "run-routed" };
const policy = { ...routed, sessionKey: "agent:main:inkbox:default:direct:+15550001111", toolCallId: "child-1" };

describe("tool run session keys", () => {
  beforeEach(() => {
    releaseToolRunSession(routed);
    resetHostedSmsToolCapturesForTest();
    journalMock.pending.mockClear();
    journalMock.settle.mockClear();
  });

  it("restores the routed key only for the bound run and native session", () => {
    expect(routedToolContext(policy)).toBe(policy);
    bindToolRunSession(routed);
    expect(routedToolContext(policy)).toEqual({ ...policy, sessionKey: routed.sessionKey });
    expect(routedToolContext({ ...policy, sessionId: "other-session" }).sessionKey).toBe(policy.sessionKey);
    expect(routedToolContext({ ...policy, runId: "other-run" }).sessionKey).toBe(policy.sessionKey);
    releaseToolRunSession(policy);
    expect(routedToolContext(policy).sessionKey).toBe(routed.sessionKey);
    releaseToolRunSession(routed);
    expect(routedToolContext(policy)).toBe(policy);
  });

  it("settles a hosted SMS sent through a policy-keyed nested tool call", async () => {
    const capture = beginHostedSmsToolCapture({
      accountId: "default", callId: "call-1", phase: "initial", sessionKey: routed.sessionKey,
      expectedTarget: "+15550001111", promptMarker: "hosted-marker",
    });
    bindToolRunSession(routed);
    bindHostedSmsCaptureToRun({ prompt: "Settle hosted-marker" }, routed);
    const event = { toolName: "inkbox_send_sms", params: { to: "+15550001111", text: "Follow-up" }, toolCallId: policy.toolCallId };
    expect(await recordHostedSmsBeforeToolCall(event, routedToolContext(policy))).toBeUndefined();
    expect(journalMock.pending).toHaveBeenCalledOnce();
    await recordHostedSmsAfterToolCall({ ...event, result: { details: { inkboxSendSms: { sent: true } } } }, { ...routed, toolCallId: policy.toolCallId });
    expect(capture.finish().attempts).toMatchObject([{ outcome: "success", toolCallId: policy.toolCallId }]);
  });
});
