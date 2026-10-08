import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Inkbox, InkboxAPIError, IdempotencyKeyReusedError } from "@inkbox/sdk";
import { bindNativeSource, bindNativeSourceRun, recordNativeSourceProgress, type NativeSource } from "../src/native-source.js";
import { checkedSlackUpload, slackFilePayload, uploadSlackSourceFile } from "../src/slack-files.js";
import { registerSlackTools } from "../src/tools/slack.js";
import type { SlackRoute } from "../src/slack.js";

const identityId = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222", operationId = "33333333-3333-4333-8333-333333333333";
const route: SlackRoute = { identityId, connectionId, workspaceId: "TWORK", actorId: "UUSER", author: "THOME:UUSER", conversationId: "CROOM", messageTs: "1770000000.000001", threadTs: "1770000000.000001", sourceEventId: "source", mentioned: true, addressed: true, direct: false, rawText: "file", text: "file", connectionGeneration: 2 };
const connection = { id: connectionId, identityId, workspaceId: "TWORK", status: "connected", generation: 2 };
const operation = (status = "succeeded") => ({ id: operationId, connectionId, conversationId: "CROOM", operation: "file_upload", status, fileId: status === "succeeded" ? "FFILE" : null });
let dir: string, file: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "slack-file-")); file = join(dir, "chart.png"); await writeFile(file, Buffer.from([137, 80, 78, 71, 0, 255])); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(dir, { recursive: true, force: true }); });
function source(): NativeSource { return { identityId, conversationId: "logical", slackRoute: route, author: route.author, closed: false, validate: vi.fn(async () => {}), beforeSend: vi.fn(async () => {}), afterSend: vi.fn(async () => {}), afterUpload: vi.fn(async () => {}) }; }
function sdk() { return { slack: { listConnections: vi.fn(async () => ({ connections: [connection] })), uploadFile: vi.fn(async () => operation()), getOperation: vi.fn(async () => operation()) } }; }

it("sends real local bytes, exact thread and stable explicit key through the published SDK", async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input); requests.push({ url, init });
    const body = url.endsWith("/files") ? { id: operationId, connection_id: connectionId, conversation_id: "CROOM", operation: "file_upload", status: "succeeded", file_id: "FFILE" } : { connections: [{ id: connectionId, identity_id: identityId, workspace_id: "TWORK", status: "connected", generation: 2, scopes: [], created_at: "2026-01-01" }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  const client = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://sdk.test" });
  const owner = source();
  expect(await uploadSlackSourceFile(client, owner, route, { filePath: file, title: "Chart" }, "call", "upload-key")).toMatchObject({ status: "succeeded", fileId: "FFILE" });
  const write = requests.find((request) => request.url.endsWith("/files"))!;
  const payload = JSON.parse(String(write.init!.body));
  expect(Buffer.from(payload.content_base64, "base64")).toEqual(Buffer.from([137, 80, 78, 71, 0, 255]));
  expect(payload).toMatchObject({ filename: "chart.png", title: "Chart", conversation_id: "CROOM", thread_ts: route.threadTs });
  expect(new Headers(write.init!.headers).get("Idempotency-Key")).toBe("upload-key");
  expect(owner.beforeSend).toHaveBeenCalledWith("call"); expect(owner.afterUpload).toHaveBeenCalledWith("call", expect.objectContaining({ id: operationId, status: "succeeded", fileId: "FFILE" }));
});
it.each(["stopped", "generation", "workspace", "closed"])("rechecks %s before crossing the upload boundary", async (kind) => {
  const client = sdk(), owner = source();
  client.slack.listConnections.mockImplementation(async () => {
    if (kind === "stopped") owner.validate = async () => { throw new Error("stopped"); };
    if (kind === "closed") owner.closed = true;
    return { connections: [{ ...connection, ...(kind === "generation" ? { generation: 3 } : {}), ...(kind === "workspace" ? { workspaceId: "TOTHER" } : {}) }] };
  });
  await expect(uploadSlackSourceFile(client as any, owner, route, { filePath: file }, "call")).rejects.toThrow();
  expect(client.slack.uploadFile).not.toHaveBeenCalled(); expect(owner.beforeSend).not.toHaveBeenCalled();
});
it.each(["unknown", "in_progress", "failed"])("does not claim delivery or retry a %s upload", async (status) => {
  const client = sdk(), owner = source(); client.slack.uploadFile.mockResolvedValue(operation(status));
  expect((await uploadSlackSourceFile(client as any, owner, route, { filePath: file }, "call")).status).toBe(status);
  expect(client.slack.uploadFile).toHaveBeenCalledOnce(); expect(owner.afterSend).not.toHaveBeenCalled(); expect(owner.afterUpload).toHaveBeenCalledWith("call", expect.objectContaining({ status }));
});
it("never repeats a timed-out upload or records it as accepted", async () => {
  const client = sdk(), owner = source(); client.slack.uploadFile.mockRejectedValue(new Error("connection outcome unknown"));
  await expect(uploadSlackSourceFile(client as any, owner, route, { filePath: file }, "call")).rejects.toThrow("unknown");
  expect(client.slack.uploadFile).toHaveBeenCalledOnce(); expect(owner.afterUpload).not.toHaveBeenCalled(); expect(owner.beforeSend).toHaveBeenCalledOnce();
});
it("rejects unsafe filenames, URLs, directories and empty files before an upload", async () => {
  await expect(slackFilePayload({ filePath: file, filename: "../chart.png" })).rejects.toThrow();
  await expect(slackFilePayload({ filePath: "https://example.test/chart.png" })).rejects.toThrow("local file");
  await expect(slackFilePayload({ filePath: dir })).rejects.toThrow("regular file");
  await writeFile(file, ""); await expect(slackFilePayload({ filePath: file })).rejects.toThrow("regular file");
  expect(() => checkedSlackUpload({ ...operation(), fileId: null } as any, connectionId, "CROOM")).toThrow("not be confirmed");
});
it("registers source-bound upload and inspection tools without exposing the file bytes", async () => {
  const client = sdk(), owner = source(), factories: any[] = [];
  const release = bindNativeSource("file-session", owner);
  try {
    registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getClient: async () => client, getIdentity: async () => ({ id: identityId }) } as any, () => ({ slackEnabled: true }));
    const tools = factories.map((factory) => factory({ sessionKey: "file-session" }));
    const upload = tools.find((tool) => tool.name === "inkbox_slack_upload_file");
    owner.marker = "owned-marker";
    bindNativeSourceRun({ prompt: owner.marker }, { sessionKey: "file-session", sessionId: "native", runId: "run" });
    recordNativeSourceProgress({ toolName: "inkbox_slack_upload_file", toolCallId: "upload" }, { sessionKey: "file-session", sessionId: "native", runId: "run" });
    const result = await upload.execute("upload", { connectionId, conversationId: "CROOM", filePath: file, idempotencyKey: "key" });
    expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).not.toContain("contentBase64");
    expect(client.slack.uploadFile).toHaveBeenCalledWith(connectionId, expect.objectContaining({ threadTs: route.threadTs }));
    owner.closed = true;
    expect((await upload.execute("late", { connectionId, conversationId: "CROOM", filePath: file, idempotencyKey: "late" })).isError).toBe(true);
    expect(client.slack.uploadFile).toHaveBeenCalledOnce();
  } finally { release(); }
});
it("routes tool progress only from the original proven run and never a retired owner", () => {
  const owner = { ...source(), marker: "marker", progress: vi.fn() }, release = bindNativeSource("progress-session", owner);
  try {
    bindNativeSourceRun({ prompt: "marker" }, { sessionKey: "progress-session", sessionId: "native", runId: "run" });
    recordNativeSourceProgress({ toolName: "read", toolCallId: "call" }, { sessionKey: "progress-session", runId: "other" });
    expect(owner.progress).not.toHaveBeenCalled();
    recordNativeSourceProgress({ toolName: "read", toolCallId: "call" }, { sessionKey: "progress-session", runId: "run" });
    expect(owner.progress).toHaveBeenCalledWith({ tool: "read", id: "call", status: "running" });
    release();
    recordNativeSourceProgress({ toolName: "read", toolCallId: "call" }, { sessionKey: "progress-session", runId: "run" }, true);
    expect(owner.progress).toHaveBeenCalledOnce();
  } finally { release(); }
});

it("cannot rebind an established source with a later matching prompt marker", () => {
  const owner = { ...source(), marker: "marker", progress: vi.fn() }, release = bindNativeSource("immutable-run", owner);
  try {
    bindNativeSourceRun({ prompt: "marker" }, { sessionKey: "immutable-run", sessionId: "native", runId: "original" });
    bindNativeSourceRun({ prompt: "marker" }, { sessionKey: "immutable-run", sessionId: "successor", runId: "later" });
    recordNativeSourceProgress({ toolName: "read", toolCallId: "late" }, { sessionKey: "immutable-run", runId: "later" });
    expect(owner.runId).toBe("original"); expect(owner.nativeSessionId).toBe("native"); expect(owner.progress).not.toHaveBeenCalled();
  } finally { release(); }
});
it("rejects child-session uploads and same-session calls without exact run proof", async () => {
  const client = sdk(), owner = source(), factories: any[] = [], release = bindNativeSource("proof-session", owner);
  try {
    registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getClient: async () => client, getIdentity: async () => ({ id: identityId }) } as any, () => ({ slackEnabled: true }));
    for (const sessionKey of ["proof-session", "agent:main:subagent:child"]) {
      const upload = factories.map((factory) => factory({ sessionKey })).find((tool) => tool.name === "inkbox_slack_upload_file");
      expect((await upload.execute("unproven", { connectionId, conversationId: "CROOM", filePath: file, idempotencyKey: "key" })).isError).toBe(true);
    }
    expect(client.slack.uploadFile).not.toHaveBeenCalled();
  } finally { release(); }
});
it("permits owned disconnected operation inspection but still forbids new uploads", async () => {
  const client = sdk(), factories: any[] = [];
  client.slack.listConnections.mockResolvedValue({ connections: [{ ...connection, status: "disconnected" }] });
  registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getClient: async () => client, getIdentity: async () => ({ id: identityId }) } as any, () => ({ slackEnabled: true }));
  const tools = factories.map((factory) => factory({ sessionKey: "root" }));
  expect((await tools.find((tool) => tool.name === "inkbox_slack_get_operation").execute("inspect", { connectionId, operationId })).isError).not.toBe(true);
  expect((await tools.find((tool) => tool.name === "inkbox_slack_upload_file").execute("upload", { connectionId, conversationId: "CROOM", filePath: file, idempotencyKey: "key" })).isError).toBe(true);
  expect(client.slack.getOperation).toHaveBeenCalledOnce(); expect(client.slack.uploadFile).not.toHaveBeenCalled();
});

it.each([new InkboxAPIError(422, "invalid file"), new IdempotencyKeyReusedError(409, { code: "idempotency_key_reused", message: "different request" }), new InkboxAPIError(502, "upstream unavailable"), new Error("connection lost")])("records only definitive typed upload rejection: %s", async (error) => {
  const client = sdk(), owner = { ...source(), rejectUpload: vi.fn(async () => {}) };
  client.slack.uploadFile.mockRejectedValue(error);
  await expect(uploadSlackSourceFile(client as any, owner, route, { filePath: file }, "call")).rejects.toThrow();
  expect(owner.rejectUpload).toHaveBeenCalledTimes(error instanceof InkboxAPIError && error.statusCode < 500 ? 1 : 0);
  expect(owner.afterUpload).not.toHaveBeenCalled(); expect(client.slack.uploadFile).toHaveBeenCalledOnce();
});
