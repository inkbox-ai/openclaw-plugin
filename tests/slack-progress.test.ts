import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackProgress, type ProgressRoute } from "../src/slack-progress.js";
import { slackMrkdwn } from "../src/slack-style.js";

const route: ProgressRoute = {
  identityId: "identity",
  connectionId: "connection",
  workspaceId: "TINSTALL",
  recipientTeamId: "THOME",
  author: "THOME:UACTOR",
  actorId: "UACTOR",
  conversationId: "CROOM",
  messageTs: "1.1",
  threadTs: "1.0",
  sourceEventId: "source",
};
const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(native = false) {
  const dir = mkdtempSync(join(tmpdir(), "progress-"));
  dirs.push(dir);
  const result = (status = "succeeded") => ({
    id: "operation",
    status,
    messageTs: "2.0",
    connectionId: route.connectionId,
    conversationId: route.conversationId,
  });
  const slack: any = {
    sendMessage: vi.fn(async () => result("sent")),
    updateMessage: vi.fn(async () => result()),
    getAction: vi.fn(async () => result("sent")),
    getOperation: vi.fn(async () => result()),
    capabilities: vi.fn(async () => ({
      nativeTaskStreaming: "unknown",
      capabilities: { task_streaming: { scopesSatisfied: true } },
    })),
  };
  if (native)
    Object.assign(slack, {
      startStream: vi.fn(async () => result()),
      appendStream: vi.fn(async () => result()),
      stopStream: vi.fn(async () => result()),
      getOperationByKey: vi.fn(async () => result()),
    });
  const options = { resource: async () => slack, path: join(dir, "progress.json"), warn: vi.fn() };
  return { slack, options, p: createSlackProgress(options), result };
}
describe("durable Slack task progress", () => {
  it("uses one fallback message, updates it, and never invents a thread for inline DMs", async () => {
    const d = fixture(),
      inline = { ...route, threadTs: null };
    d.p.notify(inline, "accepted");
    await d.p.flush();
    d.p.observe(inline, { id: "call", tool: "bash", status: "running" });
    await d.p.flush();
    d.p.notify(inline, "completed");
    await d.p.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.sendMessage.mock.calls[0][1]).toMatchObject({
      threadTs: null,
      text: "Working…",
    });
    expect(d.slack.updateMessage.mock.calls.map((c: any) => c[3])).toEqual([
      "Running a check…",
      "Completed",
    ]);
  });
  it("uses typed native operations, canonical home team, and the start operation UUID", async () => {
    const d = fixture(true);
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.p.notify(route, "waiting");
    await d.p.flush();
    d.p.notify(route, "cancelled");
    await d.p.flush();
    expect(d.slack.startStream.mock.calls[0][2]).toMatchObject({
      threadTs: "1.0",
      recipientTeamId: "THOME",
      recipientUserId: "UACTOR",
    });
    expect(d.slack.appendStream.mock.calls[0][2]).toBe("operation");
    expect(d.slack.stopStream.mock.calls[0][3].chunks[0]).toMatchObject({
      title: "Stopped",
      status: "complete",
    });
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("falls back only after an explicit unsupported native result", async () => {
    const d = fixture(true);
    d.slack.startStream.mockResolvedValue({
      ...d.result("failed"),
      errorCode: "invalid_thread_ts",
    });
    d.p.notify(route, "accepted");
    await d.p.flush();
    await d.p.flush();
    expect(d.slack.startStream).toHaveBeenCalledOnce();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
  });
  it("does not fallback or replay after a lost native start response; recovers with a read", async () => {
    const d = fixture(true);
    d.slack.startStream.mockRejectedValue(new Error("response lost"));
    d.p.notify(route, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
    const recovered = createSlackProgress(d.options);
    await recovered.recover();
    recovered.notify(route, "completed");
    await recovered.flush();
    expect(d.slack.startStream).toHaveBeenCalledOnce();
    expect(d.slack.getOperationByKey).toHaveBeenCalledOnce();
    expect(d.slack.stopStream).toHaveBeenCalledOnce();
  });
  it("never recreates a fallback message whose response was lost, even after restart", async () => {
    const d = fixture();
    d.slack.sendMessage.mockRejectedValue(new Error("lost"));
    d.p.notify(route, "accepted");
    await d.p.flush();
    const recovered = createSlackProgress(d.options);
    await recovered.recover();
    recovered.notify(route, "failed");
    await recovered.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage).not.toHaveBeenCalled();
  });
  it("retains a definitive unknown without repeatedly reading or resending it", async () => {
    const d = fixture();
    d.slack.sendMessage.mockResolvedValue(d.result("unknown"));
    d.p.notify(route, "accepted"); await d.p.flush();
    d.p.notify(route, "completed"); await d.p.flush();
    for (let i = 0; i < 8; i++) await createSlackProgress(d.options).recover();
    expect(d.slack.getAction).not.toHaveBeenCalled();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage).not.toHaveBeenCalled();
    expect(Object.values(JSON.parse(readFileSync(d.options.path, "utf8")))[0]).toMatchObject({ pending: { outcomeUnknown: true }, terminal: true });
  });
  it("does not resolve a provider resource for unchanged applied progress", async () => {
    const d = fixture(), resource = vi.fn(d.options.resource);
    const p = createSlackProgress({ ...d.options, resource });
    p.notify(route, "accepted"); await p.flush();
    for (let i = 0; i < 8; i++) { p.notify(route, "accepted"); await p.flush(); await p.recover(); }
    expect(resource).toHaveBeenCalledOnce();
  });
  it("bounds pending read-only reconciliation across repeated restarts", async () => {
    const d = fixture(true);
    d.slack.startStream.mockRejectedValue(new Error("response lost"));
    d.slack.getOperationByKey.mockRejectedValue(new Error("not visible"));
    d.p.notify(route, "accepted"); await d.p.flush();
    for (let i = 0; i < 12; i++) await createSlackProgress(d.options).recover();
    expect(d.slack.getOperationByKey).toHaveBeenCalledTimes(5);
    expect(d.slack.startStream).toHaveBeenCalledOnce();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("checks ownership again after a delayed capability read", async () => {
    const d = fixture(true);
    let allowed = true;
    d.slack.capabilities.mockImplementation(async () => {
      allowed = false;
      return { capabilities: { task_streaming: { scopesSatisfied: true } } };
    });
    const p = createSlackProgress({ ...d.options, authorize: () => allowed });
    p.notify(route, "accepted");
    await p.flush();
    expect(d.slack.startStream).not.toHaveBeenCalled();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("coalesces raw tool events into safe labels and ignores stale events after terminal", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.p.observe(route, {
      id: "private-id",
      tool: "/private/path secret raw task",
      status: "running",
    });
    await d.p.flush();
    d.p.observe(route, { id: "private-id", tool: "same", status: "running" });
    await d.p.flush();
    d.p.notify(route, "cancelled");
    await d.p.flush();
    d.p.observe(route, { id: "late", tool: "bash", status: "running" });
    await d.p.flush();
    expect(d.slack.updateMessage).toHaveBeenCalledTimes(2);
    expect(readFileSync(d.options.path, "utf8")).not.toMatch(/private-id|private\/path|secret/);
  });
  it("does not create a card for a task already completed before dispatch", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    d.p.notify(route, "completed");
    await d.p.flush();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("isolates different sources and connections sharing a thread", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    d.p.notify({ ...route, sourceEventId: "next" }, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledTimes(2);
    expect(d.slack.sendMessage.mock.calls[0][1].idempotencyKey).not.toBe(
      d.slack.sendMessage.mock.calls[1][1].idempotencyKey,
    );
  });
  it("checkpoints before dispatch and prevents two controllers from duplicating a create", async () => {
    const d = fixture();
    let release!: () => void;
    d.slack.sendMessage.mockImplementation(async () => {
      expect(readFileSync(d.options.path, "utf8")).toContain('"pending"');
      await new Promise<void>((r) => {
        release = r;
      });
      return d.result("sent");
    });
    d.p.notify(route, "accepted");
    const flushing = d.p.flush();
    await vi.waitFor(() => expect(release).toBeDefined());
    const another = createSlackProgress(d.options);
    another.notify(route, "accepted");
    await another.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    release();
    await flushing;
  });
  it("recovers a response-lost fallback edit by key without repeating the mutation", async () => {
    const d = fixture(true);
    const inline = { ...route, threadTs: null };
    d.p.notify(inline, "accepted");
    await d.p.flush();
    d.slack.updateMessage.mockRejectedValueOnce(new Error("response lost"));
    d.p.notify(inline, "waiting");
    await d.p.flush();
    const recovered = createSlackProgress(d.options);
    await recovered.recover();
    expect(d.slack.getOperationByKey).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage).toHaveBeenCalledOnce();
    recovered.notify(inline, "completed");
    await recovered.flush();
    expect(d.slack.updateMessage).toHaveBeenCalledTimes(2);
  });
  it("a non-owning recovery/close cannot poison another active source's desired state", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    const foreign = createSlackProgress({ ...d.options, authorize: () => false });
    await foreign.recover();
    foreign.notify(route, "cancelled");
    await foreign.close();
    const saved = Object.values(JSON.parse(readFileSync(d.options.path, "utf8"))) as any[];
    expect(saved[0].terminal).toBe(false);
    d.p.notify(route, "waiting");
    await d.p.flush();
    expect(d.slack.updateMessage.mock.calls.at(-1)?.[3]).toBe("Waiting for your approval…");
  });
  it("uses baseline getActionByKey after a lost fallback-create response", async () => {
    const d = fixture();
    d.slack.sendMessage.mockRejectedValueOnce(new Error("response lost"));
    d.slack.getActionByKey = vi.fn(async () => d.result("sent"));
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.p.notify(route, "completed");
    await d.p.flush();
    expect(d.slack.getActionByKey).toHaveBeenCalledOnce();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage).toHaveBeenCalledOnce();
  });
  it("polls accepted in-progress effects read-only until terminal cleanup can complete", async () => {
    vi.useFakeTimers();
    const d = fixture();
    d.slack.sendMessage.mockResolvedValue(d.result("sending"));
    d.slack.getAction.mockResolvedValueOnce(d.result("sending"));
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.p.notify(route, "completed");
    await d.p.flush();
    await vi.advanceTimersByTimeAsync(1100);
    await d.p.flush();
    expect(d.slack.getAction).toHaveBeenCalledTimes(2);
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage).toHaveBeenCalledOnce();
  });
  it("pauses a resumable source at shutdown and resumes the same card after reconnect", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    await d.p.close();
    expect(d.slack.updateMessage.mock.calls.at(-1)?.[3]).toBe("Paused while reconnecting…");
    const recovered = createSlackProgress(d.options);
    await recovered.recover();
    recovered.notify(route, "accepted");
    await recovered.flush();
    recovered.notify(route, "completed");
    await recovered.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
    expect(d.slack.updateMessage.mock.calls.at(-1)?.[3]).toBe("Completed");
  });
  it("does not let an unreadable progress journal prevent host shutdown", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    writeFileSync(d.options.path, "not JSON");
    await expect(d.p.close()).resolves.toBeUndefined();
    expect(d.options.warn).toHaveBeenCalledWith(expect.stringContaining("shutdown will continue"));
    expect(d.slack.updateMessage).not.toHaveBeenCalled();
    writeFileSync(d.options.path, "{}");
    d.p.notify(route, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
  });
  it("reclaims only a proven-dead writer lock, never a live writer", async () => {
    const d = fixture();
    writeFileSync(`${d.options.path}.lock`, JSON.stringify({ pid: process.pid }));
    d.p.notify(route, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
    writeFileSync(`${d.options.path}.lock`, JSON.stringify({ pid: 2147483647 }));
    d.p.notify(route, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
  });
  it("falls back if only an installation workspace is known, never guessing Slack Connect actor home team", async () => {
    const d = fixture(true);
    d.p.notify({ ...route, recipientTeamId: undefined }, "accepted");
    await d.p.flush();
    expect(d.slack.startStream).not.toHaveBeenCalled();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
  });
  it("retires a definitively rejected terminal update and does not probe it on every restart", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.slack.updateMessage.mockResolvedValue({
      ...d.result("failed"),
      errorCode: "invalid_arguments",
    });
    d.p.notify(route, "completed");
    await d.p.flush();
    const resource = vi.fn(d.options.resource);
    const recovered = createSlackProgress({ ...d.options, resource });
    await recovered.recover();
    expect(resource).not.toHaveBeenCalled();
    expect(Object.values(JSON.parse(readFileSync(d.options.path, "utf8")))[0]).toMatchObject({
      done: true,
    });
  });
  it("recovers a dead reclaimer as well as the original dead writer", async () => {
    const d = fixture();
    writeFileSync(`${d.options.path}.lock`, JSON.stringify({ pid: 2147483647 }));
    writeFileSync(`${d.options.path}.lock.recovery`, JSON.stringify({ pid: 2147483647 }));
    d.p.notify(route, "accepted");
    await d.p.flush();
    expect(d.slack.sendMessage).toHaveBeenCalledOnce();
  });
  it("does not reuse a result for another destination", async () => {
    const d = fixture();
    d.slack.sendMessage.mockResolvedValue({ ...d.result("sent"), conversationId: "COTHER" });
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.p.notify(route, "completed");
    await d.p.flush();
    expect(d.slack.updateMessage).not.toHaveBeenCalled();
  });
  it("allows a terminal edit after a definitively rejected earlier update", async () => {
    const d = fixture();
    d.p.notify(route, "accepted");
    await d.p.flush();
    d.slack.updateMessage.mockResolvedValueOnce({
      ...d.result("failed"),
      errorCode: "invalid_arguments",
    });
    d.p.notify(route, "waiting");
    await d.p.flush();
    vi.useFakeTimers();
    d.p.notify(route, "completed");
    await d.p.flush();
    await vi.advanceTimersByTimeAsync(1100);
    await d.p.flush();
    expect(d.slack.updateMessage).toHaveBeenCalledTimes(2);
    expect(d.slack.updateMessage.mock.calls[1][3]).toBe("Completed");
  });
  it("does not dispatch if durable storage fails", async () => {
    const d = fixture();
    const p = createSlackProgress({ ...d.options, path: "/dev/null/progress.json" });
    p.notify(route, "accepted");
    await p.flush();
    expect(d.slack.sendMessage).not.toHaveBeenCalled();
  });
});
it("repairs Slack formatting without changing inline or fenced code", () => {
  expect(
    slackMrkdwn(
      "**Done** [PR](https://example.test/123) `**x**`\n```\n**raw** [x](https://code.test)\n```",
    ),
  ).toBe("*Done* <https://example.test/123|PR> `**x**`\n```\n**raw** [x](https://code.test)\n```");
});
it("the installed published SDK fallback sends the actual update wire contract", async () => {
  const requests: Array<{ path: string; body: any }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: any, init: any) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return new Response(
        JSON.stringify({
          id: "00000000-0000-4000-8000-000000000001",
          connection_id: route.connectionId,
          conversation_id: route.conversationId,
          message_ts: "2.0",
          status: init.method === "PATCH" ? "succeeded" : "sent",
          operation: "message_update",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const d = fixture();
  const sdk = new Inkbox({ apiKey: "test-key", baseUrl: "https://example.test" });
  const p = createSlackProgress({
    ...d.options,
    resource: async () => ({
      sendMessage: sdk.slack.sendMessage.bind(sdk.slack),
      updateMessage: sdk.slack.updateMessage.bind(sdk.slack),
      getAction: sdk.slack.getAction.bind(sdk.slack),
      getOperation: sdk.slack.getOperation.bind(sdk.slack),
    }),
  });
  p.notify(route, "accepted");
  await p.flush();
  p.notify(route, "completed");
  await p.flush();
  expect(requests).toHaveLength(2);
  expect(requests[1]!.body).toEqual({ text: "Completed" });
  expect(requests[1]!.path).toContain("/messages/2.0");
});

it.skipIf(typeof (new Inkbox({ apiKey: "test-key" }).slack as any).startStream !== "function")(
  "candidate typed SDK native operations keep exact stream source and wire chunks",
  async () => {
    const requests: Array<{ path: string; body: any }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: any, init: any) => {
        const path = new URL(url).pathname;
        if (path.endsWith("/capabilities"))
          return new Response(
            JSON.stringify({
              connection_id: route.connectionId,
              native_task_streaming: "unknown",
              capabilities: {
                task_streaming: {
                  scopes_satisfied: true,
                  required_scopes: ["chat:write"],
                  missing_scopes: [],
                },
              },
            }),
            { headers: { "Content-Type": "application/json" } },
          );
        requests.push({ path, body: JSON.parse(init.body) });
        return new Response(
          JSON.stringify({
            id: "00000000-0000-4000-8000-000000000001",
            connection_id: route.connectionId,
            conversation_id: route.conversationId,
            message_ts: "2.0",
            thread_ts: "1.0",
            status: "succeeded",
            operation: "stream_start",
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    const d = fixture();
    const sdk = new Inkbox({ apiKey: "test-key", baseUrl: "https://example.test" });
    const p = createSlackProgress({ ...d.options, resource: async () => sdk.slack });
    p.notify(route, "accepted");
    await p.flush();
    p.notify(route, "waiting");
    await p.flush();
    p.notify(route, "completed");
    await p.flush();
    expect(requests).toHaveLength(3);
    expect(requests[0]?.body).toMatchObject({
      thread_ts: "1.0",
      recipient_user_id: "UACTOR",
      recipient_team_id: "THOME",
      task_display_mode: "timeline",
      chunks: [{ type: "task_update", id: "work", title: "Working…", status: "in_progress" }],
    });
    expect(requests[2]?.path).toContain("/streams/00000000-0000-4000-8000-000000000001/stop");
    expect(requests[2]?.body.chunks[0].status).toBe("complete");
  },
);

it("escapes Slack link label delimiters and URL ampersands", () => {
  expect(slackMrkdwn("[a > b & c](https://example.test/?a=1&b=2)")).toBe(
    "<https://example.test/?a=1&amp;b=2|a &gt; b &amp; c>",
  );
});
