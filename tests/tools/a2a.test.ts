import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveA2ATurn,
  setActiveA2ATurn,
  type ActiveA2ATurn,
} from "../../src/a2a-context.js";
import type { InkboxRuntime } from "../../src/client.js";
import { registerA2ATools } from "../../src/tools/a2a.js";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): {
  api: any;
  tools: Map<string, RegisteredTool>;
  contextualTools: (sessionKey: string) => Map<string, RegisteredTool>;
} {
  const tools = new Map<string, RegisteredTool>();
  const contextualFactories: Array<
    (context: { sessionKey: string }) => RegisteredTool[]
  > = [];
  return {
    api: {
      registerTool: (
        definition:
          | RegisteredTool
          | ((context: { sessionKey: string }) => RegisteredTool[]),
      ) => {
        if (typeof definition === "function") {
          contextualFactories.push(definition);
        } else {
          tools.set(definition.name, definition);
        }
      },
    },
    tools,
    contextualTools(sessionKey: string) {
      return new Map(
        contextualFactories
          .flatMap((factory) => factory({ sessionKey }))
          .map((tool) => [tool.name, tool]),
      );
    },
  };
}

function createRuntime() {
  const a2a = {
    fetchCard: vi.fn(async (url: string) => ({ rpcUrl: `${url}/rpc` })),
    send: vi.fn(async () => ({
      kind: "task",
      task: { id: "task-1", contextId: "context-1" },
    })),
    getTask: vi.fn(async () => ({
      id: "task-1",
      status: { state: "TASK_STATE_WORKING" },
    })),
    wait: vi.fn(async () => ({
      id: "task-1",
      status: { state: "TASK_STATE_COMPLETED" },
    })),
    close: vi.fn(),
  };
  const runtime: InkboxRuntime = {
    getIdentity: async () =>
      ({
        id: "identity-1",
        a2aClient: vi.fn(async () => a2a),
        a2aReply: vi.fn(async () => ({ id: "task-1", state: "completed" })),
      }) as any,
    getClient: async () => ({}) as any,
  };
  return { a2a, runtime };
}

describe("registerA2ATools", () => {
  beforeEach(() => {
    process.env.INKBOX_OPENCLAW_HOME =
      `${process.env.TMPDIR ?? "/tmp"}/openclaw-a2a-${crypto.randomUUID()}`;
  });

  it("sends a task and closes the A2A client", async () => {
    const { api, contextualTools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime);

    const result = await contextualTools("session-1")
      .get("inkbox_a2a_call")!
      .execute("turn-1", {
      cardUrl: "https://target.example/card",
      text: "Investigate.",
      messageId: "msg-1",
    });

    expect(a2a.send).toHaveBeenCalledWith(
      { rpcUrl: "https://target.example/card/rpc" },
      expect.objectContaining({ text: "Investigate.", messageId: "msg-1" }),
    );
    expect(result.content[0].text).toContain("task-1");
    expect(a2a.close).toHaveBeenCalledTimes(1);
  });

  it("only exposes inbound intent against the matching A2A session", async () => {
    const { api, contextualTools } = createApi();
    const { runtime } = createRuntime();
    registerA2ATools(api, runtime);
    const context: ActiveA2ATurn = {
      taskId: "task-1",
      contextId: "context-1",
      messageId: "message-1",
      replyIntentCommitted: false,
    };
    setActiveA2ATurn("a2a:identity-1:context-1", context);

    try {
      const wrongSession = await contextualTools("other-session")
        .get("inkbox_a2a_complete")!
        .execute("turn-1", { text: "Done." });
      expect(wrongSession.isError).toBe(true);
      expect(context.replyIntentCommitted).toBe(false);

      const result = await contextualTools("a2a:identity-1:context-1")
        .get("inkbox_a2a_complete")!
        .execute("turn-1", { text: "Done." });
      expect(result.isError).not.toBe(true);
      expect(context.replyIntentCommitted).toBe(true);
    } finally {
      clearActiveA2ATurn("a2a:identity-1:context-1", context);
    }
  });

  it("waits for a remote task", async () => {
    const { api, contextualTools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime);

    const result = await contextualTools("session-1")
      .get("inkbox_a2a_check")!
      .execute("turn-1", {
      cardUrl: "https://target.example/card",
      taskId: "task-1",
      wait: true,
    });

    expect(a2a.wait).toHaveBeenCalledWith(
      { rpcUrl: "https://target.example/card/rpc" },
      "task-1",
    );
    expect(result.content[0].text).toContain("TASK_STATE_COMPLETED");
  });

  it("blocks A2A writes outside the outbound allowlist", async () => {
    const { api, contextualTools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime, ["https://allowed.example/card"]);

    const result = await contextualTools("session-1")
      .get("inkbox_a2a_reply")!
      .execute("turn-1", {
      cardUrl: "https://blocked.example/card",
      taskId: "task-1",
      text: "More context.",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not on the outbound allowlist");
    expect(a2a.send).not.toHaveBeenCalled();
  });
});
