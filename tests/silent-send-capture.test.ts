import { afterEach, describe, expect, it, vi } from "vitest";
import { beginSilentSendCapture, bindSilentSendCaptureToRun, recordSilentSendModelStarted, recordSilentSendBeforeToolCall, recordSilentSendAfterToolCall } from "../src/silent-send-capture.js";

const active: Array<ReturnType<typeof beginSilentSendCapture>> = [];
afterEach(() => { for (const capture of active.splice(0)) capture.finish(); });
const context = { sessionKey: "agent:main:inkbox:direct:example", runId: "run-1" };
const reply = { text: "A host fallback or normal source reply" };
const nativeEmptyReply = {
  text: "I finished the turn, but it did not produce a visible reply. Please try again, or start a new session if this keeps happening.",
  isError: true,
};
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
  it("shares exact-run capture evidence across host plugin module graphs", async () => {
    const capture = beginSilentSendCapture(context.sessionKey); active.push(capture); capture.activate();
    vi.resetModules();
    const reloaded = await import("../src/silent-send-capture.js");
    expect(reloaded.beginSilentSendCapture).not.toBe(beginSilentSendCapture);
    reloaded.bindSilentSendCaptureToRun({ prompt: capture.marker }, { ...context, sessionKey: "another-session" });
    expect(capture.shape().bound).toBe(false);
    reloaded.bindSilentSendCaptureToRun({ prompt: capture.marker }, context);
    reloaded.recordSilentSendModelStarted({}, context);
    const event = { toolName: "inkbox_send_email", toolCallId: "cross-graph-send", params: { completeSilently: true } };
    reloaded.recordSilentSendBeforeToolCall(event, context);
    reloaded.recordSilentSendAfterToolCall({ ...event, result: { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } } }, context);
    expect(capture.shape()).toMatchObject({ bound: true, batch: true, accepted: 1, invalid: false });
    expect(capture.transform(reply)).toBeNull();
    capture.finish();
    reloaded.recordSilentSendModelStarted({}, context);
    expect(capture.transform(reply)).toBe(reply);
    const next = reloaded.beginSilentSendCapture(context.sessionKey); active.push(next); next.activate();
    bindSilentSendCaptureToRun({ prompt: next.marker }, context);
    expect(next.shape().bound).toBe(true);
    next.finish();
    recordSilentSendModelStarted({}, context);
    expect(next.shape().batch).toBe(false);
  });
  it("suppresses only after positively settled final actions and preserves errors/attachments", () => {
    const { capture } = begin();
    expect(capture.completedSilently()).toBe(false);
    expect(capture.transform(reply)).toBe(reply);
    send();
    expect(capture.completedSilently()).toBe(true);
    expect(capture.transform(reply)).toBeNull();
    for (const payload of [{ text: "error", isError: true }, { text: "attachment", mediaUrl: "https://example.com/a" }, { mediaUrls: ["https://example.com/a"] }, { media: { kind: "file" } }]) expect(capture.transform(payload)).toBe(payload);
    capture.finish(); expect(capture.transform(reply)).toBe(reply);
    expect(capture.completedSilently()).toBe(false);
  });
  it("isolates overlapping runs in the same session", () => {
    const first = begin(); const second = begin("run-2");
    send(first.ctx);
    expect(first.capture.transform(reply)).toBeNull();
    expect(second.capture.transform(reply)).toBe(reply);
  });
  it("suppresses only the exact native empty-reply error after an entirely accepted final batch", () => {
    const { capture } = begin();
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
    send();
    expect(capture.transform(nativeEmptyReply)).toBeNull();
    for (const payload of [
      { ...nativeEmptyReply, text: `${nativeEmptyReply.text} Extra failure.` },
      { ...nativeEmptyReply, text: "Provider request failed." },
      { ...nativeEmptyReply, mediaUrl: "https://example.com/file" },
      { ...nativeEmptyReply, mediaUrls: ["https://example.com/file"] },
      { ...nativeEmptyReply, media: { kind: "file" } },
    ]) expect(capture.transform(payload)).toBe(payload);
    capture.finish();
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it.each(["failed", "incomplete", "mixed", "unowned", "invalid"])("preserves the exact native error for %s evidence", (kind) => {
    const { capture } = begin();
    if (kind === "failed") send(context, { error: "rejected" });
    else if (kind === "unowned") send({ ...context, runId: "another-run" });
    else {
      send();
      if (kind === "mixed") recordSilentSendBeforeToolCall({ toolName: "inkbox_list_contacts", toolCallId: "read" }, context);
      else if (kind === "incomplete") recordSilentSendBeforeToolCall({ toolName: "inkbox_send_sms", toolCallId: "pending", params: { completeSilently: true } }, context);
      else recordSilentSendAfterToolCall({ toolName: "inkbox_send_email", toolCallId: "unknown" }, context);
    }
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
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
  it("keeps delayed prior-batch observers out of the current final-send proof", () => {
    const { capture } = begin();
    const prior = { toolName: "inkbox_whoami", toolCallId: "previous-model-read", params: {} };
    recordSilentSendBeforeToolCall(prior, context);
    recordSilentSendModelStarted({}, context);
    send();
    // Native streamed-block delivery can delay this observer until the next
    // model has already executed its final send (actual host regression).
    recordSilentSendAfterToolCall({ ...prior, result: { content: [] } }, context);
    expect(capture.shape()).toMatchObject({ attempts: 1, accepted: 1, invalid: false });
    expect(capture.transform(nativeEmptyReply)).toBeNull();
  });
  it("never carries prior-batch accepted sends into the current proof", () => {
    const { capture } = begin(); send();
    recordSilentSendModelStarted({}, context);
    recordSilentSendAfterToolCall({ toolName: "inkbox_send_email", toolCallId: "send-1", params: { completeSilently: true }, result: { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } } }, context);
    expect(capture.shape()).toMatchObject({ attempts: 0, accepted: 0, invalid: false });
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it.each(["unknown", "different-name"])("still rejects %s prior-batch lookalikes", (kind) => {
    const { capture } = begin();
    recordSilentSendBeforeToolCall({ toolName: "inkbox_whoami", toolCallId: "previous" }, context);
    recordSilentSendModelStarted({}, context); send();
    recordSilentSendAfterToolCall({ toolName: kind === "unknown" ? "inkbox_whoami" : "inkbox_list_contacts", toolCallId: kind === "unknown" ? "unseen" : "previous", result: {} }, context);
    expect(capture.shape().invalid).toBe(true);
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it("fails closed if a new batch reuses a previous tool-call ID", () => {
    const { capture } = begin(); send();
    recordSilentSendModelStarted({}, context); send();
    expect(capture.shape().invalid).toBe(true);
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it("does not mistake an unseen nameless callback for a prior-batch call", () => {
    const { capture } = begin(); send();
    recordSilentSendAfterToolCall({ toolCallId: "unseen", result: {} }, context);
    expect(capture.shape().invalid).toBe(true);
    expect(capture.completedSilently()).toBe(false);
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it("records only the first fixed invalidation shape, never parameter content", () => {
    const { capture } = begin();
    recordSilentSendAfterToolCall({ toolName: "private-tool", toolCallId: "private-id", params: { completeSilently: "private-body" } }, context);
    send(context, { error: "private-error" });
    expect(capture.shape().invalidShape).toEqual({ reason: "missing_before", finalParam: "string", tool: "other" });
    expect(JSON.stringify(capture.shape())).not.toContain("private");
    recordSilentSendModelStarted({}, context);
    expect(capture.shape().invalidShape).toBeUndefined();
  });
  it("diagnoses composite prior-call aliases without authorizing them or exposing IDs", () => {
    const { capture } = begin();
    recordSilentSendBeforeToolCall({ toolName: "inkbox_whoami", toolCallId: "private-call|private-first" }, context);
    recordSilentSendModelStarted({}, context); send();
    recordSilentSendAfterToolCall({ toolName: "inkbox_whoami", toolCallId: "private-call|private-second", params: { secret: "private-argument" } }, context);
    expect(capture.shape().invalidOwner).toEqual({ tool: "inkbox_whoami", name: "present", id: "event_composite", relationship: "event_only", prior: "absent", alias: true, batch: 2, before: 2, hook: "batch_owner_v2" });
    expect(JSON.stringify(capture.shape())).not.toContain("private");
    expect(capture.transform(nativeEmptyReply)).toBe(nativeEmptyReply);
  });
  it.each([undefined, { secret: "private-tool" }])("bounds missing/nonstring name diagnostics and context-only IDs", (toolName) => {
    const { capture } = begin(); send();
    recordSilentSendAfterToolCall({ toolName: toolName as unknown as string, params: { secret: "private-argument" } }, { ...context, toolCallId: "private-id" });
    expect(capture.shape().invalidOwner).toEqual({ tool: "other", name: toolName === undefined ? "missing" : "nonstring", id: "context_plain", relationship: "context_only", prior: "absent", alias: false, batch: 1, before: 1, hook: "batch_owner_v2" });
    expect(JSON.stringify(capture.shape())).not.toContain("private");
    expect(capture.completedSilently()).toBe(false);
  });
  it.each(["same", "different"])("reports only %s event/context ID relation", (relationship) => {
    const { capture } = begin(); send();
    recordSilentSendAfterToolCall({ toolCallId: "private-event" }, { ...context, toolCallId: relationship === "same" ? "private-event" : "private-context" });
    expect(capture.shape().invalidOwner?.relationship).toBe(relationship);
    expect(JSON.stringify(capture.shape())).not.toContain("private");
    expect(capture.completedSilently()).toBe(false);
  });
  it.each([[true, "true"], ["private-body", "string"]])("classifies tool_call's nested final flag without logging its value", (value, finalParam) => {
    const { capture } = begin();
    const event = { toolName: "tool_call", toolCallId: "wrapper", params: { args: { completeSilently: value } } };
    recordSilentSendBeforeToolCall(event, context);
    recordSilentSendAfterToolCall(event, context);
    expect(capture.shape().invalidShape).toEqual({ reason: "nonterminal_after", finalParam, tool: "transport" });
    expect(JSON.stringify(capture.shape())).not.toContain("private-body");
  });
  it("fails closed when the host omits the batch lifecycle hook", () => {
    const capture = beginSilentSendCapture(context.sessionKey); active.push(capture); capture.activate();
    bindSilentSendCaptureToRun({ prompt: capture.marker }, context);
    send(); expect(capture.transform(reply)).toBe(reply);
  });
});

describe("deferred send transport wrappers", () => {
  function wrapped(options: { name?: string; childParent?: string; childError?: boolean; outerError?: boolean; outerTerminal?: boolean; omitChild?: boolean } = {}) {
    const { capture } = begin();
    const name = options.name ?? "tool_call";
    const params = { id: "inkbox_send_email", args: { completeSilently: true } };
    recordSilentSendBeforeToolCall({ toolName: name, toolCallId: "outer", params }, context);
    const receipt = { terminate: true, details: { inkboxSendCompletion: { accepted: true, completeSilently: true } } };
    const child = { toolName: "inkbox_send_email", toolCallId: `tool_search_code:${options.childParent ?? "outer"}:inkbox_send_email:1`, params: { completeSilently: true } };
    if (!options.omitChild) {
      recordSilentSendBeforeToolCall(child, context);
      recordSilentSendAfterToolCall({ ...child, result: receipt, ...(options.childError ? { error: "failed" } : {}) }, context);
    }
    expect(capture.transform(reply)).toBe(reply);
    recordSilentSendAfterToolCall({
      toolName: name, toolCallId: "outer", params,
      result: { terminate: options.outerTerminal !== false, details: { tool: { name: "inkbox_send_email" }, result: receipt } },
      ...(options.outerError ? { error: "failed" } : {}),
    }, context);
    return capture;
  }
  it.each(["tool_call", "tool_search_code"])("settles successful %s only with independently accepted children", (name) => {
    expect(wrapped({ name }).transform(reply)).toBeNull();
  });
  it.each([
    { childParent: "unrelated" }, { childError: true }, { outerError: true },
    { outerTerminal: false }, { omitChild: true }, { name: "untrusted_wrapper" },
  ])("preserves visibility without both linked successful boundaries: %j", (options) => {
    expect(wrapped(options).transform(reply)).toBe(reply);
  });
  it("does not trust arbitrary code-returned receipts without observed sends", () => {
    expect(wrapped({ name: "tool_search_code", omitChild: true }).transform(reply)).toBe(reply);
  });
});
