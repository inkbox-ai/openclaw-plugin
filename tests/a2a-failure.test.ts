import { describe, expect, it, vi } from "vitest";
import { a2aFailureShape, settleCaughtA2AFailure } from "../src/a2a-failure.js";

function fixture(state = "working") {
  const controller = new AbortController();
  return {
    identity: {
      a2aTask: vi.fn(async () => ({ state })),
      a2aReply: vi.fn(async () => ({ state: "failed" })),
    },
    taskId: "task-test", signal: controller.signal, controller,
    beforeFail: vi.fn(async () => {}),
  };
}

describe("caught A2A execution failures", () => {
  it("fences active work then reports one generic failure", async () => {
    const p = fixture();
    p.identity.a2aReply.mockImplementation(async () => {
      expect(p.beforeFail).toHaveBeenCalledOnce();
      return { state: "failed" };
    });
    expect(await settleCaughtA2AFailure(p)).toBe("finalized");
    expect(p.identity.a2aReply).toHaveBeenCalledOnce();
    expect(p.identity.a2aReply).toHaveBeenCalledWith("task-test", {
      intent: "fail", text: "The worker could not finish this task because its execution failed.",
    });
  });

  it.each(["completed", "failed", "canceled", "rejected", "input_required", "auth_required"])(
    "preserves authoritative %s state", async (state) => {
      const p = fixture(state);
      expect(await settleCaughtA2AFailure(p)).toBe("finalized");
      expect(p.identity.a2aReply).not.toHaveBeenCalled();
    },
  );

  it("does not overwrite a committed reply intent", async () => {
    const p = fixture();
    expect(await settleCaughtA2AFailure({ ...p, replyIntentCommitted: true })).toBe("finalized");
    expect(p.identity.a2aTask).not.toHaveBeenCalled();
    expect(p.identity.a2aReply).not.toHaveBeenCalled();
  });

  it("preserves unknown states and aborts without sending", async () => {
    const p = fixture("unknown");
    expect(await settleCaughtA2AFailure(p)).toBe("preserved");
    p.controller.abort();
    expect(await settleCaughtA2AFailure(p)).toBe("preserved");
    expect(p.identity.a2aTask).toHaveBeenCalledOnce();
    expect(p.identity.a2aReply).not.toHaveBeenCalled();
  });

  it("does not replace an ambiguously accepted earlier terminal intent", async () => {
    const p = fixture();
    expect(await settleCaughtA2AFailure({ ...p, replyIntentAttempted: true })).toBe("preserved");
    expect(p.identity.a2aTask).not.toHaveBeenCalled();
    expect(p.identity.a2aReply).not.toHaveBeenCalled();
  });

  it("does not send after cancellation during the authoritative read", async () => {
    const p = fixture();
    p.identity.a2aTask.mockImplementation(async () => {
      p.controller.abort();
      return { state: "working" };
    });
    expect(await settleCaughtA2AFailure(p)).toBe("preserved");
    expect(p.beforeFail).not.toHaveBeenCalled();
    expect(p.identity.a2aReply).not.toHaveBeenCalled();
  });

  it("does not mutate after an ambiguous read", async () => {
    const p = fixture();
    p.identity.a2aTask.mockRejectedValue(new Error("read interrupted"));
    await expect(settleCaughtA2AFailure(p)).rejects.toThrow("read interrupted");
    expect(p.identity.a2aReply).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguously accepted failure reply", async () => {
    const p = fixture();
    p.identity.a2aReply.mockRejectedValue(new Error("response lost"));
    await expect(settleCaughtA2AFailure(p)).rejects.toThrow("response lost");
    expect(p.identity.a2aReply).toHaveBeenCalledOnce();
  });
});

describe("content-free A2A diagnostics", () => {
  it("keeps only the allowlisted class and public source location", () => {
    const error = new TypeError("secret test message");
    error.stack = "TypeError: secret test message\n    at dispatch (/private/root/node_modules/openclaw/dist/lifecycle-test.js:42:9)";
    expect(a2aFailureShape("dispatch", error)).toBe(
      "A2A failure shape: stage=dispatch name=TypeError frame=lifecycle-test.js:42",
    );
  });

  it("does not print arbitrary names, paths, messages or object strings", () => {
    const error = new Error("private");
    error.name = "private-name";
    error.stack = "private\n    at /secret/private.ts:123:4";
    expect(a2aFailureShape("admission", error)).toBe(
      "A2A failure shape: stage=admission name=other frame=unknown:0",
    );
    expect(a2aFailureShape("terminal", { message: "private" })).not.toContain("private");
  });

  it("does not mistake a multiline error message for a stack frame", () => {
    const error = new Error("private\n    at /node_modules/openclaw/dist/private-value.js:12:3");
    error.stack = `Error: ${error.message}\n    at /unrecognized/file.js:4:5`;
    expect(a2aFailureShape("dispatch", error)).toBe(
      "A2A failure shape: stage=dispatch name=Error frame=unknown:0",
    );
  });
});
