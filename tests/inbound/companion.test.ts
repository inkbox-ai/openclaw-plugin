import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return { statePaths: () => ({ dir: state.dir }), ensureStateDir: () => fs.mkdir(state.dir, { recursive: true, mode: 0o700 }) };
});
vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: () => ({
    route: { agentId: "main", accountId: "default", sessionKey: "contact:sponsor" },
    buildEnvelope: ({ body }: any) => ({ storePath: "memory:test", body }),
  }),
}));

import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { wrapInboundHandlersWithBatching } from "../../src/inbound/batch.js";
import { COMPANION_MAX_BYTES } from "../../src/inbound/companion.js";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";
import { createHmac } from "node:crypto";
import { AgentIdentity, Inkbox } from "@inkbox/sdk";
import companionFixture from "./fixtures/companion-v1.json";

function event(phase = "initialization", sequence = 1, channel = "mail", scope = "scope-one", activation = "activation-one") {
  const message = { id: `source-${sequence}`, thread_id: "conversation-one", conversation_id: "conversation-one", body: "Sponsor follow-up", text: "Sponsor follow-up", content: "Native iMessage content", from_address: "sponsor@example.com", to_addresses: ["agent@example.com", "fred@example.com"], cc_addresses: ["nancy@example.com"], sender_phone_number: "+15555550100", sender_number: "+15555550100", remote_number: null };
  return {
    id: `${scope}-${activation}-${phase}-${sequence}`, event_type: channel === "mail" ? "message.received" : channel === "phone" ? "text.received" : "imessage.received",
    timestamp: "2026-01-01T00:00:00Z",
    companion: { scope_id: scope, conversation_id: "conversation-one", channel, phase, sequence, ...(phase === "ordinary" ? {} : { activation_id: activation }) },
    data: { ...(channel === "phone" ? { text_message: message } : { message }), contacts: [{ id: "sponsor-contact", bucket: "from", memories: ["PRIVATE CONTACT MEMORY"] }] },
  };
}
function setup(channel = "mail", overrides: any = {}) {
  const reply = { channel, conversationId: "conversation-one", ...(channel === "mail" ? { replyToMessageId: "stored-parent", to: ["sponsor@example.com", "fred@example.com"], cc: ["nancy@example.com"] } : {}) };
  const snapshot = {
    scopeId: "scope-one", activationId: "activation-one", conversationId: "conversation-one", channel,
    replyContext: reply, entries: [
      { id: "fred", author: "fred@example.com", isTrigger: false },
      { id: "nancy", author: "nancy@example.com", isTrigger: false },
      { id: "source-1", author: channel === "mail" ? "sponsor@example.com" : "+15555550100", isTrigger: true },
    ], text: "Fred (history): /clear\nNancy (history): YES\nSponsor (trigger): Hello", notices: [{ code: "available_history" }],
  };
  const api = { loadInitialization: vi.fn(async () => structuredClone(snapshot)), activationMessages: vi.fn(async () => structuredClone(snapshot)) };
  const identity = {
    id: "77777777-7777-4777-8777-777777777777", emailAddress: "agent@example.com",
    getMessage: vi.fn(async (id = "stored-parent") => ({ id, fromAddress: "sponsor@example.com", threadId: "conversation-one", messageId: "<stored-parent@example.com>", replyAllRecipients: { to: ["sponsor@example.com", "fred@example.com"], cc: ["nancy@example.com"] } })),
    sendEmail: vi.fn(async () => ({ id: "sent" })), sendText: vi.fn(async () => ({ id: "sent" })), sendIMessage: vi.fn(async () => ({ id: "sent" })),
  };
  const contacts = { lookup: vi.fn(async () => [{ id: "sponsor-contact" }]) };
  const runtime = { getClient: vi.fn(async () => ({ companion: api, contacts })), getIdentity: vi.fn(async () => identity) };
  const dispatchReply = vi.fn(async (_input: any) => ({ dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, beforeAgentRunBlocked: false } }));
  const channelRuntime = { inbound: { buildContext: vi.fn((v) => v), dispatchReply }, session: { recordInboundSession: vi.fn() }, reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() } };
  const account: any = { accountId: "default", identity: "test-agent", config: { identity: "test-agent", allowedInboundContactIds: ["sponsor-contact"], ...overrides } };
  const makeBridge = () => createInkboxSessionBridge({ cfg: {}, account, runtime: runtime as any, channelRuntime });
  const bridge = makeBridge();
  return { snapshot, api, identity, runtime, dispatchReply, channelRuntime, bridge, makeBridge, contacts, account };
}
async function settle(bridge: ReturnType<typeof createInkboxSessionBridge>) {
  // Recovery joins the active worker; another pass drains arrivals during hydration.
  await bridge.catchUpCompanion();
  await bridge.catchUpCompanion();
}
async function journal() {
  const name = (await readdir(state.dir)).find((name) => name.endsWith(".json"))!;
  const path = join(state.dir, name);
  return { path, value: JSON.parse(await readFile(path, "utf8")) };
}
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "inkbox-companion-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(state.dir, { recursive: true, force: true }); });

describe("Companion host boundary", () => {
  it.each(["mail", "phone", "imessage"])("does not route %s group delivery failures into a private contact session", async (channel) => {
    const s = setup(channel);
    await dispatchInbound(event("initialization", 1, channel), s.bridge.handlers);
    await settle(s.bridge);
    await s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "Group reply" });
    const failed: any = event("live", 2, channel);
    delete failed.companion;
    failed.event_type = channel === "mail" ? "message.failed" : channel === "phone" ? "text.delivery_failed" : "imessage.delivery_failed";
    const message = failed.data.text_message ?? failed.data.message;
    message.id = "sent";
    message.direction = "outbound";
    message.remote_phone_number = "+15555550100";
    message.remote_number = "+15555550100";
    message.error_detail = "Delivery failed";
    await dispatchInbound(failed, s.bridge.handlers);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
  it.each(["revocation", "identity", "sponsor", "reply scope"])("rechecks %s after durable submission and host input preparation", async (change) => {
    const s = setup();
    s.channelRuntime.inbound.buildContext.mockImplementation((context) => {
      if (change === "revocation") s.api.activationMessages.mockImplementation(async () => {
        expect(Object.values((await journal()).value.activations)).toEqual([expect.objectContaining({ state: "submitting" })]);
        throw new Error("activation revoked during preparation");
      });
      if (change === "identity") s.identity.id = "88888888-8888-4888-8888-888888888888";
      if (change === "sponsor") s.contacts.lookup.mockResolvedValue([{ id: "not-permitted" }]);
      if (change === "reply scope") s.snapshot.replyContext.to = ["other@example.com"];
      return context;
    });
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.channelRuntime.inbound.buildContext).toHaveBeenCalledTimes(1);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    expect(Object.values((await journal()).value.activations)).toEqual([expect.objectContaining({ state: "paused" })]);
  });

  it("requires an initialization event's source to be the snapshot trigger", async () => {
    const s = setup();
    const received = event();
    received.data.message!.id = "not-the-trigger";
    await dispatchInbound(received, s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "paused", reason: "Companion initialization source is not its trigger." })]);
  });

  it.each([false, true])("requires live mail attachment references (present=%s)", async (present) => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    const live = event("live", 2);
    Object.assign(live.data.message!, { has_attachments: true, attachments: present ? [{ source_message_id: "source-2", index: 0, filename: "example.txt" }] : [] });
    await dispatchInbound(live, s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(present ? 2 : 1);
    if (present) expect(s.dispatchReply.mock.calls[1]![0].ctxPayload.message.bodyForAgent).toContain("example.txt");
    else expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "paused", reason: "Companion mail attachment references are incomplete." }));
  });
  it.each(["mail", "phone", "imessage"])("uses the packaged SDK to load all %s fixture pages before exactly one host input", async (channel) => {
    const s = setup(channel);
    const pages = structuredClone(companionFixture.pages);
    for (const page of pages) {
      page.channel = channel;
      page.reply_context.channel = channel;
      if (channel !== "mail") {
        page.reply_context.to = [];
        page.reply_context.cc = [];
        for (const item of page.items) if (item.is_trigger) item.author = "+15555550100";
      }
    }
    const common = pages[0]!;
    const [fred, nancy] = common.items;
    const sponsor = pages[1]!.items[1]!;
    const fetch = vi.fn(async (input: any) => {
      const second = new URL(String(input)).searchParams.get("cursor") === common.next_cursor;
      return new Response(JSON.stringify(pages[second ? 1 : 0]), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new Inkbox({ apiKey: "synthetic-test-key", baseUrl: "https://example.com" });
    s.runtime.getClient.mockResolvedValue({ companion: client.companion, contacts: s.contacts } as any);
    const load = vi.spyOn(client.companion, "loadInitialization");
    const received = event("initialization", 1, channel);
    Object.assign(received.companion, { scope_id: common.scope_id, activation_id: common.activation_id, conversation_id: common.conversation_id });
    Object.assign((received.data.text_message ?? received.data.message)!, { id: sponsor.id, thread_id: common.conversation_id, conversation_id: common.conversation_id });
    await dispatchInbound(received, s.bridge.handlers);
    await settle(s.bridge);
    expect(load).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    const text = s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent;
    for (const source of [fred, nancy, sponsor]) expect(text.split(`"id":"${source.id}"`)).toHaveLength(2);
    expect(text.indexOf('"author":"fred@example.com"')).toBeLessThan(text.indexOf('"author":"nancy@example.com"'));
    expect(text).toContain('"isTrigger":true');
    expect(text).toContain("future_history_notice");
    expect(text).toContain("source_message_id");
    if (channel !== "mail") return;
    const identity = new AgentIdentity({ id: s.identity.id, agentHandle: "test-agent", mailbox: { emailAddress: "agent@example.com" } } as any, client);
    s.runtime.getIdentity.mockResolvedValue(identity as any);
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: sponsor.id, thread_id: common.conversation_id, message_id: "<stored-parent@example.com>", reply_all_recipients: { to: common.reply_context.to, cc: common.reply_context.cc } }), { status: 200 }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ id: "sent" }), { status: 200 }));
    await s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "Group reply" });
    const request = fetch.mock.calls[5] as any;
    const body = JSON.parse(request[1].body);
    expect(String(fetch.mock.calls[4]![0])).toContain(sponsor.id);
    expect(body.recipients).toEqual({ to: common.reply_context.to, cc: common.reply_context.cc });
    expect(body.in_reply_to_message_id).toBe("<stored-parent@example.com>");
  });
  it.each(["mail", "phone", "imessage"])("submits one full %s initializer, queues live, deduplicates restart, and retains replies", async (channel) => {
    const s = setup(channel);
    let release!: () => void;
    s.api.loadInitialization.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return structuredClone(s.snapshot); });
    const handlers = wrapInboundHandlersWithBatching(s.bridge.handlers, { sms: { batchDelayMs: 5000, maxMessages: 1, maxChars: 1 } } as any);
    const init = event("initialization", 1, channel);
    await dispatchInbound(init, handlers, ["sponsor-contact"]);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await dispatchInbound(event("live", 2, channel), handlers, ["sponsor-contact"]);
    expect(s.dispatchReply).toHaveBeenCalledTimes(0);
    expect(Object.keys((await journal()).value.jobs)).toHaveLength(2);
    release();
    await settle(s.bridge);
    expect(s.api.loadInitialization).toHaveBeenCalledTimes(1);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    if (channel === "imessage") expect(s.dispatchReply.mock.calls[1]![0].ctxPayload.message.bodyForAgent).toContain("Native iMessage content");
    const initial = s.dispatchReply.mock.calls[0]![0];
    expect(initial.ctxPayload.message.bodyForAgent).toContain(s.snapshot.text);
    expect(initial.ctxPayload.message.bodyForAgent).not.toContain("PRIVATE CONTACT MEMORY");
    expect(initial.ctxPayload.message.commandBody).toBe("");
    expect(initial.ctxPayload.extra.CommandAuthorized).toBe(false);
    expect(initial.routeSessionKey).not.toContain("contact:sponsor");
    await initial.delivery.deliver({ text: "Group reply" });
    if (channel === "mail") expect(s.identity.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: s.snapshot.replyContext.to, cc: ["nancy@example.com"], inReplyToMessageId: "<stored-parent@example.com>" }));
    else expect(channel === "phone" ? s.identity.sendText : s.identity.sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation-one", text: "Group reply" });
    const restarted = s.makeBridge();
    await dispatchInbound(init, restarted.handlers, ["sponsor-contact"]);
    await settle(restarted);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
  });

  it("isolates ordinary, activated cohorts, and changed activations", async () => {
    const s = setup();
    await dispatchInbound(event("ordinary"), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.api.loadInitialization).not.toHaveBeenCalled();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    s.snapshot.scopeId = "scope-two";
    s.snapshot.activationId = "activation-two";
    await dispatchInbound(event("initialization", 1, "mail", "scope-two", "activation-two"), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(3);
    expect(new Set(s.dispatchReply.mock.calls.map(([v]) => v.routeSessionKey)).size).toBe(3);
  });

  it("preserves the complete ordinary mail group and stored parent", async () => {
    const s = setup();
    await dispatchInbound(event("ordinary"), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.api.loadInitialization).not.toHaveBeenCalled();
    const input = s.dispatchReply.mock.calls[0]![0];
    await input.delivery.deliver({ text: "Ordinary group reply" });
    expect(s.identity.getMessage).toHaveBeenCalledWith("source-1");
    expect(s.identity.sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: ["sponsor@example.com", "fred@example.com"], cc: ["nancy@example.com"], inReplyToMessageId: "<stored-parent@example.com>",
    }));
  });

  it.each(["mail", "phone", "imessage"])("validates the actual %s conversation and sender before acceptance", async (channel) => {
    const s = setup(channel);
    const received = event("initialization", 1, channel);
    const message = (received.data.text_message ?? received.data.message)!;
    message.thread_id = "other";
    message.conversation_id = "other";
    await expect(dispatchInbound(received, s.bridge.handlers)).rejects.toThrow("conversation or sender");
    message.thread_id = "conversation-one";
    message.conversation_id = "conversation-one";
    message.from_address = "";
    message.sender_phone_number = "";
    message.sender_number = "";
    await expect(dispatchInbound(received, s.bridge.handlers)).rejects.toThrow("conversation or sender");
    expect(s.dispatchReply).not.toHaveBeenCalled();
  });

  it("does not mistake an ordinary group roster contact for its sender", async () => {
    const s = setup("imessage");
    const received = event("ordinary", 1, "imessage");
    received.data.message!.sender_number = "+15555550200";
    s.contacts.lookup.mockResolvedValue([{ id: "bystander-contact" }]);
    await dispatchInbound(received, s.bridge.handlers, ["sponsor-contact"]);
    await settle(s.bridge);
    expect(s.contacts.lookup).toHaveBeenCalledWith({ phone: "+15555550200" });
    expect(s.dispatchReply).not.toHaveBeenCalled();
  });

  it("fences queued jobs and session keys to the resolved identity UUID", async () => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    const stored = await journal();
    stored.value.jobs.oldPending = { event: event("live", 2), identityId: s.identity.id, state: "pending" };
    await writeFile(stored.path, JSON.stringify(stored.value));
    s.identity.id = "88888888-8888-4888-8888-888888888888";
    await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect((await journal()).value.jobs.oldPending.state).toBe("paused");
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.dispatchReply.mock.calls[0]![0].routeSessionKey).not.toBe(s.dispatchReply.mock.calls[1]![0].routeSessionKey);
  });

  it("includes the canonical conversation in the session fence", async () => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    const next = event();
    next.id = "another-conversation-event";
    next.companion.conversation_id = "conversation-two";
    next.data.message!.thread_id = "conversation-two";
    s.snapshot.conversationId = "conversation-two";
    s.snapshot.replyContext.conversationId = "conversation-two";
    await dispatchInbound(next, s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.dispatchReply.mock.calls[0]![0].routeSessionKey).not.toBe(s.dispatchReply.mock.calls[1]![0].routeSessionKey);
  });

  it("pauses a truncated live mail body rather than submitting its prefix", async () => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    const live = event("live", 2);
    Object.assign(live.data.message!, { body_truncated: true, body: "only a prefix" });
    await dispatchInbound(live, s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "paused", reason: "Companion message body is incomplete." }));
  });

  it("keeps unknown host acceptance paused across restart", async () => {
    const s = setup();
    s.dispatchReply.mockRejectedValueOnce(new Error("connection lost after acceptance"));
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    await dispatchInbound(event("live", 2), s.bridge.handlers);
    await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.activations)).toEqual([expect.objectContaining({ state: "paused" })]);
  });

  it("preserves a host before-agent-run denial without releasing live work", async () => {
    const s = setup();
    s.dispatchReply.mockResolvedValueOnce({ dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, beforeAgentRunBlocked: true } });
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    await dispatchInbound(event("live", 2), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.activations)).toEqual([expect.objectContaining({ state: "paused" })]);
  });

  it("recovers durable pre-submission work and pauses a crash at the submitting checkpoint", async () => {
    const s = setup();
    await dispatchInbound(event("ordinary"), s.bridge.handlers);
    await settle(s.bridge);
    s.dispatchReply.mockClear();
    const stored = await journal();
    stored.value.jobs = {};
    stored.value.jobs.pending = { event: event(), identityId: s.identity.id, state: "pending" };
    await writeFile(stored.path, JSON.stringify(stored.value));
    await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    const checkpoint = await journal();
    checkpoint.value.jobs.crash = { event: event("live", 2), identityId: s.identity.id, state: "submitting" };
    await writeFile(checkpoint.path, JSON.stringify(checkpoint.value));
    await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect((await journal()).value.jobs.crash.state).toBe("paused");
  });

  it.each(["size", "sponsor", "revoked", "scope", "incomplete"])("rejects %s before any host submission", async (failure) => {
    const s = setup();
    if (failure === "size") s.snapshot.text = "x".repeat(COMPANION_MAX_BYTES + 1);
    if (failure === "sponsor") s.contacts.lookup.mockResolvedValue([{ id: "not-permitted" }]);
    if (failure === "revoked") s.api.loadInitialization.mockRejectedValue(new Error("activation unavailable"));
    if (failure === "scope") s.snapshot.scopeId = "another-scope";
    if (failure === "incomplete") s.snapshot.entries = [];
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(0);
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "paused", reason: expect.any(String) })]);
  });

  it("allows a locally permitted sponsor exception without changing allowlists", async () => {
    const s = setup();
    const received = event("live", 2);
    received.data.contacts = [{ id: "bystander", bucket: "from", memories: [] }];
    await dispatchInbound(received, s.bridge.handlers, ["sponsor-contact"]);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.account.config.allowedInboundContactIds).toEqual(["sponsor-contact"]);
  });

  it.each(["audience", "parent"])("rejects a changed mail %s before sending", async (change) => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    const parent = await s.identity.getMessage();
    if (change === "audience") parent.replyAllRecipients.to = ["other@example.com"];
    else parent.threadId = "another-conversation";
    s.identity.getMessage.mockResolvedValue(parent);
    await expect(s.dispatchReply.mock.calls[0]![0].delivery.deliver({ text: "Reply" })).rejects.toThrow();
    expect(s.identity.sendEmail).not.toHaveBeenCalled();
  });

  it("keeps local outbound sponsor restrictions and fresh activation revocation", async () => {
    const s = setup("mail", { allowedRecipients: ["other@example.com"] });
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    const next = setup("mail");
    next.account.config.identity = "second-agent";
    const bridge = next.makeBridge();
    await dispatchInbound(event(), bridge.handlers);
    await settle(bridge);
    next.api.activationMessages.mockRejectedValue(new Error("activation revoked"));
    await dispatchInbound(event("live", 2), bridge.handlers);
    await settle(bridge);
    expect(next.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("only accepts signed Inkbox Companion events and persists before ACK", async () => {
    const s = setup();
    const body = JSON.stringify(event());
    const headers = { "x-inkbox-request-id": "request-one", "x-inkbox-timestamp": String(Math.floor(Date.now() / 1000)), "x-inkbox-signature": "invalid" };
    const options = { signingKey: "test-key", handlers: s.bridge.handlers };
    expect((await handleInkboxWebhook(body, headers, options)).status).toBe(403);
    expect(s.dispatchReply).toHaveBeenCalledTimes(0);
    headers["x-inkbox-signature"] = "sha256=" + createHmac("sha256", "test-key").update(`${headers["x-inkbox-request-id"]}.${headers["x-inkbox-timestamp"]}.${body}`).digest("hex");
    expect((await handleInkboxWebhook(body, headers, options)).status).toBe(200);
    expect(Object.keys((await journal()).value.jobs)).toHaveLength(1);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
});
