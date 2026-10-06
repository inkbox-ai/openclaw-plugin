import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Inkbox } from "@inkbox/sdk";
import { parseSlack, prepareSlackSource, reconcileSlackSubscription, sendSlackReply, SLACK_SUBSCRIPTION_EVENTS, type SlackRoute } from "../src/slack.js";
import { createSlackActivity } from "../src/slack-activity.js";
import { configureSlack } from "../src/slack-setup.js";
import { registerSlackTools } from "../src/tools/slack.js";
import { bindNativeSource } from "../src/native-source.js";
const identityId = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222", sourceId = "33333333-3333-4333-8333-333333333333";
const connection = { id: connectionId, identityId, workspaceId: "TINSTALL", botUserId: "UBOT", status: "connected" };
function event(extra: Record<string, any> = {}) { return { id: "event-1", event_type: "slack.mention_received", data: { identity_id: identityId, connection_id: connectionId, workspace_id: "TINSTALL", conversation_id: "CROOM", actor_id: "UPERSON", message_ts: "1770000000.000123", thread_ts: null, message_kinds: ["mention"], sender_access: "direct", event: { type: "message", text: "<@UBOT> Hello" }, actor_profile: { id: "UPERSON", team_id: "THOME" }, ...extra } }; }
function client() { return { slack: { listConnections: vi.fn(async () => ({ connections: [connection] })), listArchivedMessages: vi.fn(async () => ({ messages: [{ id: sourceId, connectionId, conversationId: "CROOM", messageTs: "1770000000.000123", threadTs: null, userId: "UPERSON", source: "event" }], nextCursor: null })), getUser: vi.fn(), sendMessage: vi.fn(async () => ({ id: "action", status: "sent" })) } }; }
afterEach(() => vi.unstubAllGlobals());
describe("Slack signed source and published SDK contract", () => {
  it.each(["denied", "unknown", "sponsored", "other"])("drops %s ordinary sender access", (sender_access) => { expect(parseSlack(event({ sender_access }), identityId)).toBeUndefined(); });
  it("separates ordinary mention roots from Companion inline roots and canonical home authors", async () => {
    const incoming = event(), sdk = client();
    expect(parseSlack(incoming, identityId)?.threadTs).toBe("1770000000.000123");
    const source = await prepareSlackSource(sdk as any, identityId, { ...incoming, companion: {} });
    expect(source.route.threadTs).toBeNull(); expect(source.author).toBe("THOME:UPERSON");
    expect(sdk.slack.listArchivedMessages).toHaveBeenCalledWith(connectionId, { conversationId: "CROOM", afterTs: "1770000000.000122", beforeTs: "1770000000.000124", limit: 2 });
  });
  it.each(["userId", "conversationId", "source", "threadTs"])("rejects archive %s mismatch", async (key) => {
    const sdk = client(); sdk.slack.listArchivedMessages.mockImplementation(async () => ({ messages: [{ id: sourceId, connectionId, conversationId: "CROOM", messageTs: "1770000000.000123", threadTs: null, userId: "UPERSON", source: "event", [key]: "wrong" }], nextCursor: null }) as any);
    await expect(prepareSlackSource(sdk as any, identityId, { ...event(), companion: {} })).rejects.toThrow();
  });
  it("does not guess ownership or resubmit an unknown send", async () => {
    const sdk = client(); sdk.slack.sendMessage.mockResolvedValue({ id: "action", status: "unknown" });
    await expect(sendSlackReply(sdk as any, parseSlack(event(), identityId)!, "answer")).rejects.toThrow("unknown");
    expect(sdk.slack.sendMessage).toHaveBeenCalledTimes(1);
    sdk.slack.listConnections.mockResolvedValue({ connections: [{ ...connection, identityId: "other" }] });
    await expect(sendSlackReply(sdk as any, parseSlack(event(), identityId)!, "answer")).rejects.toThrow("identity");
    expect(sdk.slack.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("revalidates the current connection workspace immediately before automatic sends", async () => {
    const sdk = client(); sdk.slack.listConnections.mockResolvedValue({ connections: [{ ...connection, workspaceId: "TOTHER" }] });
    await expect(sendSlackReply(sdk as any, parseSlack(event(), identityId)!, "answer")).rejects.toThrow("workspace changed"); expect(sdk.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("checks send authority only after connection reads and before the irreversible send", async () => {
    const sdk = client(), route = parseSlack(event(), identityId)!;
    let allowed = true;
    sdk.slack.listConnections.mockImplementation(async () => { allowed = false; return { connections: [connection] }; });
    const checkpoint = vi.fn(async () => { if (!allowed) throw new Error("source stopped"); });
    await expect(sendSlackReply(sdk as any, route, "answer", checkpoint)).rejects.toThrow("source stopped");
    expect(checkpoint).toHaveBeenCalledOnce(); expect(sdk.slack.sendMessage).not.toHaveBeenCalled();
    checkpoint.mockClear(); sdk.slack.listConnections.mockRejectedValue(new Error("read unavailable"));
    await expect(sendSlackReply(sdk as any, route, "answer", checkpoint)).rejects.toThrow("read unavailable");
    expect(checkpoint).not.toHaveBeenCalled(); expect(sdk.slack.sendMessage).not.toHaveBeenCalled();
  });
  it("adds only missing subscription events without replacing unrelated delivery", async () => {
    const update = vi.fn(), create = vi.fn();
    const sdk: any = { webhooks: { subscriptions: { list: async () => [{ id: "one", url: "https://receiver.test", status: "active", eventTypes: ["slack.mention_received", "text.received"] }], update, create } } };
    await reconcileSlackSubscription(sdk, identityId, "https://receiver.test");
    expect(update).toHaveBeenCalledWith("one", { scope: "identity", eventTypes: expect.arrayContaining([...SLACK_SUBSCRIPTION_EVENTS, "text.received"]) }); expect(create).not.toHaveBeenCalled();
  });
  it("exercises real SDK snake-case routes, null thread and stable idempotency headers", async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      const result = String(input).includes("/messages") ? { id: "action", connection_id: connectionId, conversation_id: "CROOM", status: "sent", thread_ts: null } : { connections: [{ ...connection, identity_id: identityId, workspace_id: "TINSTALL", bot_user_id: "UBOT", created_at: "2026-01-01" }] };
      return new Response(JSON.stringify(result), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const sdk = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://sdk.test" });
    const route = { ...parseSlack(event(), identityId)!, threadTs: null };
    await sendSlackReply(sdk, route, "answer"); await sendSlackReply(sdk, route, "answer");
    const sends = requests.filter((r) => r.url.includes("/messages"));
    expect(JSON.parse(String(sends[0]!.init!.body))).toEqual({ conversation_id: "CROOM", text: "answer", thread_ts: null });
    expect(new Headers(sends[0]!.init!.headers).get("Idempotency-Key")).toMatch(/^openclaw:/);
    expect(new Headers(sends[0]!.init!.headers).get("Idempotency-Key")).toBe(new Headers(sends[1]!.init!.headers).get("Idempotency-Key"));
  });
});
describe("Slack activity destination policy", () => {
  it.each(["completed", "cancelled"] as const)("aggregates native thread owners after %s, suspends on approval, and never adds thread eyes", async (ending) => {
    const dir = await mkdtemp(join(tmpdir(), "slack-activity-"));
    try {
      const slack = { setProcessingStatus: vi.fn(async () => ({ status: "succeeded" })), addReaction: vi.fn(), removeReaction: vi.fn() };
      const activity = createSlackActivity(async () => slack as any, join(dir, "state.json"));
      const first = parseSlack(event(), identityId)!, second = { ...first, sourceEventId: "second" };
      activity.notify(first, "accepted"); activity.notify(second, "accepted"); await activity.flush();
      activity.notify(first, "waiting"); await activity.flush(); activity.notify({ ...first, sourceEventId: "unrelated" }, "cancelled"); await activity.flush(); activity.notify(first, ending); await activity.flush(); activity.notify(first, "cancelled"); await activity.flush();
      activity.notify(second, "completed"); await activity.flush();
      expect(slack.setProcessingStatus.mock.calls.map((v: any) => v[3])).toEqual(["processing", "suspended", "processing", "active"]);
      expect(slack.addReaction).not.toHaveBeenCalled(); expect(slack.removeReaction).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("uses eyes only for inline, cleans up on shutdown without false failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "slack-inline-"));
    try {
      const slack = { setProcessingStatus: vi.fn(), addReaction: vi.fn(async () => ({ status: "succeeded" })), removeReaction: vi.fn(async () => ({ status: "succeeded" })) };
      const activity = createSlackActivity(async () => slack as any, join(dir, "state.json"));
      activity.notify({ ...parseSlack(event(), identityId)!, threadTs: null }, "accepted"); await activity.flush(); await activity.close();
      expect(slack.addReaction.mock.calls.map((v: any) => v[3])).toEqual(["eyes"]);
      expect(slack.removeReaction.mock.calls.map((v: any) => v[3])).toContain("eyes"); expect(slack.setProcessingStatus).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
describe("guided Slack setup", () => {
  it.each(["whoami", "connections"])("preserves the existing enabled setting when initial %s verification fails", async (phase) => {
    const sdk: any = { whoami: vi.fn(async () => { if (phase === "whoami") throw new Error("unavailable"); return { authType: "api_key", authSubtype: "api_key.admin_scoped" }; }), slack: { listConnections: vi.fn(async () => { throw new Error("unavailable"); }), startSetup: vi.fn() } };
    for (const previous of [false, true]) expect(await configureSlack(sdk, identityId, previous, { prompter: { confirm: async () => true } as any, note: vi.fn(), installation: vi.fn() })).toBe(previous);
    expect(sdk.slack.startSetup).not.toHaveBeenCalled();
  });
  it("performs no provisioning without explicit enablement", async () => {
    const sdk: any = { whoami: vi.fn() };
    expect(await configureSlack(sdk, identityId, false, { prompter: { confirm: async () => false } as any, note: vi.fn(), installation: vi.fn() })).toBe(false);
    expect(sdk.whoami).not.toHaveBeenCalled();
  });
  it("selects identity-bound workspace, waits preparation, hands browser installation off, then observes connection", async () => {
    const workspace = { id: "saved", workspaceId: "TINSTALL", workspaceName: "Synthetic", status: "ready" };
    const snapshot = (status: string, connected = false) => ({ connections: connected ? [connection] : [], provisioningWorkspace: workspace, setup: { status }, applicationCreated: true });
    const slack = { listConnections: vi.fn().mockResolvedValueOnce(snapshot("not_started")).mockResolvedValueOnce(snapshot("pending")).mockResolvedValueOnce(snapshot("ready")).mockResolvedValueOnce(snapshot("ready", true)), startSetup: vi.fn(), startInstallation: vi.fn(async () => ({ authorizationUrl: "https://install.test", expiresAt: new Date(10000) })) };
    const installation = vi.fn(), note = vi.fn(); let clock = 0;
    const sdk: any = { whoami: async () => ({ authType: "api_key", authSubtype: "api_key.agent_scoped.claimed", scope: `agent_identity:${identityId}` }), slack };
    expect(await configureSlack(sdk, identityId, false, { prompter: { confirm: async () => true } as any, note, installation, now: () => clock, delay: async (ms) => { clock += ms; }, waitMs: 10000 })).toBe(true);
    expect(slack.startSetup).toHaveBeenCalledTimes(1); expect(slack.startSetup).toHaveBeenCalledWith(identityId, "saved");
    expect(slack.startInstallation).toHaveBeenCalledWith(identityId, { workspaceId: "TINSTALL" });
    expect(installation).toHaveBeenCalledWith("https://install.test", new Date(10000)); expect(note).toHaveBeenCalledWith("Slack workspace connection confirmed.");
  });
  it("does not blindly retry unknown app creation", async () => {
    const startSetup = vi.fn(), installation = vi.fn();
    const sdk: any = { whoami: async () => ({ authType: "api_key", authSubtype: "api_key.admin_scoped" }), slack: { listConnections: async () => ({ connections: [], setup: { status: "failed", errorCode: "outcome_unknown" } }), startSetup } };
    await configureSlack(sdk, identityId, false, { prompter: { confirm: async () => true } as any, note: vi.fn(), installation });
    expect(startSetup).not.toHaveBeenCalled(); expect(installation).not.toHaveBeenCalled();
  });
});
describe("six opt-in Slack tools", () => {
  it.each(["thome:uperson", "tinstall:uperson"])("keeps canonical and installation author allowlists consistent: %s", async (allowed) => {
    const sdk = client(), factories: any[] = [], route = { ...parseSlack(event(), identityId)!, author: "THOME:UPERSON" };
    const beforeSend = vi.fn(), afterSend = vi.fn();
    const close = bindNativeSource("allowed-slack", { identityId, conversationId: route.conversationId, slackRoute: route, author: route.author, closed: false, validate: vi.fn(), beforeSend, afterSend });
    try {
      registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getIdentity: async () => ({ id: identityId }), getClient: async () => sdk } as any, () => ({ slackEnabled: true, allowedRecipients: [allowed] }));
      const send = factories.map((factory) => factory({ sessionKey: "allowed-slack" })).find((tool) => tool.name === "inkbox_slack_send_message");
      expect((await send.execute("answer", { connectionId, conversationId: "CROOM", text: "answer", idempotencyKey: "answer" })).isError).not.toBe(true);
      expect(sdk.slack.sendMessage).toHaveBeenCalledOnce(); expect(beforeSend).toHaveBeenCalledOnce();
      sdk.slack.listConnections.mockResolvedValue({ connections: [{ ...connection, workspaceId: "TFOREIGN" }] });
      expect((await send.execute("changed", { connectionId, conversationId: "CROOM", text: "answer", idempotencyKey: "changed" })).isError).toBe(true);
      expect(sdk.slack.sendMessage).toHaveBeenCalledOnce();
    } finally { close(); }
  });
  it("keeps exactly six names, validates args before API, and no arbitrary status/reaction tools", async () => {
    const factories: any[] = [], sdk = client();
    registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getClient: async () => sdk, getIdentity: async () => ({ id: identityId }) } as any, () => ({ slackEnabled: true }));
    const tools = factories.map((factory) => factory({}));
    expect(tools.map((tool) => tool.name.replace("inkbox_slack_", ""))).toEqual(["list_connections", "list_conversations", "list_messages", "search", "send_message", "get_action"]);
    const send = tools.find((tool) => tool.name === "inkbox_slack_send_message");
    const result = await send.execute("tool", { connectionId, conversationId: "CROOM", text: "hello", idempotencyKey: "valid", reaction: "eyes" });
    expect(result.isError).toBe(true); expect(sdk.slack.sendMessage).not.toHaveBeenCalled();
  });
});
