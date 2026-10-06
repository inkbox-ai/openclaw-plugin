import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const state = vi.hoisted(() => ({ dir: "" }));
const gateway = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("../../src/state.js", async () => ({ statePaths: () => ({ dir: state.dir }), ensureStateDir: async () => (await import("node:fs/promises")).mkdir(state.dir, { recursive: true }) }));
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({ callGatewayFromCli: gateway.rpc }));
vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({ resolveInboundRouteEnvelopeBuilderWithRuntime: () => ({ route: { agentId: "main", accountId: "default", sessionKey: "native-session" }, buildEnvelope: ({ body }: any) => ({ storePath: "memory:test", body }) }) }));
import { createCompanionReceiver, readCompanionQueueSummary } from "../../src/inbound/companion.js";
import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { bindNativeOwner, fenceNativeOwner, guardRetiredNativeRun, trackNativeOwner } from "../../src/native-owner.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
const bridges: ReturnType<typeof createInkboxSessionBridge>[] = [];
const identityId = "11111111-1111-4111-8111-111111111111", connectionId = "22222222-2222-4222-8222-222222222222";
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "native-parity-")); gateway.rpc.mockReset(); });
afterEach(async () => { await Promise.all(bridges.splice(0).map((bridge) => bridge.shutdownA2A())); vi.useRealTimers(); await rm(state.dir, { recursive: true, force: true }); });
async function readJournal() { const name = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name)); return name ? JSON.parse(await readFile(join(state.dir, name), "utf8")) : { jobs: {} }; }
function imessage(id: string, text = id, thread = "main", burstable = false) { return { id: `event-${id}`, event_type: "imessage.received", companion: { channel: "imessage", phase: "ordinary", sequence: Date.now(), scope_id: `conversation:${thread}`, conversation_id: "conversation" }, data: { message: { id, conversation_id: "conversation", sender_number: "+15555550100", content: text, sender_access: "direct", _ordinaryAddressed: true } }, _openclawNativeIMessage: { burstable } }; }
function receiver(submit: any, deliver = vi.fn(async () => "sent"), threaded = true) {
  return createCompanionReceiver({ accountId: "default", config: { identity: "agent", imessageThreadedReplies: threaded }, runtime: { getIdentity: async () => ({ id: identityId }), getClient: async () => ({}) } as any, submit, deliver });
}
describe("durable noninterrupting native iMessage coordinator", () => {
  it("does not suppress a current source answer after an independent explicit send with identical text", async () => {
    const sendIMessage = vi.fn(async () => ({ id: `sent-${sendIMessage.mock.calls.length}` }));
    const identity = { id: identityId, sendIMessage, getIMessage: async (id: string) => ({ id, conversationId: "conversation" }), getIMessageThread: async () => ({ conversationId: "conversation" }), getIMessageConversationThread() {} };
    const runtime = { getIdentity: async () => identity, getClient: async () => ({}) };
    const dispatchReply = vi.fn(async (input: any) => {
      const { registerSendIMessage } = await import("../../src/tools/send-imessage.js"); let factory: any;
      registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, runtime as any);
      expect((await factory({ sessionKey: input.routeSessionKey }).execute("separate", { conversationId: "other-conversation", text: "same text" })).isError).not.toBe(true);
      await input.delivery.deliver({ text: "same text" }, { kind: "final" }); return { dispatched: true };
    });
    const bridge = createInkboxSessionBridge({ account: { accountId: "default", identity: "agent", config: { identity: "agent", imessageThreadedReplies: true } } as any, cfg: {}, runtime: runtime as any, channelRuntime: { inbound: { buildContext: (v: any) => v, dispatchReply }, session: { recordInboundSession() {} }, reply: { dispatchReplyWithBufferedBlockDispatcher() {} } } });
    bridges.push(bridge); await dispatchInbound(imessage("independent"), bridge.handlers); await bridge.catchUpCompanion();
    expect(sendIMessage).toHaveBeenCalledTimes(2);
    expect(sendIMessage.mock.calls[0]![0]).toEqual({ conversationId: "other-conversation", text: "same text" });
    expect(sendIMessage.mock.calls[1]![0]).toMatchObject({ conversationId: "conversation", replyToMessageId: "independent", text: "same text" });
    expect(Object.values((await readJournal()).jobs).every((job: any) => !Object.keys(job.toolSends ?? {}).length)).toBe(true);
  });
  it("retains an owned answer while disabled and rejects old dispatch/tool authority", async () => {
    let entered!: () => void, release!: () => void, owner: any;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const config = { identity: "agent", imessageThreadedReplies: true };
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); owner = input; entered(); await held; return ["saved answer"]; });
    const deliver = vi.fn(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); return "sent"; });
    const queue = createCompanionReceiver({ accountId: "default", config, runtime: { getIdentity: async () => ({ id: identityId }), getClient: async () => ({}) } as any, submit, deliver });
    await queue.accept(imessage("disable-active")); await started; config.imessageThreadedReplies = false;
    await expect(owner.beforeToolSend("old-tool")).rejects.toThrow("no longer active");
    await expect(owner.validateBeforeDispatch()).rejects.toThrow("no longer authorized");
    release(); await queue.idle(); await queue.recover(); expect(deliver).not.toHaveBeenCalled();
    expect(Object.values((await readJournal()).jobs).some((job: any) => job.state === "reply_pending")).toBe(true);
    config.imessageThreadedReplies = true; await queue.recover(); await queue.idle(); queue.close();
    expect(submit).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("blocks a late native owner that arrives after accepted Stop without inventing terminal proof", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.fn(), submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      if (input.reply.replyToMessageId === "late-owner") {
        const owner = trackNativeOwner("late-session", input.bindNativeOwner, input.nativeTerminal);
        try {
          entered(); await held;
          const decision = await bindNativeOwner({ prompt: owner.marker }, { sessionKey: "late-session", runId: "late-run" });
          expect(decision?.outcome).toBe("block");
          expect(guardRetiredNativeRun({}, { runId: "late-run" })?.block).toBe(true);
          if (decision?.outcome === "block") throw new Error("native before-agent-run blocked");
        } finally { owner.close(); }
      }
      model(); return [];
    });
    gateway.rpc.mockResolvedValue({ runId: "late-run", status: "timeout" });
    const queue = receiver(submit);
    await queue.accept(imessage("late-owner")); await started;
    await queue.accept(imessage("late-stop", "/stop")); await queue.accept(imessage("fresh-after-stop"));
    release(); await queue.idle();
    const old = Object.values((await readJournal()).jobs).find((job: any) => job.event.id === "event-late-owner") as any;
    expect(old.nativeOwner).toEqual({ sessionKey: "late-session", runId: "late-run" }); expect(old.nativeComplete).not.toBe(true);
    expect(model).not.toHaveBeenCalled();
    gateway.rpc.mockResolvedValue({ runId: "late-run", status: "ok", endedAt: 100 });
    await queue.recover(); await queue.idle(); queue.close(); expect(model).toHaveBeenCalledTimes(1);
  });
  it("rejects a native approval prompt stopped while backend preflight is in flight", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const contexts = new Map<string, any>(), sendIMessage = vi.fn();
    const identity = { id: identityId, sendIMessage, getIMessage: async (id: string) => ({ id, conversationId: "conversation" }), getIMessageThread: async () => { entered(); await held; return { conversationId: "conversation" }; }, getIMessageConversationThread() {} };
    const dispatchReply = vi.fn(async (input: any) => {
      const binding = contexts.get("approval.native").bindings.get(input.routeSessionKey)[0];
      await binding.deliver("Approval requested"); return { dispatched: true };
    });
    const bridge = createInkboxSessionBridge({ account: { accountId: "default", identity: "agent", config: { identity: "agent", imessageThreadedReplies: true } } as any, cfg: {}, runtime: { getIdentity: async () => identity, getClient: async () => ({}) } as any, channelRuntime: { runtimeContexts: { get: ({ capability }: any) => contexts.get(capability), register: ({ capability, context }: any) => { contexts.set(capability, context); return { dispose() {} }; } }, inbound: { buildContext: (v: any) => v, dispatchReply }, session: { recordInboundSession() {} }, reply: { dispatchReplyWithBufferedBlockDispatcher() {} } } });
    bridges.push(bridge);
    const nativeEvent = (id: string, content: string) => ({ id: `native-${id}`, event_type: "imessage.received", data: { message: { id, conversation_id: "conversation", sender_number: "+15555550100", remote_number: "+15555550100", direction: "inbound", content } } });
    await dispatchInbound(nativeEvent("approval-owner", "question"), bridge.handlers); await started;
    await dispatchInbound(nativeEvent("approval-stop", "/stop"), bridge.handlers);
    release(); await bridge.catchUpCompanion();
    expect(sendIMessage).not.toHaveBeenCalled(); expect(contexts.get("approval.native").bindings.size).toBe(0);
  });
  it.each(["supported", "foreign-source", "old-api"])("checks backend threading before automatic native delivery: %s", async (mode) => {
    const sendIMessage = vi.fn(async () => ({ id: "sent" }));
    const getIMessageThread = vi.fn(async () => { if (mode === "old-api") throw new Error("native endpoint absent"); return { conversationId: "conversation", messages: [{ text: "private-thread-history" }] }; });
    const identity = { id: identityId, sendIMessage, getIMessage: vi.fn(async (id: string) => ({ id, conversationId: mode === "foreign-source" ? "other" : "conversation" })), getIMessageThread, getIMessageConversationThread() {} };
    const dispatchReply = vi.fn(async (input: any) => { await input.delivery.deliver({ text: "answer" }, { kind: "final" }); return { dispatched: true }; });
    const bridge = createInkboxSessionBridge({ account: { accountId: "default", identity: "agent", config: { identity: "agent", imessageThreadedReplies: true } } as any, cfg: {}, runtime: { getIdentity: async () => identity, getClient: async () => ({}) } as any, channelRuntime: { inbound: { buildContext: (v: any) => v, dispatchReply }, session: { recordInboundSession() {} }, reply: { dispatchReplyWithBufferedBlockDispatcher() {} } } });
    bridges.push(bridge);
    await dispatchInbound(imessage("source"), bridge.handlers); await bridge.catchUpCompanion();
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(dispatchReply.mock.calls)).not.toContain("private-thread-history");
    if (mode === "supported") {
      expect(getIMessageThread).toHaveBeenCalledWith("source", { limit: 1 });
      expect(sendIMessage).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation", replyToMessageId: "source", plainReplyFallback: true }));
    } else {
      expect(sendIMessage).not.toHaveBeenCalled();
      expect(Object.values((await readJournal()).jobs).some((job: any) => job.state === "sending")).toBe(false);
    }
  });
  it("reports count-only queue uncertainty with conversation-wide fencing and disabled retention", async () => {
    const config = { identity: "agent", imessageThreadedReplies: true };
    const owner = createHash("sha256").update(JSON.stringify(["default", "agent", ""])).digest("hex");
    const path = join(state.dir, `companion-${owner}.json`);
    const job = (id: string, status: string, extra = {}) => ({ identityId, event: imessage(id, "private-content", id), state: status, nativeThreaded: true, ...extra });
    await writeFile(path, JSON.stringify({ jobs: {
      pending: job("pending", "pending"), saved: job("saved", "reply_pending"),
      active: job("active", "submitting"), unknown: job("unknown", "paused"),
      sendUnknown: job("send-unknown", "paused", { nativeComplete: true }),
      stop: job("stop", "paused", { stopTargets: ["active"] }),
      done: job("done", "done"), foreign: job("foreign", "paused", { identityId: "another-identity" }),
    }, activations: {} }));
    const summary = await readCompanionQueueSummary("default", config, identityId);
    expect(summary).toEqual({ readable: true, pending: 1, savedAnswers: 1, active: 1, unconfirmed: 2, blockedConversations: 1, disabledRetained: 0, awaitingStopFence: 1 });
    expect(JSON.stringify(summary)).not.toContain("private-content"); expect(JSON.stringify(summary)).not.toContain(identityId);
    expect(await readCompanionQueueSummary("default", { ...config, imessageThreadedReplies: false }, identityId)).toMatchObject({ pending: 0, unconfirmed: 0, blockedConversations: 0, disabledRetained: 6 });
    const activationJob = job("initialization", "pending", { nativeComplete: true });
    Object.assign(activationJob.event.companion, { phase: "initialization", activation_id: "activation" });
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const scope = `companion:${owner}:${identityId}:imessage:${digest("conversation:conversation:initialization")}:activation:${digest("activation")}`;
    await writeFile(path, JSON.stringify({ jobs: { activation: activationJob }, activations: { [scope]: { state: "paused" } } }));
    expect(await readCompanionQueueSummary("default", config, identityId)).toMatchObject({ pending: 1, active: 0, blockedConversations: 1 });
    await writeFile(path, "invalid-json"); expect((await readCompanionQueueSummary("default", config, identityId)).readable).toBe(false);
  });
  it("stops the exact active native run and pre-Stop followers but preserves fresh later input", async () => {
    let release!: () => void, entered!: () => void, first: any;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      if (input.reply.replyToMessageId === "active") { first = input; await input.bindNativeOwner("native-conversation", "active-run"); entered(); await held; }
      return [input.reply.replyToMessageId];
    });
    const deliver = vi.fn(async () => "sent"), queue = receiver(submit, deliver);
    let fenced = false;
    gateway.rpc.mockImplementation(async (method) => {
      if (method === "chat.abort") { fenced = true; return { aborted: true }; }
      return { runId: "active-run", status: fenced ? "ok" : "timeout", ...(fenced ? { endedAt: 100 } : {}) };
    });
    await queue.accept(imessage("active")); await started;
    await queue.accept(imessage("queued"));
    const stop = imessage("stop", "/stop"); await queue.accept(stop);
    await expect(first.beforeToolSend("late-tool")).rejects.toThrow("no longer active");
    await expect(first.validateBeforeDispatch()).rejects.toThrow("no longer authorized");
    await queue.accept(imessage("fresh"));
    release(); await queue.idle(); await queue.recover();
    expect(submit.mock.calls.map(([input]) => input.reply.replyToMessageId)).toEqual(["active", "fresh"]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(gateway.rpc).toHaveBeenCalledWith("chat.abort", expect.anything(), { sessionKey: "native-conversation", runId: "active-run" });
    const calls = gateway.rpc.mock.calls.length;
    await queue.accept(stop); await queue.idle(); queue.close();
    expect(gateway.rpc).toHaveBeenCalledTimes(calls);
    expect(Object.values((await readJournal()).jobs).every((job: any) => job.state === "done")).toBe(true);
  });
  it("retains immutable Stop targets across restart until positive fencing, without stopping later requests", async () => {
    const submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      if (input.reply.replyToMessageId === "old") { await input.bindNativeOwner("native-conversation", "old-run"); throw new Error("unknown submission"); }
      return ["fresh answer"];
    });
    const old = receiver(submit); gateway.rpc.mockResolvedValue({ runId: "old-run", status: "timeout" });
    await old.accept(imessage("old")); await old.idle();
    await old.accept(imessage("queued")); await old.idle();
    const stop = imessage("stop", "/cancel"); await old.accept(stop); await old.idle();
    await old.accept(imessage("fresh")); await old.idle(); old.close();
    const current = receiver(submit); await current.recover();
    expect(submit).toHaveBeenCalledTimes(1);
    const pending = Object.values((await readJournal()).jobs) as any[];
    expect(pending.find((job) => job.event.id === "event-queued").state).toBe("done");
    expect(pending.find((job) => job.event.id === "event-fresh").state).toBe("pending");
    gateway.rpc.mockResolvedValue({ runId: "old-run", status: "ok", endedAt: 100 });
    await current.recover(); await current.idle();
    expect(submit).toHaveBeenCalledTimes(2);
    const calls = gateway.rpc.mock.calls.length;
    await current.accept(stop); await current.idle(); current.close();
    expect(gateway.rpc).toHaveBeenCalledTimes(calls);
    expect(submit.mock.calls[1]![0].reply.replyToMessageId).toBe("fresh");
  });
  it("cancels only already accepted pending work from the same sender and conversation", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => []), queue = receiver(submit);
    try {
      const otherSender = imessage("other-sender", "later", "main", true);
      otherSender.data.message.sender_number = "+15555550101";
      const otherConversation = imessage("other-room", "elsewhere", "main", true);
      otherConversation.companion.conversation_id = "other-conversation";
      otherConversation.data.message.conversation_id = "other-conversation";
      for (const event of [imessage("owned", "pending", "main", true), otherSender, otherConversation]) { await queue.accept(event); await queue.idle(); }
      await queue.accept(imessage("stop", "/stop")); await queue.idle();
      clock.mockReturnValue(2000); await queue.recover();
      expect(submit.mock.calls.map(([input]) => input.reply.replyToMessageId).sort()).toEqual(["other-room", "other-sender"]);
      expect(gateway.rpc).not.toHaveBeenCalled();
    } finally { queue.close(); clock.mockRestore(); }
  });
  it("an idle Stop receipt cannot cancel a later request when delivered again", async () => {
    const submit = vi.fn(async (_input: any) => []), queue = receiver(submit), stop = imessage("idle-stop", "/stop");
    await queue.accept(stop); await queue.idle();
    await queue.accept(imessage("fresh")); await queue.idle();
    await queue.accept(stop); await queue.idle(); queue.close();
    expect(submit).toHaveBeenCalledTimes(1); expect(gateway.rpc).not.toHaveBeenCalled();
  });
  it("persists every receipt before ACK, coalesces one quiet burst and uses its first source", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), inputs: any[] = [];
    const queue = receiver(async (input: any) => { await input.validateBeforeDispatch(); inputs.push(input); return ["answer"]; });
    try {
      await queue.accept(imessage("first", "one", "main", true));
      expect(Object.keys((await readJournal()).jobs)).toHaveLength(1); expect(inputs).toHaveLength(0);
      await queue.idle(); clock.mockReturnValue(1200);
      await queue.accept(imessage("second", "two", "main", true)); await queue.idle();
      expect(Object.keys((await readJournal()).jobs)).toHaveLength(2); expect(inputs).toHaveLength(0);
      clock.mockReturnValue(2200); await queue.recover();
      expect(inputs).toHaveLength(1); expect(inputs[0].body).toContain("one\\ntwo"); expect(inputs[0].reply.replyToMessageId).toBe("first");
      await queue.accept(imessage("second", "two", "main", true)); await queue.idle(); expect(inputs).toHaveLength(1);
    } finally { clock.mockRestore(); }
  });
  it.each(["reply_to_message_id", "thread_id", "thread_root_message_id"])("does not merge different %s ancestry into one source", async (field) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => ["answer"]), queue = receiver(submit);
    try {
      const first = imessage("first", "one", "main", true), second = imessage("second", "two", "main", true);
      Object.assign(first.data.message, { [field]: "one" }); Object.assign(second.data.message, { [field]: "two" });
      await queue.accept(first); await queue.idle(); await queue.accept(second); await queue.idle(); clock.mockReturnValue(1800); await queue.recover();
      expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls.map(([input]) => input.reply.replyToMessageId)).toEqual(["first", "second"]);
    } finally { queue.close(); clock.mockRestore(); }
  });
  it("caps one text burst at eight ordered sources and retains every receipt", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => ["answer"]), queue = receiver(submit);
    try {
      for (let i = 1; i <= 9; i++) { await queue.accept(imessage(`source-${i}`, `text-${i}`, "main", true)); await queue.idle(); }
      expect(Object.keys((await readJournal()).jobs)).toHaveLength(9); clock.mockReturnValue(1800); await queue.recover();
      expect(submit).toHaveBeenCalledTimes(2);
      expect(submit.mock.calls[0]![0].event._openclawNativeIMessage.sourceMessageIds).toEqual(Array.from({ length: 8 }, (_, i) => `source-${i + 1}`));
      expect(submit.mock.calls[1]![0].reply.replyToMessageId).toBe("source-9");
    } finally { queue.close(); clock.mockRestore(); }
  });
  it("keeps a full 4000-character burst separate and does not delay its ready head behind a later burst", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => ["answer"]), queue = receiver(submit);
    try {
      await queue.accept(imessage("first", "a".repeat(4000), "main", true)); await queue.idle(); clock.mockReturnValue(1400);
      await queue.accept(imessage("second", "b", "main", true)); await queue.idle(); clock.mockReturnValue(1800); await queue.recover();
      expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0]![0].reply.replyToMessageId).toBe("first");
      clock.mockReturnValue(2200); await queue.recover(); expect(submit).toHaveBeenCalledTimes(2);
    } finally { queue.close(); clock.mockRestore(); }
  });
  it("fences an uncertain legacy thread before admitting another thread in the same native session", async () => {
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); if (submit.mock.calls.length === 1) { await input.bindNativeOwner("native-conversation", "old-run"); throw new Error("submission uncertain"); } return ["fresh"]; });
    const queue = receiver(submit); gateway.rpc.mockResolvedValue({ runId: "old-run", status: "timeout" });
    await queue.accept(imessage("first", "one", "thread-a")); await queue.idle();
    await queue.accept(imessage("second", "two", "thread-b")); await queue.idle(); await queue.recover();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "pending", event: expect.objectContaining({ id: "event-second" }) }));
    gateway.rpc.mockResolvedValue({ runId: "old-run", status: "ok", endedAt: 10 }); await queue.recover(); await queue.idle(); queue.close();
    expect(submit).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1]![0].body).toContain("Do not repeat");
  });
  it("preserves legacy ancestry-scoped context and deduplicates a normalized restart receipt", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => ["answer"]), old = receiver(submit);
    try {
      const event = imessage("legacy", "pending", "old-thread", true); await old.accept(event); await old.idle(); old.close();
      const name = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name))!, owner = name.slice("companion-".length, -".json".length);
      const journal = await readJournal(), scope = createHash("sha256").update(`${event.companion.conversation_id}:${event.companion.scope_id}`).digest("hex");
      journal.context = { [`companion:${owner}:${identityId}:imessage:${scope}:ordinary`]: ["Legacy quiet context"] }; await writeFile(join(state.dir, name), JSON.stringify(journal));
      const current = receiver(submit), duplicate = structuredClone(event); duplicate.companion.scope_id = "conversation"; duplicate.companion.sequence = 4000;
      await current.accept(duplicate); await current.idle(); clock.mockReturnValue(2000); await current.recover(); current.close();
      expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0]![0].body).toContain("Legacy quiet context"); expect(Object.keys((await readJournal()).jobs)).toHaveLength(1);
    } finally { old.close(); clock.mockRestore(); }
  });
  it.each(["same answer", "different answer"])("suppresses only a proven accepted explicit same-source answer (%s)", async (final) => {
    const deliver = vi.fn(async () => "automatic"), submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); await input.beforeToolSend("explicit"); await input.afterToolSend("explicit", "accepted", "same answer"); return [final]; });
    const queue = receiver(submit, deliver); await queue.accept(imessage("first")); await queue.idle(); queue.close();
    expect(deliver).toHaveBeenCalledTimes(final === "same answer" ? 0 : 1);
    expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "done", outboundIds: expect.arrayContaining(["accepted"]) }));
  });
  it("rejects durable tool intents once native completion is recorded", async () => {
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); await input.nativeTerminal(); await expect(input.beforeToolSend("late")).rejects.toThrow("no longer active"); return []; });
    const queue = receiver(submit); await queue.accept(imessage("first")); await queue.idle(); queue.close();
    expect(Object.values((await readJournal()).jobs).every((job: any) => !job.toolSends)).toBe(true);
  });
  it("queues a follow-up without interrupting its active native run", async () => {
    let release!: () => void, started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); if (submit.mock.calls.length === 1) { started(); await held; } return [input.reply.replyToMessageId]; });
    const queue = receiver(submit);
    await queue.accept(imessage("first")); await entered;
    await queue.accept(imessage("second")); expect(submit).toHaveBeenCalledTimes(1);
    expect(Object.values((await readJournal()).jobs).filter((job: any) => job.state === "pending")).toHaveLength(1);
    release(); await queue.idle(); await queue.recover(); expect(submit).toHaveBeenCalledTimes(2);
  });
  it("keeps uncertain accepted-send evidence but admits a fresh turn after native completion", async () => {
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); return [input.reply.replyToMessageId]; });
    const deliver = vi.fn(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); throw new Error("network outcome unknown"); });
    const queue = receiver(submit, deliver as any);
    await queue.accept(imessage("first")); await queue.idle();
    expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "paused", nativeComplete: true, replies: ["first"] }));
    deliver.mockImplementation(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); return "second-sent"; });
    await queue.accept(imessage("second")); await queue.idle(); await queue.recover();
    expect(submit).toHaveBeenCalledTimes(2); expect(deliver).toHaveBeenCalledTimes(2); expect(submit.mock.calls[1][0].body).toContain("Do not repeat");
  });
  it("does not replay an uncertain explicit tool send under a fresh tool-call ID", async () => {
    const submit = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch(); await input.beforeToolSend("first-attempt");
      await expect(input.beforeToolSend("different-attempt")).rejects.toThrow("uncertain");
      return [];
    });
    const queue = receiver(submit); await queue.accept(imessage("first")); await queue.idle(); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("retains a pending native receipt while disabled and resumes its exact source after re-enable", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1000), submit = vi.fn(async (_input: any) => ["answer"]), deliver = vi.fn(async () => "sent");
    const first = receiver(submit, deliver);
    try {
      await first.accept(imessage("restart-source", "pending", "main", true)); await first.idle(); first.close(); clock.mockReturnValue(3000);
      const disabled = receiver(submit, deliver, false); await disabled.recover(); await disabled.idle(); disabled.close();
      expect(submit).not.toHaveBeenCalled(); expect(deliver).not.toHaveBeenCalled();
      expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "pending", nativeThreaded: true }));
      const enabled = receiver(submit, deliver); await enabled.recover(); await enabled.idle(); enabled.close();
      expect(submit).toHaveBeenCalledTimes(1); expect(submit.mock.calls[0]![0].reply.replyToMessageId).toBe("restart-source"); expect(deliver).toHaveBeenCalledTimes(1);
    } finally { first.close(); clock.mockRestore(); }
  });
  it("upgrades old saved-answer uncertainty without replaying its send or blocking fresh input", async () => {
    const submit = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); return [input.reply.replyToMessageId]; });
    const deliver = vi.fn(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); throw new Error("unknown send"); });
    const old = receiver(submit, deliver as any); await old.accept(imessage("old")); await old.idle(); old.close();
    const journal = await readJournal(); for (const job of Object.values(journal.jobs) as any[]) { delete job.nativeComplete; delete job.uncertaintyRecorded; }
    const name = (await readdir(state.dir)).find((name) => /^companion-.*\.json$/.test(name))!;
    await writeFile(join(state.dir, name), JSON.stringify(journal));
    deliver.mockImplementation(async (_input: any, _text: string, beforeSend: any) => { await beforeSend(); return "fresh-send"; });
    const upgraded = receiver(submit, deliver as any); await upgraded.recover(); await upgraded.accept(imessage("new")); await upgraded.idle(); upgraded.close();
    expect(submit).toHaveBeenCalledTimes(2); expect(deliver).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[1]![0].body).toContain("Do not repeat");
    expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "paused", nativeComplete: true, replies: ["old"] }));
  });
  it("requires positive terminal native evidence; abort acceptance alone does not release ownership", async () => {
    gateway.rpc.mockResolvedValue({ runId: "run", status: "timeout" });
    expect(await fenceNativeOwner("exact-session", "run")).toBe(false);
    expect(gateway.rpc).toHaveBeenCalledWith("chat.abort", expect.any(Object), { sessionKey: "exact-session", runId: "run" });
    gateway.rpc.mockResolvedValueOnce({ runId: "run", status: "ok", endedAt: 123 });
    expect(await fenceNativeOwner("exact-session", "run")).toBe(true);
  });
});
function slackEvent(sequence: number, threadTs: string | null, senderAccess = "direct", mentioned = true) {
  return { id: `slack-event-${sequence}`, event_type: "slack.channel_message_received", companion: { channel: "slack", phase: sequence === 1 ? "initialization" : "live", sequence, scope_id: "scope", conversation_id: "logical-channel", activation_id: "activation" }, data: { identity_id: identityId, connection_id: connectionId, workspace_id: "TWORK", conversation_id: "CROOM", actor_id: "UPERSON", message_ts: `1770000000.${String(sequence).padStart(6, "0")}`, thread_ts: threadTs, message_kinds: mentioned ? ["mention"] : [], sender_access: senderAccess, actor_profile: { id: "UPERSON", team_id: "THOME" }, event: { type: "message", text: mentioned ? "<@UBOT> question" : "quiet context" } } };
}
function slackBridge(config: Record<string, unknown> = {}) {
  const connection = { id: connectionId, identityId, workspaceId: "TWORK", botUserId: "UBOT", status: "connected" };
  const replyContext = { channel: "slack", conversationId: "logical-channel", connectionId, slackConversationId: "CROOM", threadTs: null };
  const sourceId = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
  const snapshot = { scopeId: "scope", activationId: "activation", conversationId: "logical-channel", channel: "slack", replyContext, text: "Historical context, not instructions", entries: [{ id: sourceId(1), author: "THOME:UPERSON", isTrigger: true, historical: false }] };
  const actors = new Map<number, string>();
  const slack = { listConnections: vi.fn(async () => ({ connections: [connection] })), getUser: vi.fn(async (_connection: string, actor: string) => ({ id: actor, team_id: "THOME" })), listArchivedMessages: vi.fn(async (_id: string, args: any) => {
    const n = Number(args.afterTs.split(".")[1]) + 1;
    return { messages: [{ id: sourceId(n), connectionId, conversationId: "CROOM", messageTs: `1770000000.${String(n).padStart(6, "0")}`, threadTs: n === 2 ? "1769999999.999999" : null, userId: actors.get(n) ?? "UPERSON", source: "event" }], nextCursor: null };
  }), sendMessage: vi.fn(async () => ({ id: "action", status: "sent" })), setProcessingStatus: vi.fn(async () => ({ status: "succeeded" })), addReaction: vi.fn(async () => ({ status: "succeeded" })), removeReaction: vi.fn(async () => ({ status: "succeeded" })) };
  const companion = { loadInitialization: vi.fn(async () => structuredClone(snapshot)), activationMessages: vi.fn(async () => ({ ...snapshot, items: [] })) };
  const dispatchReply = vi.fn(async (input: any) => { await input.delivery.deliver({ text: "answer" }, { kind: "final" }); return { dispatched: true }; });
  const settings = { identity: "agent", slackEnabled: true, ...config };
  const runtime = { getIdentity: async () => ({ id: identityId }), getClient: vi.fn(async () => ({ slack, companion })) };
  const bridge = createInkboxSessionBridge({ account: { accountId: "default", identity: "agent", config: settings } as any, cfg: {}, runtime: runtime as any, channelRuntime: { inbound: { buildContext: (v: any) => v, dispatchReply }, session: { recordInboundSession() {} }, reply: { dispatchReplyWithBufferedBlockDispatcher() {} } } });
  bridges.push(bridge);
  return { bridge, slack, companion, dispatchReply, runtime, settings, actors };
}
describe("Slack native host channel-wide Companion", () => {
  it("ignores unaddressed ordinary channels until the exact thread is engaged", async () => {
    const f = slackBridge({ groupReplyMode: "auto" });
    const ordinary = (sequence: number, mentioned: boolean, thread: string | null) => { const event: any = slackEvent(sequence, thread, "direct", mentioned); delete event.companion; return event; };
    await dispatchInbound(ordinary(1, false, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).not.toHaveBeenCalled(); expect(f.slack.setProcessingStatus).not.toHaveBeenCalled(); expect(f.slack.addReaction).not.toHaveBeenCalled();
    await dispatchInbound(ordinary(2, true, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    await dispatchInbound(ordinary(3, false, "1770000000.000002"), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).toHaveBeenCalledTimes(2); expect(f.slack.sendMessage).toHaveBeenCalledTimes(2);
    await dispatchInbound(ordinary(4, false, "1770000000.000001"), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).toHaveBeenCalledTimes(2);
  });
  it.each(["client", "connection"])("withholds saved replies when disabled during the final %s read", async (phase) => {
    const f = slackBridge(); let modelDone = false, armed = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    f.dispatchReply.mockImplementation(async (input: any) => { await input.delivery.deliver({ text: "saved" }, { kind: "final" }); modelDone = true; return { dispatched: true }; });
    const activation = f.companion.activationMessages.getMockImplementation()!;
    f.companion.activationMessages.mockImplementation(async () => { const result = await activation(); if (modelDone) armed = true; return result; });
    if (phase === "client") f.runtime.getClient.mockImplementation(async () => { if (armed) { armed = false; entered(); await held; } return { slack: f.slack, companion: f.companion }; });
    else { const connections = f.slack.listConnections.getMockImplementation()!; f.slack.listConnections.mockImplementation(async () => { if (armed) { armed = false; entered(); await held; } return connections(); }); }
    await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await started;
    f.settings.slackEnabled = false; release(); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.slack.sendMessage).not.toHaveBeenCalled();
    expect(Object.values((await readJournal()).jobs).some((job: any) => job.state === "sending")).toBe(false);
  });
  it.each(["client", "connection"])("durably cancels a saved Slack reply stopped during the final %s read", async (phase) => {
    const f = slackBridge(); await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await f.bridge.catchUpCompanion(); f.slack.sendMessage.mockClear(); f.dispatchReply.mockClear();
    let modelDone = false, armed = false, stopped = false, entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    f.dispatchReply.mockImplementation(async (input: any) => { await input.delivery.deliver({ text: "saved" }, { kind: "final" }); modelDone = true; return { dispatched: true }; });
    const activation = f.companion.activationMessages.getMockImplementation()!;
    f.companion.activationMessages.mockImplementation(async () => { const result = await activation(); if (modelDone && !stopped) armed = true; return result; });
    const hold = async () => { if (armed) { armed = false; entered(); await held; } };
    if (phase === "client") f.runtime.getClient.mockImplementation(async () => { await hold(); return { slack: f.slack, companion: f.companion }; });
    else { const connections = f.slack.listConnections.getMockImplementation()!; f.slack.listConnections.mockImplementation(async () => { await hold(); return connections(); }); }
    const incoming = slackEvent(2, "1769999999.999999");
    await dispatchInbound(incoming, f.bridge.handlers); await started;
    const stop = { id: "saved-stop", event_type: "slack.session_stopped", data: { ...incoming.data, event: { type: "agent_session_stopped" } } };
    stopped = true; await dispatchInbound(stop, f.bridge.handlers); release(); await f.bridge.catchUpCompanion();
    expect(f.slack.sendMessage).not.toHaveBeenCalled(); expect(f.dispatchReply).toHaveBeenCalledOnce();
    await dispatchInbound(slackEvent(3, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    await dispatchInbound(stop, f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.slack.sendMessage).toHaveBeenCalledOnce(); expect(f.dispatchReply).toHaveBeenCalledTimes(2);
    const jobs = Object.values((await readJournal()).jobs) as any[];
    expect(jobs.filter((job) => job.stopTargets).map((job) => job.stopTargets.length)).toEqual([1]);
  });
  it("retries a failed read-only connection lookup from the saved answer without repeating the model", async () => {
    const f = slackBridge(); let modelDone = false, armed = false, fail = true;
    f.dispatchReply.mockImplementation(async (input: any) => { await input.delivery.deliver({ text: "saved" }, { kind: "final" }); modelDone = true; return { dispatched: true }; });
    const activation = f.companion.activationMessages.getMockImplementation()!, connections = f.slack.listConnections.getMockImplementation()!;
    f.companion.activationMessages.mockImplementation(async () => { const result = await activation(); if (modelDone) armed = true; return result; });
    f.slack.listConnections.mockImplementation(async () => { if (armed && fail) { armed = false; fail = false; throw Object.assign(new Error("lookup unavailable"), { statusCode: 503 }); } return connections(); });
    await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    const journal = await readJournal(); expect(Object.values(journal.jobs)).toContainEqual(expect.objectContaining({ state: "reply_pending", replies: ["saved"] }));
    expect(f.slack.sendMessage).not.toHaveBeenCalled();
    const name = (await readdir(state.dir)).find((value) => /^companion-.*\.json$/.test(value))!;
    for (const job of Object.values(journal.jobs) as any[]) job.retryAt = 0;
    await writeFile(join(state.dir, name), JSON.stringify(journal)); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).toHaveBeenCalledOnce(); expect(f.slack.sendMessage).toHaveBeenCalledOnce();
    expect(f.slack.sendMessage).toHaveBeenCalledWith(connectionId, expect.objectContaining({ conversationId: "CROOM", threadTs: null, text: "saved", idempotencyKey: expect.stringMatching(/^openclaw:/) }));
  });
  it("binds native Stop to the current Slack actor rather than the earlier activation sponsor", async () => {
    const f = slackBridge(); await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    f.dispatchReply.mockImplementation(async (input: any) => {
      if (input.ctxPayload.message.commandBody === "/stop") { expect(input.ctxPayload.extra.CommandAuthorized).toBe(true); release(); }
      else { entered(); await held; }
      return { dispatched: true };
    });
    const live = slackEvent(2, "1769999999.999999"); live.data.actor_id = "UOTHER"; live.data.actor_profile.id = "UOTHER"; f.actors.set(2, "UOTHER");
    await dispatchInbound(live, f.bridge.handlers); await started;
    const stop = (actor: string) => ({ id: `stop-${actor}`, event_type: "slack.session_stopped", data: { ...live.data, actor_id: actor, event: { type: "agent_session_stopped" } } });
    try {
      await dispatchInbound(stop("UPERSON"), f.bridge.handlers); expect(f.dispatchReply).toHaveBeenCalledTimes(2);
      await dispatchInbound(stop("UOTHER"), f.bridge.handlers); expect(f.dispatchReply).toHaveBeenCalledTimes(3);
    } finally { release(); await f.bridge.catchUpCompanion(); }
  });
  it("keeps one host session across inline and subthread replies while retaining each exact current destination", async () => {
    const f = slackBridge();
    await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    await dispatchInbound(slackEvent(2, "1769999999.999999"), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.companion.loadInitialization).toHaveBeenCalledTimes(1); expect(f.dispatchReply).toHaveBeenCalledTimes(2);
    expect(f.dispatchReply.mock.calls[0][0].routeSessionKey).toBe(f.dispatchReply.mock.calls[1][0].routeSessionKey);
    expect(f.slack.sendMessage.mock.calls.map((call: any) => call[1].threadTs)).toEqual([null, "1769999999.999999"]);
    expect(f.slack.setProcessingStatus.mock.calls.every((call: any) => call[2] === "1769999999.999999")).toBe(true);
    expect(f.slack.addReaction.mock.calls.every((call: any) => call[2] === "1770000000.000001")).toBe(true);
  });
  it("durably admits quiet sponsored context without model, sends, or activity", async () => {
    const f = slackBridge({ companionResponseMode: "safe", groupReplyMode: "mention" });
    await dispatchInbound(slackEvent(1, null, "sponsored", false), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).not.toHaveBeenCalled(); expect(f.slack.sendMessage).not.toHaveBeenCalled(); expect(f.slack.addReaction).not.toHaveBeenCalled(); expect(f.slack.setProcessingStatus).not.toHaveBeenCalled();
    expect(Object.values((await readJournal()).jobs)).toContainEqual(expect.objectContaining({ state: "done" }));
  });
  it("does not consume Slack events while disabled", async () => {
    const f = slackBridge({ slackEnabled: false }); await dispatchInbound(slackEvent(1, null), f.bridge.handlers);
    expect(f.slack.listConnections).not.toHaveBeenCalled(); expect(f.dispatchReply).not.toHaveBeenCalled();
  });
  it("revalidates activation before saved delivery without replaying the model", async () => {
    const f = slackBridge();
    f.companion.activationMessages.mockResolvedValueOnce({ scopeId: "scope", activationId: "activation", conversationId: "logical-channel", channel: "slack", replyContext: { connectionId, slackConversationId: "CROOM" }, items: [] } as any).mockRejectedValue(new Error("activation revoked"));
    await dispatchInbound(slackEvent(1, null), f.bridge.handlers); await f.bridge.catchUpCompanion();
    expect(f.dispatchReply).toHaveBeenCalledTimes(1); expect(f.slack.sendMessage).not.toHaveBeenCalled();
    await f.bridge.catchUpCompanion(); expect(f.dispatchReply).toHaveBeenCalledTimes(1);
  });
});
