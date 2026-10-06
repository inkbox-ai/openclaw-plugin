import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const state = vi.hoisted(() => ({ dir: "", fault: "" }));
vi.mock("../../src/state.js", async () => ({ statePaths: () => ({ dir: state.dir }), ensureStateDir: async () => (await import("node:fs/promises")).mkdir(state.dir, { recursive: true }) }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: any, to: any) => {
    if (state.fault && String(to).includes("imessage-outcomes-") && String(to).includes(`/${state.fault}/`)) { state.fault = ""; throw new Error("synthetic outcome write failure"); }
    return fs.rename(from, to);
  } };
});
vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({ resolveInboundRouteEnvelopeBuilderWithRuntime: () => ({ route: { agentId: "main", accountId: "default", sessionKey: "native-session" }, buildEnvelope: ({ body }: any) => ({ storePath: "memory:test", body }) }) }));
import { createIMessageOutcomes, imessageFailureNotice } from "../../src/inbound/imessage-outcomes.js";
import { COMPANION_MAX_BYTES, createCompanionReceiver } from "../../src/inbound/companion.js";
import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
const identityId = "11111111-1111-4111-8111-111111111111";
const queues: ReturnType<typeof createCompanionReceiver>[] = [];
const bridges: ReturnType<typeof createInkboxSessionBridge>[] = [];
const route = { scope: "original-source-scope", conversationId: "original-conversation", sourceMessageIds: ["source"], replyToMessageId: "source-parent", threadId: "source-thread", threadRootMessageId: null };
const accepted = { id: "accepted", replyToMessageId: null, threadId: null, threadRootMessageId: null };
const store = (who = identityId, account = "default", url = "https://inkbox.ai") => createIMessageOutcomes(account, url, who);
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "imessage-outcomes-")); state.fault = ""; });
afterEach(async () => { state.fault = ""; for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); } await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdownA2A())); await rm(state.dir, { recursive: true, force: true }); });
function incoming(id: string, conversationId = "conversation") { return { id: `event-${id}`, event_type: "imessage.received", companion: { channel: "imessage", phase: "ordinary", sequence: 1, scope_id: conversationId, conversation_id: conversationId }, data: { message: { id, conversation_id: conversationId, sender_number: "+15555550100", content: id, sender_access: "direct", _ordinaryAddressed: true, reply_to_message_id: null, thread_id: null, thread_root_message_id: null } }, _openclawNativeIMessage: { burstable: false } }; }
function queue(options: { submit?: any; deliver?: any; config?: any; who?: string; getIdentity?: any; warn?: any } = {}) {
  const submit = options.submit ?? vi.fn(async (input: any) => { await input.validateBeforeDispatch(); return ["answer"]; });
  const deliver = options.deliver ?? vi.fn(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); return "legacy-accepted"; });
  const config = options.config ?? { identity: "agent", baseUrl: "https://inkbox.ai", imessageThreadedReplies: true };
  const receiver = createCompanionReceiver({ accountId: "default", config, runtime: { getIdentity: options.getIdentity ?? (async () => ({ id: options.who ?? identityId })), getClient: async () => ({}) } as any, submit, deliver, warn: options.warn });
  queues.push(receiver); return { receiver, submit, deliver, config };
}
async function run(receiver: ReturnType<typeof createCompanionReceiver>, event: any) { await receiver.accept(event); await receiver.idle(); }

describe("native iMessage outcome correlation", () => {
  it("keeps first accepted original route and explicit null ancestry despite contradictory callback and later acceptance", async () => {
    const first = store(); await first.accepted(accepted, route);
    await first.failed(accepted.id, { ...route, scope: "foreign", conversationId: "foreign", replyToMessageId: "forged" });
    await first.accepted({ id: accepted.id, replyToMessageId: "replacement" }, { ...route, scope: "replacement" });
    const restored = store();
    expect(await restored.lookup(accepted.id)).toMatchObject({ failed: true, route, accepted: { replyToMessageId: null, threadId: null, threadRootMessageId: null } });
    expect(await restored.pending("foreign")).toEqual([]);
    const notices = await restored.pending(route.scope); expect(notices).toHaveLength(1);
    expect(imessageFailureNotice(notices[0]!)).toContain("Do not automatically resend");
    await restored.acknowledge(notices); await restored.failed(accepted.id); expect(await restored.pending(route.scope)).toEqual([]);
  });
  it("serializes concurrent accepted and failed writes without losing monotonic status or revisions", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, index) => index % 2 ? store().accepted(accepted, route) : store().failed(accepted.id, { ...route, scope: "callback" })));
    expect(await store().lookup(accepted.id)).toMatchObject({ revision: 8, failed: true, route });
    expect(await store().pending("callback")).toEqual([]); expect(await store().pending(route.scope)).toHaveLength(1);
  });
  it("retains callback-first without conversation and fills its route after acceptance and restart without clearing failure", async () => {
    await store().failed("early");
    expect(await store().lookup("early")).toMatchObject({ failed: true, messageId: "early" });
    expect((await store().lookup("early"))?.route).toBeUndefined();
    await store().accepted({ ...accepted, id: "early" }, route);
    expect(await store().pending(route.scope)).toHaveLength(1);
    expect((await store().lookup("early"))?.failed).toBe(true);
  });
  it("moves an unmatched pending notice from callback fallback to the original accepted scope", async () => {
    await store().failed("early", { ...route, scope: "callback" });
    expect(await store().pending("callback")).toHaveLength(1);
    await store().accepted({ ...accepted, id: "early" }, route);
    expect(await store().pending("callback")).toEqual([]); expect(await store().pending(route.scope)).toHaveLength(1);
  });
  it.each(["outputs", "notices"])("repairs an interrupted %s write from metadata-only intent without losing failed status", async (stage) => {
    await store().failed(accepted.id); state.fault = stage;
    await expect(store().accepted(accepted, route)).rejects.toThrow("synthetic outcome");
    await store().recover();
    expect(await store().lookup(accepted.id)).toMatchObject({ failed: true, route, accepted: { replyToMessageId: null, threadId: null, threadRootMessageId: null } });
    expect(await store().pending(route.scope)).toHaveLength(1);
    expect(await readdir(join(store().directory, "pending-writes"))).toEqual([]);
  });
  it("isolates account, environment and actual identity while preserving equivalent trailing-slash scope", async () => {
    await store().accepted(accepted, route); await store().failed(accepted.id);
    for (const other of [store("other-identity"), store(identityId, "other-account"), store(identityId, "default", "https://beta.inkbox.ai")]) expect(await other.lookup(accepted.id)).toBeUndefined();
    expect(await store(identityId, "default", "https://inkbox.ai/").lookup(accepted.id)).toMatchObject({ failed: true });
  });
  it.each(["hot", "archived"])("uses %s legacy primary receipt before contradictory callback route and never replays completed work", async (mode) => {
    let sourceInput: any;
    const f = queue({ submit: vi.fn(async (input: any) => { sourceInput = input; await input.validateBeforeDispatch(); if (mode === "hot") { await input.beforeApprovalSend("held"); } return ["answer"]; }) });
    await run(f.receiver, incoming("original")); f.receiver.close();
    const next = queue();
    await next.receiver.recordIMessageFailure({ id: "legacy-accepted", conversation_id: "wrong-conversation", reply_to_message_id: "forged-parent" });
    expect(next.submit).not.toHaveBeenCalled(); expect(next.deliver).not.toHaveBeenCalled();
    expect(await store().lookup("legacy-accepted")).toMatchObject({ failed: true, route: { scope: sourceInput.key, conversationId: "conversation", sourceMessageIds: ["original"], replyToMessageId: null }, accepted: { replyToMessageId: null, threadId: null, threadRootMessageId: null } });
    await run(next.receiver, incoming("wrong", "wrong-conversation")); expect(next.submit.mock.calls[0][0].body).not.toContain("delivery_failure");
    await run(next.receiver, incoming("fresh")); expect(next.submit.mock.calls[1][0].body).toContain('"messageId":"legacy-accepted"');
    await run(next.receiver, incoming("original")); expect(next.submit).toHaveBeenCalledTimes(2);
  });
  it("repairs a durable accepted intent before a disabled receiver handles a contradictory failure callback", async () => {
    state.fault = "outputs";
    await expect(store().accepted(accepted, route)).rejects.toThrow("synthetic outcome write failure");
    expect((await readdir(join(store().directory, "outputs"))).filter((name) => name.endsWith(".json"))).toEqual([]);
    expect(await readdir(join(store().directory, "pending-writes"))).toHaveLength(1);
    const restored = queue({ config: { identity: "agent", baseUrl: "https://inkbox.ai", imessageThreadedReplies: false } });
    await restored.receiver.recover();
    expect(await restored.receiver.recordIMessageFailure({ id: accepted.id, conversation_id: "contradictory", reply_to_message_id: "forged" })).toBe(true);
    expect(restored.submit).not.toHaveBeenCalled(); expect(restored.deliver).not.toHaveBeenCalled();
    expect(await store().lookup(accepted.id)).toMatchObject({ failed: true, route, accepted: { replyToMessageId: null, threadId: null, threadRootMessageId: null } });
    expect(await store().pending("contradictory")).toEqual([]); expect(await store().pending(route.scope)).toHaveLength(1);
  });
  it("does not create metadata or lock directories for an unknown outcome lookup", async () => {
    expect(await store().lookup("unknown")).toBeUndefined(); expect(await readdir(state.dir)).toEqual([]);
  });
  it("retains correlated failures while disabled and after allowlist/key changes for the same identity", async () => {
    const f = queue(); await run(f.receiver, incoming("old")); f.receiver.close();
    const config = { ...f.config, imessageThreadedReplies: false, apiKey: "rotated-synthetic", allowedRecipients: ["+15555559999"] };
    const next = queue({ config });
    expect(await next.receiver.recordIMessageFailure({ id: "legacy-accepted", conversation_id: "wrong" })).toBe(true);
    expect((await store().lookup("legacy-accepted"))?.route?.conversationId).toBe("conversation");
    expect(next.submit).not.toHaveBeenCalled(); expect(next.deliver).not.toHaveBeenCalled();
  });
  it("retains unmatched proactive failures quietly for the ordinary destination without source targeting", async () => {
    const f = queue(); await f.receiver.recordIMessageFailure({ id: "proactive", conversation_id: "conversation" });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.deliver).not.toHaveBeenCalled();
    expect(await store().lookup("proactive")).toMatchObject({ failed: true, fallback: { conversationId: "conversation", replyToMessageId: null } });
    expect((await store().lookup("proactive"))?.route).toBeUndefined();
    await run(f.receiver, incoming("later")); expect(f.submit.mock.calls[0][0].body).toContain('"messageId":"proactive"');
  });
  it.each(["automatic", "explicit", "approval"].flatMap((kind) => ["", "outputs", "notices"].map((fault) => ({ kind, fault }))))("correlates actual bridge $kind acceptance after callback-first and optional $fault write failure without model retry", async ({ kind, fault }) => {
    const contexts = new Map<string, any>(); let bridge: ReturnType<typeof createInkboxSessionBridge>;
    const sendIMessage = vi.fn(async () => { await bridge.handlers.onIMessage!({ event_type: "imessage.delivery_failed", data: { message: { id: "wire-accepted" } } } as any); state.fault = fault; return { ...accepted, id: "wire-accepted" }; });
    const identity = { id: identityId, sendIMessage, getIMessage: async (id: string) => ({ id, conversationId: "conversation" }), getIMessageThread: async () => ({ conversationId: "conversation" }), getIMessageConversationThread() {} };
    const runtime = { getIdentity: async () => identity, getClient: async () => ({}) };
    const dispatchReply = vi.fn(async (input: any) => {
      if (kind === "explicit") {
        const { registerSendIMessage } = await import("../../src/tools/send-imessage.js"); let factory: any;
        registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, runtime as any);
        expect((await factory({ sessionKey: input.routeSessionKey }).execute("call", { text: "answer" })).isError).not.toBe(true);
      } else if (kind === "approval") await contexts.get("approval.native").bindings.get(input.routeSessionKey)[0].deliver("approval", "request-1");
      else await input.delivery.deliver({ text: "answer" }, { kind: "final" });
      return { dispatched: true };
    });
    const core = { inbound: { buildContext: (v: any) => v, dispatchReply }, session: { recordInboundSession() {} }, reply: { dispatchReplyWithBufferedBlockDispatcher() {} }, runtimeContexts: { get: ({ capability }: any) => contexts.get(capability), register: ({ capability, context }: any) => { contexts.set(capability, context); return { dispose() {} }; } } };
    bridge = createInkboxSessionBridge({ account: { accountId: "default", identity: "agent", config: { identity: "agent", baseUrl: "https://inkbox.ai", imessageThreadedReplies: true } } as any, cfg: {}, runtime: runtime as any, channelRuntime: core }); bridges.push(bridge);
    await dispatchInbound(incoming("bridge-source"), bridge.handlers); await bridge.catchUpCompanion();
    expect(dispatchReply).toHaveBeenCalledOnce(); expect(sendIMessage).toHaveBeenCalledOnce();
    await bridge.catchUpCompanion();
    expect(dispatchReply).toHaveBeenCalledOnce(); expect(sendIMessage).toHaveBeenCalledOnce();
    expect(await store().lookup("wire-accepted")).toMatchObject({ failed: true, route: { conversationId: "conversation", sourceMessageIds: ["bridge-source"] }, accepted: { replyToMessageId: null, threadId: null, threadRootMessageId: null } });
  });
  it("bounds pending notice batches without rewriting or dropping other failed outputs", async () => {
    for (let n = 0; n < 66; n++) await store().failed(`failure-${n}`, route);
    const first = await store().pending(route.scope); expect(first).toHaveLength(64);
    await store().acknowledge(first);
    const second = await store().pending(route.scope); expect(second).toHaveLength(2);
    expect((await store().lookup(first[0]!.messageId))?.failed).toBe(true);
  });
  it.each([0, 1])("includes only %i fitting failure notices without rejecting valid source and pending context", async (fit) => {
    const f = queue(); await run(f.receiver, incoming("probe"));
    const probe = f.submit.mock.calls[0][0];
    const quiet = incoming("quiet"); quiet.data.message._ordinaryAddressed = false; quiet.data.message.sender_access = "mentioned"; quiet.data.message.content = "prior context";
    await run(f.receiver, quiet);
    const journalName = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name))!;
    const context = JSON.parse(await readFile(join(state.dir, journalName), "utf8")).context[probe.key];
    const original = { ...route, scope: probe.key, conversationId: "conversation" };
    await store().failed("failure-one", original); await store().failed("failure-two", original);
    const all = await store().pending(probe.key);
    const noticeBytes = Buffer.byteLength(imessageFailureNotice(all[0]!)) + 2;
    const plainBytes = Buffer.byteLength([...context, probe.body].join("\n\n"));
    const bodyBudget = COMPANION_MAX_BYTES - (fit ? noticeBytes + 8 : 8);
    const extraBytes = bodyBudget - plainBytes;
    const large = incoming("large"); large.data.message.content = "probe" + "é".repeat(Math.floor(extraBytes / 2)) + (extraBytes % 2 ? "x" : "");
    await run(f.receiver, large);
    expect(f.submit).toHaveBeenCalledTimes(2);
    const body = f.submit.mock.calls[1][0].body;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(COMPANION_MAX_BYTES);
    expect(body).toContain(large.data.message.content); expect(body).toContain("prior context");
    const included = all.filter((value) => body.includes(`"messageId":"${value.messageId}"`)); expect(included).toHaveLength(fit);
    const retained = await store().pending(probe.key); expect(retained).toHaveLength(2 - fit);
    await run(f.receiver, incoming("fresh"));
    for (const value of retained) expect(f.submit.mock.calls[2][0].body).toContain(`"messageId":"${value.messageId}"`);
    for (const value of included) expect(f.submit.mock.calls[2][0].body).not.toContain(`"messageId":"${value.messageId}"`);
    expect(await store().pending(probe.key)).toEqual([]);
  });
  it("does not resolve identity solely for disabled optional repair on an empty journal", async () => {
    const getIdentity = vi.fn(async () => { throw new Error("identity temporarily unavailable"); });
    const f = queue({ config: { identity: "agent", imessageThreadedReplies: false }, getIdentity });
    await expect(f.receiver.recover()).resolves.toBeUndefined(); expect(getIdentity).not.toHaveBeenCalled();
  });
  it("still recovers retained non-iMessage work when optional outcome repair cannot resolve identity", async () => {
    const f = queue({ submit: vi.fn(async () => { throw Object.assign(new Error("temporary read failure"), { name: "InkboxConnectionError" }); }) });
    const event: any = incoming("phone"); event.event_type = "text.received"; event.companion.channel = "phone";
    event.data.text_message = { ...event.data.message, text: "fresh phone request", sender_phone_number: "+15555550100" };
    delete event.data.message; delete event._openclawNativeIMessage;
    await run(f.receiver, event); f.receiver.close();
    const journalName = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name))!;
    const path = join(state.dir, journalName), journal = JSON.parse(await readFile(path, "utf8"));
    for (const job of Object.values(journal.jobs) as any[]) { expect(job.state).toBe("pending"); job.retryAt = 0; }
    await writeFile(path, JSON.stringify(journal));
    const warn = vi.fn(), getIdentity = vi.fn().mockRejectedValueOnce(new Error("optional identity read unavailable")).mockResolvedValue({ id: identityId });
    const restored = queue({ getIdentity, warn });
    await expect(restored.receiver.recover()).resolves.toBeUndefined();
    expect(restored.submit).toHaveBeenCalledOnce(); expect(restored.deliver).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("could not be recovered"));
  });
  it("accepted automatic send remains accepted when optional outcome persistence fails", async () => {
    const warn = vi.fn(); let captured: any;
    const receiver = createCompanionReceiver({ accountId: "default", config: { identity: "agent", baseUrl: "https://inkbox.ai", imessageThreadedReplies: true }, runtime: { getIdentity: async () => ({ id: identityId }), getClient: async () => ({}) } as any,
      submit: async (input) => { captured = input; await input.validateBeforeDispatch(); return ["answer"]; },
      deliver: async (input, _text, beforeSend) => { await beforeSend(); state.fault = "outputs"; await input.recordIMessageAccepted!(accepted); return accepted.id; }, warn }); queues.push(receiver);
    await run(receiver, incoming("accepted-during-fault")); expect(warn).toHaveBeenCalledWith(expect.stringContaining("accepted"));
    expect(await receiver.ownsDelivery(accepted.id)).toBe(true); await receiver.recover();
    expect(await store().lookup(accepted.id)).toMatchObject({ route: { scope: captured.key } });
    const journalName = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name))!;
    expect(Object.keys(JSON.parse(await readFile(join(state.dir, journalName), "utf8")).jobs)).toHaveLength(0);
  });
});
