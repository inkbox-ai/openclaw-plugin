import { beforeEach, describe, expect, it, vi } from "vitest";

const journalMock = vi.hoisted(() => ({
  pending: vi.fn(async () => undefined),
  settle: vi.fn(async () => undefined),
}));

vi.mock("../src/hosted-call-registry.js", () => ({
  recordHostedSmsAttemptPending: journalMock.pending,
  settleHostedSmsAttempt: journalMock.settle,
}));
import {
  beginHostedSmsToolCapture,
  bindHostedSmsCaptureToRun,
  evaluateHostedSmsSettlement,
  recordHostedModelCallEnded,
  recordHostedSmsAfterToolCall,
  recordHostedSmsBeforeToolCall,
  resetHostedSmsToolCapturesForTest,
  type HostedSmsToolReport,
} from "../src/hosted-call-tool-settlement.js";

const sessionKey = "agent:main:inkbox:direct:+15550001111";
const expectedTarget = "+15550001111";
const promptMarker = "call-hosted-1";
const context = { sessionKey, runId: "run-1", toolCallId: "tool-1" };

function beginCapture() {
  return beginHostedSmsToolCapture({
    accountId: "default",
    callId: promptMarker,
    phase: "initial",
    sessionKey,
    expectedTarget,
    promptMarker,
  });
}

function bindCapture(ctx = context) {
  bindHostedSmsCaptureToRun({ prompt: `Hosted completion ${promptMarker}` }, ctx);
}

function successResult() {
  return {
    content: [{ type: "text", text: "Sent text id=text-1" }],
    details: { inkboxSendSms: { sent: true } },
  };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function captureAttempt(params: {
  to?: unknown;
  result?: unknown;
  error?: string;
}): Promise<HostedSmsToolReport> {
  const capture = beginCapture();
  bindCapture();
  const event = {
    toolName: "inkbox_send_sms",
    params: { to: params.to, text: "Release update" },
    runId: "run-1",
    toolCallId: "tool-1",
  };
  const gate = await recordHostedSmsBeforeToolCall(event, context);
  if (!gate?.block) {
    await recordHostedSmsAfterToolCall(
      { ...event, result: params.result, error: params.error },
      context,
    );
  }
  return capture.finish();
}

describe("hosted-call SMS tool settlement", () => {
  beforeEach(() => {
    resetHostedSmsToolCapturesForTest();
    journalMock.pending.mockClear();
    journalMock.pending.mockResolvedValue(undefined);
    journalMock.settle.mockClear();
    journalMock.settle.mockResolvedValue(undefined);
  });

  it("accepts exactly one successful send to the authoritative target", async () => {
    const report = await captureAttempt({ to: expectedTarget, result: successResult() });
    expect(evaluateHostedSmsSettlement(report, "initial")).toEqual({
      outcome: "success",
      reason: "one exact-target inkbox_send_sms call succeeded",
    });
  });

  it("requests one correction for a missing initial tool call", () => {
    const capture = beginCapture();
    expect(evaluateHostedSmsSettlement(capture.finish(), "initial").outcome).toBe(
      "correction",
    );
  });

  it("blocks the provider when the durable pre-send journal fails", async () => {
    journalMock.pending.mockRejectedValueOnce(new Error("disk unavailable"));
    const capture = beginCapture();
    bindCapture();
    const gate = await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    const report = capture.finish();
    expect(gate?.block).toBe(true);
    expect(report.attempts).toMatchObject([
      { outcome: "failed", errorKind: "ambiguous_provider_failure" },
    ]);
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
    expect(journalMock.settle).not.toHaveBeenCalled();
  });

  it("durably journals pending before allowing provider execution", async () => {
    const capture = beginCapture();
    bindCapture();
    const gate = await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    expect(gate).toBeUndefined();
    expect(journalMock.pending).toHaveBeenCalledWith(
      expect.objectContaining({
        callId: promptMarker,
        phase: "initial",
        toolCallId: "tool-1",
        targetMatches: true,
      }),
    );
    capture.finish();
  });

  it("still blocks a wrong target when its terminal journal update fails", async () => {
    journalMock.settle.mockRejectedValueOnce(new Error("disk unavailable"));
    const capture = beginCapture();
    bindCapture();
    const gate = await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: "+15559999999", text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-wrong-target",
      },
      { sessionKey, runId: "run-1", toolCallId: "tool-wrong-target" },
    );
    expect(gate?.block).toBe(true);
    expect(capture.finish().attempts).toMatchObject([
      { target: "+15559999999", outcome: "failed" },
    ]);
  });

  it("treats after_tool_call without a pre-send journal as terminal", async () => {
    const capture = beginCapture();
    bindCapture();
    await recordHostedSmsAfterToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-without-before",
        result: successResult(),
      },
      { sessionKey, runId: "run-1", toolCallId: "tool-without-before" },
    );
    const report = capture.finish();
    expect(report.attempts).toMatchObject([
      { outcome: "failed", errorKind: "ambiguous_provider_failure" },
    ]);
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
    expect(journalMock.pending).toHaveBeenCalledOnce();
    expect(journalMock.settle).toHaveBeenCalledWith(
      expect.objectContaining({ errorKind: "after_hook_without_before_hook" }),
    );
  });

  it("does not settle a pending attempt from a mismatched after-hook tool ID", async () => {
    const capture = beginCapture();
    bindCapture();
    await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-before",
      },
      { sessionKey, runId: "run-1", toolCallId: "tool-before" },
    );
    await recordHostedSmsAfterToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-after",
        result: successResult(),
      },
      { sessionKey, runId: "run-1", toolCallId: "tool-after" },
    );
    const report = capture.finish();
    expect(report.attempts).toMatchObject([
      { toolCallId: "tool-before", outcome: "pending" },
      { toolCallId: "tool-after", outcome: "failed" },
    ]);
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("fails closed until before_agent_run binds the exact run", () => {
    const capture = beginCapture();
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    expect(capture.finish().attempts).toHaveLength(0);
  });

  it("does not bind an unrelated same-session run without the prompt marker", () => {
    const capture = beginCapture();
    bindHostedSmsCaptureToRun({ prompt: "Unrelated same-session work" }, context);
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Unrelated send" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    expect(capture.finish().attempts).toHaveLength(0);
  });

  it("rejects missing and mismatched run IDs after binding", () => {
    const capture = beginCapture();
    bindCapture();
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "missing run" },
        toolCallId: "tool-missing-run",
      },
      { sessionKey, toolCallId: "tool-missing-run" },
    );
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "wrong run" },
        runId: "run-other",
        toolCallId: "tool-other",
      },
      { sessionKey, runId: "run-other", toolCallId: "tool-other" },
    );
    expect(capture.finish().attempts).toHaveLength(0);
  });

  it("requests one correction for a recoverable content rejection", async () => {
    const rawProviderError =
      "Validation error (422): content rule markdown rejected secret-provider-payload";
    const report = await captureAttempt({
      to: expectedTarget,
      result: errorResult(rawProviderError),
    });
    expect(report.attempts[0].errorKind).toBe("content_rejected");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("correction");
    expect(JSON.stringify(report)).not.toContain("secret-provider-payload");
  });

  it("stops on terminal failures and never asks for correction", async () => {
    const report = await captureAttempt({
      to: expectedTarget,
      result: errorResult("Recipient has opted out of SMS"),
    });
    expect(report.attempts[0].errorKind).toBe("recipient_terminal");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("stops after any correction failure, including another recoverable failure", async () => {
    const report = await captureAttempt({
      to: expectedTarget,
      result: errorResult("Validation error (422): content rule markdown rejected"),
    });
    expect(evaluateHostedSmsSettlement(report, "correction").outcome).toBe("terminal");
  });

  it.each([
    "Inkbox API error (408): timed out",
    "Inkbox API error (425): too early",
    "Inkbox API error (429): backoff",
    "Inkbox API error (503): unavailable",
    "duplicate request with unknown commit status",
    "carrier unavailable",
  ])("treats commit-ambiguous failure as terminal: %s", async (message) => {
    const report = await captureAttempt({ to: expectedTarget, result: errorResult(message) });
    expect(report.attempts[0].errorKind).toBe("ambiguous_provider_failure");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("does not accept a non-error result without positive send evidence", async () => {
    const report = await captureAttempt({
      to: expectedTarget,
      result: { content: [{ type: "text", text: "Tool finished" }] },
    });
    expect(report.attempts[0]).toMatchObject({
      outcome: "failed",
      errorKind: "ambiguous_provider_failure",
    });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("accepts the structured positive send contract", async () => {
    const report = await captureAttempt({
      to: expectedTarget,
      result: {
        content: [{ type: "text", text: "redacted" }],
        details: { inkboxSendSms: { sent: true } },
      },
    });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("success");
  });

  it("stops on a wrong target even when the tool reports success", async () => {
    const report = await captureAttempt({ to: "+15559999999", result: successResult() });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("accepts a one-element recipient array but rejects multi-target sends", async () => {
    const one = await captureAttempt({ to: [expectedTarget], result: successResult() });
    expect(evaluateHostedSmsSettlement(one, "initial").outcome).toBe("success");

    resetHostedSmsToolCapturesForTest();
    const many = await captureAttempt({
      to: [expectedTarget, "+15559999999"],
      result: successResult(),
    });
    expect(evaluateHostedSmsSettlement(many, "initial").outcome).toBe("terminal");
  });

  it("blocks a second SMS before provider execution and settles the turn terminal", async () => {
    const capture = beginCapture();
    bindCapture();
    const gates: Array<{ block?: boolean } | void> = [];
    for (const id of ["tool-1", "tool-2"]) {
      const ctx = { sessionKey, runId: "run-1", toolCallId: id };
      const event = {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: `message ${id}` },
        runId: "run-1",
        toolCallId: id,
      };
      const gate = await recordHostedSmsBeforeToolCall(event, ctx);
      gates.push(gate);
      if (!gate?.block) {
        await recordHostedSmsAfterToolCall({ ...event, result: successResult() }, ctx);
      }
    }
    expect(gates).toEqual([undefined, expect.objectContaining({ block: true })]);
    expect(journalMock.pending).toHaveBeenCalledOnce();
    expect(evaluateHostedSmsSettlement(capture.finish(), "initial").outcome).toBe(
      "terminal",
    );
  });

  it("records an in-flight attempt as unknown if the agent ends before after_tool_call", async () => {
    const capture = beginCapture();
    bindCapture();
    await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "Release update" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    const report = capture.finish();
    expect(report.attempts[0].outcome).toBe("pending");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("marks aborted and terminated model runs terminal", () => {
    for (const failureKind of ["aborted", "terminated"] as const) {
      const capture = beginCapture();
      bindCapture();
      recordHostedModelCallEnded(
        { runId: "run-1", outcome: "error", failureKind },
        { sessionKey, runId: "run-1" },
      );
      const report = capture.finish();
      expect(report.aborted).toBe(true);
      expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
    }
  });

  it("ignores tools from other sessions and blocks uncorrelated same-session runs", async () => {
    const capture = beginCapture();
    bindCapture();
    await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "wrong session" },
        runId: "run-other",
        toolCallId: "tool-other",
      },
      { sessionKey: "agent:main:other", runId: "run-other" },
    );
    await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "right run" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    const blocked = await recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "wrong run" },
        runId: "run-2",
        toolCallId: "tool-2",
      },
      { sessionKey, runId: "run-2", toolCallId: "tool-2" },
    );
    expect(blocked?.block).toBe(true);
    expect(capture.finish().attempts).toHaveLength(1);
  });
});
