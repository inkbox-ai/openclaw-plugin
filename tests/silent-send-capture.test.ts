import { afterEach, describe, expect, it } from "vitest";
import { beginSilentSendCapture, bindSilentSendCaptureToRun, recordSilentSendModelStarted, recordSilentSendBeforeToolCall, recordSilentSendAfterToolCall } from "../src/silent-send-capture.js";

const active: Array<ReturnType<typeof beginSilentSendCapture>> = [];
afterEach(() => { for (const capture of active.splice(0)) capture.finish(); });
const context = { sessionKey: "agent:main:inkbox:direct:example", runId: "run-1" };
const reply = { text: "A host fallback or normal source reply" };
function begin(runId = context.runId) {
  const capture = beginSilentSendCapture(context.sessionKey);
  active.push(capture); capture.activate();
  const ctx = { ...context, runId };
  bindSilentSendCaptureToRun({ prompt: `Request\n${capture.marker}` }, ctx);
  recordSilentSendModelStarted({}, ctx);
  return { capture, ctx };
}
function send(ctx = context, extra: Record<string, unknown> = {}) {
  const event = { toolName: "inkbox_send_email", toolCallId: "send-1", params: { completeSilently: true } };
  recordSilentSendBeforeToolCall(event, ctx);
  recordSilentSendAfterToolCall({ ...event, result: { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } }, ...extra }, ctx);
}

describe("run-scoped explicit send completion", () => {
  it("suppresses only after positively settled final actions and preserves errors/attachments", () => {
    const { capture } = begin();
    expect(capture.transform(reply)).toBe(reply);
    send();
    expect(capture.transform(reply)).toBeNull();
    for (const payload of [{ text: "error", isError: true }, { text: "attachment", mediaUrl: "https://example.com/a" }, { mediaUrls: ["https://example.com/a"] }, { media: { kind: "file" } }]) expect(capture.transform(payload)).toBe(payload);
    capture.finish(); expect(capture.transform(reply)).toBe(reply);
  });
  it("isolates overlapping runs in the same session", () => {
    const first = begin(); const second = begin("run-2");
    send(first.ctx);
    expect(first.capture.transform(reply)).toBeNull();
    expect(second.capture.transform(reply)).toBe(reply);
  });
  it("does not bind an unrelated prompt or an uncorrelated event", () => {
    const capture = beginSilentSendCapture(context.sessionKey); active.push(capture); capture.activate();
    bindSilentSendCaptureToRun({ prompt: "Unrelated request" }, context);
    recordSilentSendModelStarted({}, context); send();
    expect(capture.transform(reply)).toBe(reply);
    bindSilentSendCaptureToRun({ prompt: capture.marker }, { sessionKey: context.sessionKey });
    send(); expect(capture.transform(reply)).toBe(reply);
  });
  it.each([
    { error: "failed" }, { result: { isError: true, terminate: true } },
    { result: { terminate: true } }, { result: { details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } } },
  ])("keeps errors/unknown results visible: %j", (result) => {
    const { capture } = begin(); send(context, result); expect(capture.transform(reply)).toBe(reply);
  });
  it("requires a before event and an authoritative tool-call ID", () => {
    const { capture } = begin();
    recordSilentSendAfterToolCall({ toolName: "inkbox_send_email", params: { completeSilently: true }, result: { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } } }, context);
    expect(capture.transform(reply)).toBe(reply);
  });
  it("never silences a mixed or incomplete tool batch", () => {
    const { capture } = begin();
    recordSilentSendBeforeToolCall({ toolName: "inkbox_send_email", toolCallId: "other", params: { completeSilently: true } }, context);
    send(); expect(capture.transform(reply)).toBe(reply);
    recordSilentSendAfterToolCall({ toolName: "inkbox_send_email", toolCallId: "other", params: { completeSilently: false }, result: {} }, context);
    expect(capture.transform(reply)).toBe(reply);
  });
  it("invalidates a batch containing a read/nonterminal tool regardless of order", () => {
    const { capture } = begin();
    recordSilentSendBeforeToolCall({ toolName: "inkbox_list_contacts", toolCallId: "read" }, context);
    send(); expect(capture.transform(reply)).toBe(reply);
  });
  it("clears prior batch completion when the model resumes", () => {
    const { capture } = begin(); send(); expect(capture.transform(reply)).toBeNull();
    recordSilentSendModelStarted({}, context); expect(capture.transform(reply)).toBe(reply);
  });
  it("fails closed when the host omits the batch lifecycle hook", () => {
    const capture = beginSilentSendCapture(context.sessionKey); active.push(capture); capture.activate();
    bindSilentSendCaptureToRun({ prompt: capture.marker }, context);
    send(); expect(capture.transform(reply)).toBe(reply);
  });
});
