import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ dir: "" }));
const nativeGateway = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock("openclaw/plugin-sdk/approval-handler-runtime", async (original) => ({ ...await original<any>(), resolveApprovalOverGateway: nativeGateway.resolve }));
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
import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import { inkboxApprovalCapability } from "../../src/inbound/native-approvals.js";

function event(phase = "initialization", sequence = 1, channel = "mail", scope = "scope-one", activation = "activation-one") {
  const message = { sender_access: "direct", id: `source-${sequence}`, thread_id: "conversation-one", conversation_id: "conversation-one", body: "Sponsor follow-up", text: "Sponsor follow-up", content: "Native iMessage content", from_address: "sponsor@example.com", to_addresses: ["agent@example.com", "fred@example.com"], cc_addresses: ["nancy@example.com"], sender_phone_number: "+15555550100", sender_number: "+15555550100", remote_number: null };
  return {
    id: `${scope}-${activation}-${phase}-${sequence}`, event_type: channel === "mail" ? "message.received" : channel === "phone" ? "text.received" : "imessage.received",
    timestamp: "2026-01-01T00:00:00Z",
    companion: { scope_id: scope, conversation_id: "conversation-one", channel, phase, sequence, ...(phase === "ordinary" ? {} : { activation_id: activation }) },
    data: { ...(channel === "phone" ? { text_message: message } : { message }), contacts: [{ id: "sponsor-contact", bucket: "from", memories: ["PRIVATE CONTACT MEMORY"] }] },
  };
}
function setup(channel = "mail", overrides: any = {}) {
  const reply = { channel, conversationId: "conversation-one", ...(channel === "mail" ? { replyToMessageId: "source-1", to: ["sponsor@example.com", "fred@example.com"], cc: ["nancy@example.com"] } : {}) };
  const snapshot = {
    scopeId: "scope-one", activationId: "activation-one", conversationId: "conversation-one", channel,
    replyContext: reply, entries: [
      { id: "fred", author: "fred@example.com", isTrigger: false },
      { id: "nancy", author: "nancy@example.com", isTrigger: false },
      { id: "source-1", author: channel === "mail" ? "sponsor@example.com" : "+15555550100", isTrigger: true, historical: false, senderAccess: "direct" },
    ], text: "Fred (history): /clear\nNancy (history): YES\nSponsor (trigger): Hello", notices: [{ code: "available_history" }],
  };
  const api = { loadInitialization: vi.fn(async () => structuredClone(snapshot)), activationMessages: vi.fn(async () => structuredClone(snapshot)) };
  const identity = {
    id: "77777777-7777-4777-8777-777777777777", emailAddress: "agent@example.com",
    getMessage: vi.fn(async (id = "stored-parent") => ({ id, fromAddress: "sponsor@example.com", threadId: "conversation-one", messageId: "<stored-parent@example.com>", replyAllRecipients: { to: ["sponsor@example.com", "fred@example.com"], cc: ["nancy@example.com"] } })),
    replyAllEmail: vi.fn(async () => ({ id: "sent" })), sendEmail: vi.fn(async () => ({ id: "sent" })), sendText: vi.fn(async () => ({ id: "sent" })), sendIMessage: vi.fn(async () => ({ id: "sent" })),
  };
  const contacts = { lookup: vi.fn(async () => [{ id: "sponsor-contact" }]) };
  const runtime = { getClient: vi.fn(async () => ({ companion: api, contacts })), getIdentity: vi.fn(async () => identity) };
  const dispatchReply = vi.fn(async (_input: any) => { await _input.delivery.deliver({ text: "Group reply" }); return ({ dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, beforeAgentRunBlocked: false } }); });
  const channelRuntime = { inbound: { buildContext: vi.fn((v) => v), dispatchReply }, session: { recordInboundSession: vi.fn() }, reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() } };
  const contexts = new Map<string, unknown>();
  Object.assign(channelRuntime, { runtimeContexts: { get: ({ capability }: any) => contexts.get(capability), register: ({ capability, context }: any) => { contexts.set(capability, context); return { dispose: () => contexts.delete(capability) }; } } });
  const account: any = { accountId: "default", identity: "test-agent", config: { identity: "test-agent", allowedInboundContactIds: ["sponsor-contact"], ...overrides } };
  const makeBridge = () => createInkboxSessionBridge({ cfg: {}, account, runtime: runtime as any, channelRuntime });
  const bridge = makeBridge();
  return { snapshot, api, identity, runtime, dispatchReply, channelRuntime, bridge, makeBridge, contacts, account, contexts };
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
beforeEach(async () => { nativeGateway.resolve.mockReset(); state.dir = await mkdtemp(join(tmpdir(), "inkbox-companion-")); });
afterEach(async () => { vi.unstubAllGlobals(); await rm(state.dir, { recursive: true, force: true }); });

describe("Companion host boundary", () => {
  it.each([[false, "exec"], [true, "exec"], [false, "plugin"]] as const)("resolves a native approval while its original host turn is waiting (answer races prompt=%s, kind=%s)", async (race, kind) => {
    const s = setup("phone", { groupReplyMode: "mention", companionResponseMode: "relaxed" });
    const quiet = event("initialization", 1, "phone"); quiet.data.text_message!.text = "quiet sponsor";
    await dispatchInbound(quiet, s.bridge.handlers); await settle(s.bridge);
    const handler = await createChannelApprovalHandlerFromCapability({ capability: inkboxApprovalCapability, cfg: {}, channel: "inkbox", channelLabel: "Inkbox", accountId: "default", label: "native-contract", clientDisplayName: "Synthetic native approval", context: s.contexts.get("approval.native") });
    expect(handler).not.toBeNull();
    let releaseModel!: () => void; const decision = new Promise<void>((resolve) => { releaseModel = resolve; });
    let releaseSend!: () => void; const sending = new Promise<void>((resolve) => { releaseSend = resolve; });
    let promptStarted = false;
    if (race) s.identity.sendText.mockImplementationOnce(async () => { promptStarted = true; await sending; return { id: "prompt" }; });
    nativeGateway.resolve.mockImplementation(async ({ approvalId, decision }) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      // Exercise the real native runtime's resolved-during-delivery queue as well.
      await handler!.handleResolved({ id: approvalId, decision, resolvedAtMs: Date.now() } as any);
      releaseModel();
    });
    const approvalId = `${kind === "plugin" ? "plugin:" : ""}11111111-1111-4111-8111-111111111111`;
    s.dispatchReply.mockImplementationOnce(async (input) => {
      await handler!.handleRequested({ id: approvalId, approvalKind: kind, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, request: { ...(kind === "exec" ? { command: "echo synthetic" } : { pluginId: "synthetic", title: "Approval required", description: "Synthetic operation", severity: "warning", allowedDecisions: ["allow-once", "deny"] }), sessionKey: input.routeSessionKey, turnSourceChannel: "inkbox", turnSourceAccountId: "default", turnSourceTo: input.ctxPayload.reply.to } } as any);
      await decision;
      await input.delivery.deliver({ text: "Approved task complete" });
      return { dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 }, beforeAgentRunBlocked: false } };
    });
    try {
      const waking = event("live", 2, "phone"); Object.assign(waking.data.text_message!, { sender_phone_number: "+15555550200", sender_access: "sponsored", text: "@agent run it" });
      await dispatchInbound(waking, s.bridge.handlers);
      await vi.waitFor(() => expect(s.identity.sendText).toHaveBeenCalledTimes(1));
      const sponsor = event("live", 3, "phone"); sponsor.data.text_message!.text = `@agent /approve ${approvalId} allow-once`;
      await dispatchInbound(sponsor, s.bridge.handlers);
      expect(nativeGateway.resolve).not.toHaveBeenCalled();
      // Neither a replayed initializer nor a previously seeded history source is a fresh answer.
      const lateInit = event("initialization", 1, "phone"); lateInit.id = "late-initializer";
      Object.assign(lateInit.data.text_message!, { text: `@agent /approve ${approvalId} allow-once` });
      await dispatchInbound(lateInit, s.bridge.handlers);
      const historical = event("live", 5, "phone");
      Object.assign(historical.data.text_message!, { id: "fred", sender_phone_number: "+15555550200", text: `@agent /approve ${approvalId} allow-once` });
      await dispatchInbound(historical, s.bridge.handlers);
      const bare = event("live", 6, "phone");
      Object.assign(bare.data.text_message!, { sender_phone_number: "+15555550200", text: `/approve ${approvalId} allow-once` });
      await dispatchInbound(bare, s.bridge.handlers);
      s.account.config.companionResponseMode = "safe";
      const sponsored = event("live", 7, "phone");
      Object.assign(sponsored.data.text_message!, { sender_phone_number: "+15555550200", sender_access: "sponsored", text: `@agent /approve ${approvalId} allow-once` });
      await dispatchInbound(sponsored, s.bridge.handlers);
      expect(nativeGateway.resolve).not.toHaveBeenCalled();
      s.account.config.companionResponseMode = "relaxed";
      const answer = event("live", 8, "phone"); Object.assign(answer.data.text_message!, { sender_phone_number: "+15555550200", sender_access: "sponsored", text: `@agent /approve ${approvalId} allow-once` });
      const duplicate = structuredClone(answer); duplicate.id = "duplicate-approval-answer";
      duplicate.data.text_message!.id = "duplicate-approval-source";
      await Promise.all([dispatchInbound(answer, s.bridge.handlers), dispatchInbound(duplicate, s.bridge.handlers)]);
      if (race) { expect(promptStarted).toBe(true); expect(nativeGateway.resolve).not.toHaveBeenCalled(); releaseSend(); }
      await vi.waitFor(() => expect(nativeGateway.resolve).toHaveBeenCalledTimes(1));
      await settle(s.bridge);
      expect(s.dispatchReply).toHaveBeenCalledTimes(1);
      expect(Object.values((await journal()).value.jobs).some((job: any) => job.state === "paused")).toBe(false);
      expect(s.identity.sendText).toHaveBeenCalledTimes(2);
      expect(s.identity.sendText).toHaveBeenLastCalledWith({ conversationId: "conversation-one", text: "Approved task complete" });
      expect(nativeGateway.resolve).toHaveBeenCalledWith(expect.objectContaining({ approvalId, decision: "allow-once" }));
      expect(nativeGateway.resolve.mock.calls[0]![0].resolveMethod).toBe(kind);
    } finally { releaseSend(); releaseModel(); await handler!.stop(); }
  });
  it.each([["/clear", "/new"], ["/cancel", "/stop"], ["/health", "/status"]])("maps gated Companion %s to the native %s command", async (incoming, native) => {
    const s = setup("phone", { groupReplyMode: "mention" });
    const quiet = event("initialization", 1, "phone"); quiet.data.text_message!.text = "quiet sponsor";
    await dispatchInbound(quiet, s.bridge.handlers); await settle(s.bridge);
    const command = event("live", 2, "phone"); command.data.text_message!.text = `@agent ${incoming}`;
    await dispatchInbound(command, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(s.dispatchReply.mock.calls[0]![0].ctxPayload.message.commandBody).toBe(native);
    expect(s.dispatchReply.mock.calls[0]![0].ctxPayload.extra.CommandAuthorized).toBe(true);
  });
  it("explains the unavailable historical-session picker without starting a model", async () => {
    const s = setup("phone", { groupReplyMode: "mention" });
    const quiet = event("initialization", 1, "phone"); quiet.data.text_message!.text = "quiet sponsor";
    await dispatchInbound(quiet, s.bridge.handlers); await settle(s.bridge);
    const command = event("live", 2, "phone"); command.data.text_message!.text = "@agent /resume";
    await dispatchInbound(command, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    expect(s.identity.sendText).toHaveBeenCalledWith({ conversationId: "conversation-one", text: expect.stringContaining("not supported by this OpenClaw channel") });
  });

  it("dispatches only an eligible sponsor stop while the original host turn is blocked", async () => {
    const s = setup("phone", { groupReplyMode: "mention" });
    const quiet = event("initialization", 1, "phone"); quiet.data.text_message!.text = "quiet sponsor";
    await dispatchInbound(quiet, s.bridge.handlers); await settle(s.bridge);
    let release!: () => void; const running = new Promise<void>((resolve) => { release = resolve; });
    let generating = 0;
    s.dispatchReply.mockImplementation(async (input) => {
      if (input.ctxPayload.message.commandBody === "/stop") {
        expect(input.ctxPayload.extra.CommandAuthorized).toBe(true);
        await input.delivery.deliver({ text: "Stopped" }); release();
      } else { generating++; await running; }
      return { dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, beforeAgentRunBlocked: false } };
    });
    try {
      const waking = event("live", 2, "phone"); waking.data.text_message!.text = "@agent long task";
      await dispatchInbound(waking, s.bridge.handlers);
      await vi.waitFor(() => expect(generating).toBe(1));
      for (const [index, changes] of [
        { sender_phone_number: "+15555550200", text: "@agent /stop" },
        { text: "/stop" },
        { text: "@agent /stop extra" },
        { text: "@agent /stop", sender_access: "sponsored" },
      ].entries()) {
        const denied = event("live", index + 3, "phone"); Object.assign(denied.data.text_message!, changes);
        await dispatchInbound(denied, s.bridge.handlers);
      }
      expect(s.dispatchReply).toHaveBeenCalledTimes(1);
      const stop = event("live", 7, "phone"); stop.data.text_message!.text = "@agent /stop";
      await dispatchInbound(stop, s.bridge.handlers);
      expect(s.dispatchReply).toHaveBeenCalledTimes(2);
      expect(generating).toBe(1);
      expect(s.identity.sendText).toHaveBeenCalledWith({ conversationId: "conversation-one", text: "Stopped" });
    } finally { release(); await settle(s.bridge); }
  });

  it.each(["mail", "phone", "imessage"])("does not route %s group delivery failures into a private contact session", async (channel) => {
    const s = setup(channel);
    await dispatchInbound(event("initialization", 1, channel), s.bridge.handlers);
    await settle(s.bridge);
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
  it("uses the saved reply anchor without rereading activation authorization", async () => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    s.api.activationMessages.mockRejectedValue(new Error("unavailable"));
    await dispatchInbound(event("live", 2), s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.api.activationMessages).not.toHaveBeenCalled();
    expect(s.identity.replyAllEmail).toHaveBeenLastCalledWith("source-1", { bodyText: "Group reply" });
  });

  it("persists sponsor contact evidence and rechecks current local restrictions without live lookups", async () => {
    const s = setup();
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    expect(s.contacts.lookup).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.activations)).toEqual([expect.objectContaining({ sponsorContactId: "sponsor-contact" })]);
    s.contacts.lookup.mockRejectedValue(new Error("contact service unavailable"));
    const restarted = s.makeBridge();
    await dispatchInbound(event("live", 2), restarted.handlers); await settle(restarted);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.contacts.lookup).toHaveBeenCalledTimes(1);
    s.account.config.allowedInboundContactIds = ["different-contact"];
    await dispatchInbound(event("live", 3), restarted.handlers); await settle(restarted);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.identity.replyAllEmail).toHaveBeenCalledTimes(2);
    expect(s.contacts.lookup).toHaveBeenCalledTimes(1);
  });
  it("checks changed local sponsor membership again before sending the saved reply", async () => {
    const s = setup();
    s.dispatchReply.mockImplementationOnce(async (input) => {
      await input.delivery.deliver({ text: "Completed answer" });
      s.account.config.allowedInboundContactIds = ["different-contact"];
      return { dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 }, beforeAgentRunBlocked: false } };
    });
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(s.identity.replyAllEmail).not.toHaveBeenCalled();
    expect(s.contacts.lookup).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "paused", replies: ["Completed answer"] }));
  });

  it("requires an initialization event's source to be the snapshot trigger", async () => {
    const s = setup();
    const received = event();
    received.data.message!.id = "not-the-trigger";
    await dispatchInbound(received, s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "pending", reason: "Companion initialization source is not its trigger." })]);
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
    else expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "pending", reason: "Companion mail attachment references are incomplete." }));
  });
  it.each(["ordinary", "live"])("hydrates a truncated %s email before applying current addressing and dispatch", async (phase) => {
    const s = setup("mail", { groupReplyMode: "mention" });
    if (phase === "live") { await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge); s.dispatchReply.mockClear(); }
    s.identity.getMessage.mockResolvedValue({ id: "source-2", threadId: "conversation-one", bodyText: "Full message: @agent this is the omitted question" } as any);
    const received = event(phase, 2);
    Object.assign(received.data.message!, { body_state: "truncated", body: "Preview only", to_addresses: ["other@example.com"], cc_addresses: ["agent@example.com"] });
    await dispatchInbound(received, s.bridge.handlers); await settle(s.bridge);
    expect(s.identity.getMessage).toHaveBeenCalledWith("source-2");
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent).toContain("the omitted question");
    expect(s.dispatchReply.mock.calls[0]![0].ctxPayload.conversation.id).toBe("email:conversation-one");
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
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    const text = s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent;
    for (const source of [fred, nancy, sponsor]) expect(text).toContain(`"id":"${source.id}"`);
    expect(text.indexOf('"author":"fred@example.com"')).toBeLessThan(text.indexOf('"author":"nancy@example.com"'));
    expect(text).toContain('"isTrigger":true');
    expect(text).toContain("future_history_notice");
    expect(text).toContain("source_message_id");

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
    if (channel === "mail") expect(s.identity.replyAllEmail).toHaveBeenCalledWith("source-1", { bodyText: "Group reply" });
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
    expect(s.identity.replyAllEmail).toHaveBeenCalledWith("source-1", { bodyText: "Group reply" });
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
    expect((await journal()).value.jobs.oldPending.state).toBe("pending");
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
    expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "pending", reason: "Companion message body is incomplete." }));
  });

  it("keeps unknown host acceptance paused across restart", async () => {
    const s = setup();
    s.dispatchReply.mockRejectedValueOnce(new Error("connection lost after acceptance"));
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    await dispatchInbound(event("live", 2), s.bridge.handlers);
    await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "paused" }));
  });

  it("preserves a host before-agent-run denial without releasing live work", async () => {
    const s = setup();
    s.dispatchReply.mockResolvedValueOnce({ dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 }, beforeAgentRunBlocked: true } });
    await dispatchInbound(event(), s.bridge.handlers);
    await settle(s.bridge);
    await dispatchInbound(event("live", 2), s.bridge.handlers);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.jobs)).toContainEqual(expect.objectContaining({ state: "paused" }));
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
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "pending", reason: expect.any(String) })]);
  });

  it("allows a locally permitted sponsor exception without changing allowlists", async () => {
    const s = setup();
    const received = event("live", 2);
    received.data.contacts = [{ id: "bystander", bucket: "from", memories: [] }];
    await dispatchInbound(received, s.bridge.handlers, ["sponsor-contact"]);
    await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    expect(s.account.config.allowedInboundContactIds).toEqual(["sponsor-contact"]);
  });

  it("does not send before the complete host response is checkpointed", async () => {
    const s = setup();
    let release!: () => void;
    s.dispatchReply.mockImplementationOnce(async (input) => {
      await input.delivery.deliver({ text: "Completed answer" });
      expect(s.identity.replyAllEmail).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => { release = resolve; });
      return { dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 }, beforeAgentRunBlocked: false } };
    });
    await dispatchInbound(event(), s.bridge.handlers);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    release(); await settle(s.bridge);
    expect(s.identity.replyAllEmail).toHaveBeenCalledWith("source-1", { bodyText: "Completed answer" });
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "done", replies: [] })]);
  });

  it("keeps local outbound sponsor restrictions without an activation preflight", async () => {
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
    expect(next.dispatchReply).toHaveBeenCalledTimes(2);
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
  it.each(["mail", "phone", "imessage"])("applies Safe/Relaxed and current-message mention gates for %s", async (channel) => {
    for (const responseMode of ["safe", "relaxed"] as const) for (const access of ["direct", "sponsored", undefined]) {
      const s = setup(channel, { identity: `agent-${responseMode}-${access}`, companionResponseMode: responseMode, groupReplyMode: "mention" });
      const received = event("initialization", 1, channel);
      const msg: any = received.data.text_message ?? received.data.message;
      msg.sender_access = access; msg.text = msg.content = msg.body = "@agent hello";
      await dispatchInbound(received, s.bridge.handlers); await settle(s.bridge);
      const wakes = responseMode === "relaxed" || access === "direct";
      expect(s.dispatchReply).toHaveBeenCalledTimes(wakes ? 1 : 0);
    }
  });
  it.each([
    [["Agent Name <AGENT@EXAMPLE.COM>"], "plain body", true],
    [["other@example.com"], "To: agent@example.com", false],
    [["other@example.com"], "plain body", false],
    [["other@example.com"], "hello @test-agent", true],
  ])("only current To recipients or textual mentions address Companion email (%j)", async (to, body, wakes) => {
    const s = setup("mail", { groupReplyMode: "mention" });
    const received = event(); Object.assign(received.data.message!, { to_addresses: to, cc_addresses: ["agent@example.com"], body });
    await dispatchInbound(received, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(wakes ? 1 : 0);
  });
  it("persists quiet initialization and live context across restart and uses the next direct source only", async () => {
    const s = setup("phone", { groupReplyMode: "mention" });
    const quiet = event("live", 2, "phone");
    Object.assign(quiet.data.text_message!, { sender_access: "sponsored", text: "@agent quiet sponsored fact" });
    await dispatchInbound(quiet, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    const next = event("live", 3, "phone"); next.data.text_message!.text = "@agent recall that fact";
    const restarted = s.makeBridge();
    await dispatchInbound(next, restarted.handlers); await settle(restarted);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    const body = s.dispatchReply.mock.calls[0]![0].ctxPayload.message.bodyForAgent;
    expect(body).toContain(s.snapshot.text); expect(body).toContain("quiet sponsored fact"); expect(body).toContain("recall that fact");
    expect(s.api.loadInitialization).toHaveBeenCalledTimes(1);
  });
  it.each(["initialization", "live"])("compares mixed-case mail authors consistently during %s", async (phase) => {
    const s = setup();
    const received = event(phase);
    received.data.message!.from_address = "Sponsor@Example.COM";
    await dispatchInbound(received, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
  it("rejects a different snapshot author even on a live-first source", async () => {
    const s = setup(); const received = event("live"); received.data.message!.from_address = "other@example.com";
    await dispatchInbound(received, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
  });
  it("retries native host preparation without losing the chosen session or marking a submission uncertain", async () => {
    const s = setup();
    s.channelRuntime.inbound.buildContext.mockImplementationOnce(() => { throw new Error("host startup unavailable"); });
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    const stored = await journal();
    const job: any = Object.values(stored.value.jobs)[0]; expect(job.state).toBe("pending"); job.retryAt = 0;
    await writeFile(stored.path, JSON.stringify(stored.value));
    await settle(s.makeBridge()); expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
  it("retries a pre-send identity failure using the saved reply without rerunning the model", async () => {
    const s = setup(); let failed = false;
    s.runtime.getIdentity.mockImplementation(async () => {
      const record = await journal().catch(() => null);
      if (!failed && record && Object.values(record.value.jobs).some((job: any) => job.state === "reply_pending")) { failed = true; throw Object.assign(new Error("identity unavailable before send"), { name: "InkboxConnectionError" }); }
      return s.identity;
    });
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1); expect(s.identity.replyAllEmail).not.toHaveBeenCalled();
    const saved = await journal(); const job: any = Object.values(saved.value.jobs)[0];
    expect(job.state).toBe("reply_pending"); expect(job.replies).toEqual(["Group reply"]); job.retryAt = 0;
    await writeFile(saved.path, JSON.stringify(saved.value)); await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1); expect(s.identity.replyAllEmail).toHaveBeenCalledTimes(1);
  });
  it("pauses an uncertain send without resubmitting the model or retrying the external send", async () => {
    const s = setup(); s.identity.replyAllEmail.mockRejectedValue(new Error("connection lost after send"));
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge); await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1); expect(s.identity.replyAllEmail).toHaveBeenCalledTimes(1);
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: "paused", replies: ["Group reply"] })]);
  });
  it("does not let a denied ordinary message prevent an eligible sponsor", async () => {
    const s = setup(); s.contacts.lookup.mockResolvedValueOnce([{ id: "not-permitted" }]);
    await dispatchInbound(event("ordinary"), s.bridge.handlers); await settle(s.bridge);
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });
  it.each(["initialization", "ordinary"])("requires the current mention and prompted author for %s Companion native approvals", async (phase) => {
    const s = setup("phone", { groupReplyMode: "mention" });
    const init = event(phase, 1, "phone"); init.data.text_message!.text = "@agent work";
    s.dispatchReply.mockImplementationOnce(async (input) => {
      await input.delivery.deliver({ text: "Approval needed: /approve abc allow-once" });
      return { dispatched: true, admission: { kind: "dispatch" }, dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 }, beforeAgentRunBlocked: false } };
    });
    await dispatchInbound(init, s.bridge.handlers); await settle(s.bridge);
    expect(s.identity.sendText).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining("Include @agent") }));
    for (const [sequence, sender, text, access] of [[2, "+15555550100", "/approve abc allow-once", "direct"], [3, "+15555550200", "@agent /approve abc allow-once", "direct"], [4, "+15555550100", "@agent /approve abc allow-once", "sponsored"]] as const) {
      const next = event(phase === "ordinary" ? "ordinary" : "live", sequence, "phone"); Object.assign(next.data.text_message!, { sender_phone_number: sender, text, sender_access: access });
      await dispatchInbound(next, s.bridge.handlers); await settle(s.bridge);
    }
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
    const answer = event(phase === "ordinary" ? "ordinary" : "live", 5, "phone"); answer.data.text_message!.text = "@agent /approve abc allow-once";
    await dispatchInbound(answer, s.bridge.handlers); await settle(s.bridge);
    expect(s.dispatchReply).toHaveBeenCalledTimes(2);
    expect(s.dispatchReply.mock.calls[1]![0].ctxPayload.message.commandBody).toBe("/approve abc allow-once");
  });

  it("retries a temporary ordinary sender lookup failure rather than treating it as denial", async () => {
    const s = setup(); s.contacts.lookup.mockRejectedValueOnce(new Error("lookup timed out"));
    await dispatchInbound(event("ordinary"), s.bridge.handlers); await settle(s.bridge);
    const stored = await journal(); const job: any = Object.values(stored.value.jobs)[0];
    expect(job.state).toBe("pending"); expect(s.dispatchReply).not.toHaveBeenCalled(); job.retryAt = 0;
    await writeFile(stored.path, JSON.stringify(stored.value)); await settle(s.makeBridge());
    expect(s.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("bounds permanent preparation failures without capping transient reads (transient=%s)", async (transient) => {
    const s = setup();
    s.api.loadInitialization.mockRejectedValue(Object.assign(new Error("snapshot unavailable"), transient ? { statusCode: 503 } : {}));
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    for (let attempt = 0; attempt < 5; attempt++) {
      const saved = await journal(); const job: any = Object.values(saved.value.jobs)[0]; job.retryAt = 0;
      await writeFile(saved.path, JSON.stringify(saved.value)); await settle(s.makeBridge());
    }
    expect(s.api.loadInitialization).toHaveBeenCalledTimes(6);
    expect(s.dispatchReply).not.toHaveBeenCalled();
    expect(Object.values((await journal()).value.jobs)).toEqual([expect.objectContaining({ state: transient ? "pending" : "paused", attempts: 6 })]);
  });

  it("re-arms a future retry when a new receiver recovers the persisted journal", async () => {
    const s = setup(); s.api.loadInitialization.mockRejectedValue(Object.assign(new Error("temporary read failure"), { statusCode: 503 }));
    await dispatchInbound(event(), s.bridge.handlers); await settle(s.bridge);
    const saved = await journal(); const job: any = Object.values(saved.value.jobs)[0]; job.retryAt = Date.now() + 30_000;
    await writeFile(saved.path, JSON.stringify(saved.value));
    vi.resetModules();
    const { createCompanionReceiver } = await import("../../src/inbound/companion.js");
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await createCompanionReceiver({ accountId: "default", config: s.account.config, runtime: s.runtime as any, submit: vi.fn(), deliver: vi.fn() }).recover();
      expect(timer.mock.calls.some(([, delay]) => typeof delay === "number" && delay > 25_000 && delay <= 30_000)).toBe(true);
      expect(s.api.loadInitialization).toHaveBeenCalledTimes(1);
    } finally { timer.mockRestore(); }
  });

});
