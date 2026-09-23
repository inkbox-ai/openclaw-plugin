import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { AgentIdentity, Inkbox } from "@inkbox/sdk";
import { controlText, mentionsAgent } from "../../src/inbound/reply-policy.js";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return { statePaths: () => ({ dir: state.dir }), ensureStateDir: () => fs.mkdir(state.dir, { recursive: true, mode: 0o700 }) };
});
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { createInkboxSessionBridge } from "../../src/inbound/session.js";

function setup(mode: "auto" | "mention" = "auto") {
  const identity = { id: "agent-one", agentHandle: "test-agent", emailAddress: "agent@example.com",
    sendText: vi.fn(async () => ({ id: "reply" })), sendIMessage: vi.fn(async () => ({ id: "reply" })), replyAllEmail: vi.fn(async () => ({ id: "reply" })), sendIMessageTyping: vi.fn(),
    listTextConversations: vi.fn(async () => []), listIMessageConversations: vi.fn(async () => [{ id: "group-one", isGroup: true, participants: ["+15555550100", "+15555550200"] }]),
  };
  const runtime: any = { getIdentity: vi.fn(async () => identity), getClient: vi.fn(async () => ({ contacts: { lookup: vi.fn(async ({ phone }: any) => [{ id: `contact-${phone}`, name: phone }]) } })) };
  const dispatchReply = vi.fn(async (_params: any) => ({ dispatched: true }));
  const core = { routing: { resolveAgentRoute: vi.fn(resolveAgentRoute) }, inbound: { buildContext: vi.fn((v) => v), dispatchReply },
    session: { recordInboundSession: vi.fn(), resolveStorePath: () => "test", readSessionUpdatedAt: () => undefined },
    reply: { resolveEnvelopeFormatOptions: () => ({}), formatAgentEnvelope: ({ body }: any) => body, dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  };
  const account: any = { accountId: "default", identity: "test-agent", config: { identity: "test-agent", groupReplyMode: mode } };
  const makeBridge = () => createInkboxSessionBridge({ cfg: { session: { dmScope: "per-channel-peer" } }, account, runtime, channelRuntime: core });
  return { identity, core, runtime, dispatchReply, bridge: makeBridge(), makeBridge };
}
function event(channel: "sms" | "imessage", sender = "+15555550100", conversation = "group-one", text = "hello", isGroup = true): any {
  const message = { id: `${sender}-${conversation}-${text}`, text, content: text, remote_number: sender, sender_phone_number: sender, conversation_id: conversation, is_group: isGroup, participants: isGroup ? ["+15555550100", "+15555550200"] : [] };
  return { event_type: channel === "sms" ? "text.received" : "imessage.received", data: channel === "sms" ? { text_message: message } : { message } };
}
async function receive(bridge: any, channel: string, value: any) { await (channel === "sms" ? bridge.handlers.onText : bridge.handlers.onIMessage)(value); }
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "inkbox-groups-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(state.dir, { recursive: true, force: true }); });

describe("group conversation host routing", () => {
  it.each(["sms", "imessage"] as const)("shares %s host context across contacts, isolates other groups and DMs", async (channel) => {
    const s = setup();
    for (const [sender, group, isGroup] of [["+15555550100", "group-one", true], ["+15555550200", "group-one", true], ["+15555550100", "group-two", true], ["+15555550100", "dm", false]] as const) {
      await receive(s.bridge, channel, event(channel, sender, group, "hello", isGroup));
    }
    const keys = s.dispatchReply.mock.calls.map(([input]) => input.routeSessionKey);
    expect(keys[0]).toBe(keys[1]); expect(new Set(keys)).toHaveLength(3);
    expect(s.core.routing.resolveAgentRoute.mock.calls[0]![0].peer).toEqual({ kind: "group", id: `${channel}:group-one` });
  });
  it.each(["sms", "imessage"] as const)("buffers unmentioned %s messages across restart without typing or host work", async (channel) => {
    const s = setup("mention");
    await receive(s.bridge, channel, event(channel, "+15555550100", "group-one", "background fact"));
    expect(s.dispatchReply).not.toHaveBeenCalled(); expect(s.identity.sendIMessageTyping).not.toHaveBeenCalled();
    const restarted = s.makeBridge();
    await receive(restarted, channel, event(channel, "+15555550200", "group-one", "@agent recall it"));
    const input = s.dispatchReply.mock.calls[0]![0];
    expect(input.ctxPayload.message.bodyForAgent).toContain("background fact");
    expect(input.ctxPayload.message.commandBody).toBe("@agent recall it");
    expect(input.ctxPayload.sender.id).toBe("+15555550200");
  });
  it("routes reactions to the group's host session and does not wake mention mode", async () => {
    const s = setup("mention");
    await s.bridge.handlers.onIMessage!({ event_type: "imessage.reaction_received", data: { reaction: { id: "reaction", remote_number: "+15555550200", conversation_id: "group-one", reaction: "question", target_message_id: "old" } } } as any);
    expect(s.dispatchReply).not.toHaveBeenCalled(); expect(s.identity.sendIMessageTyping).not.toHaveBeenCalled();
    await receive(s.bridge, "imessage", event("imessage", "+15555550100", "group-one", "@agent hi"));
    expect(s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent).toContain("imessage_reaction");
  });
  it("passes raw /stop through framing and keeps an earlier reply's original route", async () => {
    const s = setup("mention");
    await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", "@agent first"));
    const original = s.dispatchReply.mock.calls[0]![0];
    await receive(s.bridge, "sms", event("sms", "+15555550200", "group-two", "/stop"));
    expect(s.dispatchReply.mock.calls[1]![0].ctxPayload.message.commandBody).toBe("/stop");
    await original.delivery.deliver({ text: "reply" });
    expect(s.identity.sendText).toHaveBeenCalledWith({ conversationId: "group-one", text: "reply" });
  });
  it("only accepts native approval answers from the prompted sender, without requiring a mention", async () => {
    const s = setup("mention");
    await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", "@agent work"));
    await s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "Approval required: /approve abc allow-once" });
    await receive(s.bridge, "sms", event("sms", "+15555550200", "group-one", "/approve abc allow-once"));
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", "/approve abc allow-once"));
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.dispatchReply.mock.calls[1]![0].ctxPayload.message.commandBody).toBe("/approve abc allow-once");
  });
  it("does not authorize an approval answer when sending its prompt failed", async () => {
    const s = setup("mention");
    await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", "@agent work"));
    s.runtime.getIdentity.mockRejectedValueOnce(new Error("identity unavailable before sending"));
    await expect(s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "Approval required: /approve abc allow-once" })).rejects.toThrow("identity unavailable");
    await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", "/approve abc allow-once"));
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
  it("strips a case-insensitive configured handle before native command parsing", () => {
    expect(controlText("@TEST-AGENT /approve abc allow-once", "Test-Agent")).toBe("/approve abc allow-once");
  });
  it("fails closed for a known group without a conversation ID", async () => {
    const s = setup();
    await receive(s.bridge, "sms", event("sms", "+15555550100", "", "hello"));
    expect(s.dispatchReply).not.toHaveBeenCalled();
  });
  it("does not wake from an older mention in a batched message", async () => {
    const s = setup("mention");
    const first = event("sms", "+15555550100", "group-one", "@agent earlier");
    const last = event("sms", "+15555550100", "group-one", "never mind");
    const batch = { ...first, data: { text_message: { ...first.data.text_message, text: "@agent earlier\nnever mind" } }, __batch: { fragments: [first, last] } };
    await receive(s.bridge, "sms", batch); expect(s.dispatchReply).not.toHaveBeenCalled();
  });
  it("retains compact recent quiet context with an explicit notice instead of rejecting busy groups", async () => {
    const s = setup("mention");
    for (const label of ["oldest", "middle", "newest"]) {
      await receive(s.bridge, "sms", event("sms", "+15555550100", "group-one", `${label}: ${"x".repeat(45_000)}`));
    }
    expect(s.dispatchReply).not.toHaveBeenCalled();
    await receive(s.makeBridge(), "sms", event("sms", "+15555550100", "group-one", "@agent recall context"));
    const body = s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent;
    expect(body).toContain("older background message(s) were omitted");
    expect(body).toContain("newest:"); expect(body).not.toContain("oldest:");
    expect(body.match(/Group SMS response policy/g)).toHaveLength(1);
  });
  it.each(["@agent", "@AGENT!", "Hi @test-agent.", "(@agent)"])("recognizes a complete mention: %s", (text) => { expect(mentionsAgent(text, "test-agent")).toBe(true); });
  it.each(["@agent-other", "user@agent.example", "https://example.com/@agent", "www.example.com/@agent", "name+@agent", "hello agent"])("does not infer mentions from addresses or URLs: %s", (text) => { expect(mentionsAgent(text, "test-agent")).toBe(false); });
  it("uses the real SDK reply-all endpoint on the stored UUID, without reconstructing recipients", async () => {
    const s = setup(); const stored = "11111111-1111-4111-8111-111111111111";
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: "sent" }), { status: 200 })); vi.stubGlobal("fetch", fetch);
    const client = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://example.com" });
    const identity = new AgentIdentity({ id: "agent-one", agentHandle: "test-agent", mailbox: { emailAddress: "agent@example.com" } } as any, client);
    s.runtime.getIdentity.mockResolvedValue(identity);
    await s.bridge.handlers.onMail!({ event_type: "message.received", data: { message: { id: stored, message_id: "<rfc@example.com>", thread_id: "thread-one", from_address: "sender@example.com", to_addresses: ["agent@example.com", "other@example.com"], cc_addresses: ["cc@example.com"], body: "hello" } } } as any);
    await s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "answer" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]![0])).toContain(`/mailboxes/agent@example.com/messages/${stored}/reply-all`);
    expect(JSON.parse((fetch.mock.calls[0] as any)[1].body)).toEqual({ body_text: "answer" });
  });
  it("refuses an automatic email reply without the stored UUID", async () => {
    const s = setup();
    await s.bridge.handlers.onMail!({ event_type: "message.received", data: { message: { message_id: "<rfc@example.com>", from_address: "sender@example.com", body: "hello" } } } as any);
    await expect(s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "answer" })).rejects.toThrow("stored message ID");
    expect(s.identity.replyAllEmail).not.toHaveBeenCalled();
  });

  it("keeps explicit null Companion metadata on the ordinary path", async () => {
    const s = setup();
    await dispatchInbound({ ...event("sms"), companion: null }, s.bridge.handlers);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(s.dispatchReply.mock.calls[0]![0].routeSessionKey).not.toContain("companion");
  });

});
