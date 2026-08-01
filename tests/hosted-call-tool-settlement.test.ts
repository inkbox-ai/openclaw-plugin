import { beforeEach, describe, expect, it } from "vitest";
import {
  beginHostedSmsToolCapture,
  evaluateHostedSmsSettlement,
  recordHostedModelCallEnded,
  recordHostedSmsAfterToolCall,
  recordHostedSmsBeforeToolCall,
  resetHostedSmsToolCapturesForTest,
  type HostedSmsToolReport,
} from "../src/hosted-call-tool-settlement.js";

const sessionKey = "agent:main:inkbox:direct:+15550001111";
const expectedTarget = "+15550001111";
const context = { sessionKey, runId: "run-1", toolCallId: "tool-1" };

function successResult() {
  return {
    content: [{ type: "text", text: "Sent text id=text-1" }],
    details: { inkboxSendSms: { sent: true } },
  };
}

function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}

function captureAttempt(params: {
  to?: unknown;
  result?: unknown;
  error?: string;
}): HostedSmsToolReport {
  const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
  const event = {
    toolName: "inkbox_send_sms",
    params: { to: params.to, text: "Release update" },
    runId: "run-1",
    toolCallId: "tool-1",
  };
  recordHostedSmsBeforeToolCall(event, context);
  recordHostedSmsAfterToolCall({ ...event, result: params.result, error: params.error }, context);
  return capture.finish();
}

describe("hosted-call SMS tool settlement", () => {
  beforeEach(() => resetHostedSmsToolCapturesForTest());

  it("accepts exactly one successful send to the authoritative target", () => {
    const report = captureAttempt({ to: expectedTarget, result: successResult() });
    expect(evaluateHostedSmsSettlement(report, "initial")).toEqual({
      outcome: "success",
      reason: "one exact-target inkbox_send_sms call succeeded",
    });
  });

  it("requests one correction for a missing initial tool call", () => {
    const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
    expect(evaluateHostedSmsSettlement(capture.finish(), "initial").outcome).toBe(
      "correction",
    );
  });

  it("requests one correction for a recoverable content rejection", () => {
    const rawProviderError =
      "Validation error (422): content rule markdown rejected secret-provider-payload";
    const report = captureAttempt({
      to: expectedTarget,
      result: errorResult(rawProviderError),
    });
    expect(report.attempts[0].errorKind).toBe("content_rejected");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("correction");
    expect(JSON.stringify(report)).not.toContain("secret-provider-payload");
  });

  it("stops on terminal failures and never asks for correction", () => {
    const report = captureAttempt({
      to: expectedTarget,
      result: errorResult("Recipient has opted out of SMS"),
    });
    expect(report.attempts[0].errorKind).toBe("recipient_terminal");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("stops after any correction failure, including another recoverable failure", () => {
    const report = captureAttempt({
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
  ])("treats commit-ambiguous failure as terminal: %s", (message) => {
    const report = captureAttempt({ to: expectedTarget, result: errorResult(message) });
    expect(report.attempts[0].errorKind).toBe("ambiguous_provider_failure");
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("does not accept a non-error result without positive send evidence", () => {
    const report = captureAttempt({
      to: expectedTarget,
      result: { content: [{ type: "text", text: "Tool finished" }] },
    });
    expect(report.attempts[0]).toMatchObject({
      outcome: "failed",
      errorKind: "ambiguous_provider_failure",
    });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("accepts the structured positive send contract", () => {
    const report = captureAttempt({
      to: expectedTarget,
      result: {
        content: [{ type: "text", text: "redacted" }],
        details: { inkboxSendSms: { sent: true } },
      },
    });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("success");
  });

  it("stops on a wrong target even when the tool reports success", () => {
    const report = captureAttempt({ to: "+15559999999", result: successResult() });
    expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
  });

  it("accepts a one-element recipient array but rejects multi-target sends", () => {
    const one = captureAttempt({ to: [expectedTarget], result: successResult() });
    expect(evaluateHostedSmsSettlement(one, "initial").outcome).toBe("success");

    resetHostedSmsToolCapturesForTest();
    const many = captureAttempt({
      to: [expectedTarget, "+15559999999"],
      result: successResult(),
    });
    expect(evaluateHostedSmsSettlement(many, "initial").outcome).toBe("terminal");
  });

  it("stops when one turn makes more than one SMS attempt", () => {
    const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
    for (const id of ["tool-1", "tool-2"]) {
      const ctx = { sessionKey, runId: "run-1", toolCallId: id };
      const event = {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: `message ${id}` },
        runId: "run-1",
        toolCallId: id,
      };
      recordHostedSmsBeforeToolCall(event, ctx);
      recordHostedSmsAfterToolCall({ ...event, result: successResult() }, ctx);
    }
    expect(evaluateHostedSmsSettlement(capture.finish(), "initial").outcome).toBe(
      "terminal",
    );
  });

  it("records an in-flight attempt as unknown if the agent ends before after_tool_call", () => {
    const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
    recordHostedSmsBeforeToolCall(
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
      const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
      recordHostedModelCallEnded(
        { runId: "run-1", outcome: "error", failureKind },
        { sessionKey, runId: "run-1" },
      );
      const report = capture.finish();
      expect(report.aborted).toBe(true);
      expect(evaluateHostedSmsSettlement(report, "initial").outcome).toBe("terminal");
    }
  });

  it("ignores tools from other sessions and runs", () => {
    const capture = beginHostedSmsToolCapture({ sessionKey, expectedTarget });
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "wrong session" },
        runId: "run-other",
        toolCallId: "tool-other",
      },
      { sessionKey: "agent:main:other", runId: "run-other" },
    );
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "right run" },
        runId: "run-1",
        toolCallId: "tool-1",
      },
      context,
    );
    recordHostedSmsBeforeToolCall(
      {
        toolName: "inkbox_send_sms",
        params: { to: expectedTarget, text: "wrong run" },
        runId: "run-2",
        toolCallId: "tool-2",
      },
      { sessionKey, runId: "run-2", toolCallId: "tool-2" },
    );
    expect(capture.finish().attempts).toHaveLength(1);
  });
});
