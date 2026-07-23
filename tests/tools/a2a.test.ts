import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { registerA2ATools } from "../../src/tools/a2a.js";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): { api: any; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  return {
    api: {
      registerTool: (definition: RegisteredTool) => {
        tools.set(definition.name, definition);
      },
    },
    tools,
  };
}

function createRuntime() {
  const a2a = {
    fetchCard: vi.fn(async (url: string) => ({ rpcUrl: `${url}/rpc` })),
    send: vi.fn(async () => ({ kind: "task", task: { id: "task-1" } })),
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
        a2aClient: vi.fn(async () => a2a),
      }) as any,
    getClient: async () => ({}) as any,
  };
  return { a2a, runtime };
}

describe("registerA2ATools", () => {
  it("sends a task and closes the A2A client", async () => {
    const { api, tools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime);

    const result = await tools.get("inkbox_a2a_call")!.execute("turn-1", {
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

  it("waits for a remote task", async () => {
    const { api, tools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime);

    const result = await tools.get("inkbox_a2a_check")!.execute("turn-1", {
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
    const { api, tools } = createApi();
    const { a2a, runtime } = createRuntime();
    registerA2ATools(api, runtime, ["https://allowed.example/card"]);

    const result = await tools.get("inkbox_a2a_reply")!.execute("turn-1", {
      cardUrl: "https://blocked.example/card",
      taskId: "task-1",
      text: "More context.",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not on the outbound allowlist");
    expect(a2a.send).not.toHaveBeenCalled();
  });
});
