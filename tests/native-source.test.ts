import { AgentIdentity, Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindNativeSource, revokeNativeSourceRun, type NativeSource } from "../src/native-source.js";
import { registerSendIMessage } from "../src/tools/send-imessage.js";
import { registerIMessageReads } from "../src/tools/imessage-reads.js";
import { registerSlackTools } from "../src/tools/slack.js";
afterEach(() => vi.unstubAllGlobals());
function source(): NativeSource { return { identityId: "identity", conversationId: "conversation", replyToMessageId: "first-source", author: "+15555550100", closed: false, validate: vi.fn(), beforeSend: vi.fn(), afterSend: vi.fn() }; }
function iMessageTool(sessionKey: string, sendIMessage = vi.fn(async () => ({ id: "accepted" })), overrides: Record<string, unknown> = {}, enabled = () => true) {
  let factory: any;
  registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, { getIdentity: async () => ({ id: "identity", sendIMessage, getIMessage: async (id: string) => ({ id, conversationId: "conversation" }), getIMessageThread: async () => ({ conversationId: "conversation" }), getIMessageConversationThread() {}, ...overrides }) } as any, undefined, enabled);
  return { tool: factory({ sessionKey }), sendIMessage };
}
describe("immutable native reply source", () => {
  it.each(["before", "preflight", "intent"])("does not continue or downgrade an owned send when disabled during %s", async (phase) => {
    let enabled = phase !== "before";
    const src = source(), close = bindNativeSource("disable-owned", src);
    if (phase === "intent") src.beforeSend = vi.fn(async () => { enabled = false; });
    const { tool, sendIMessage } = iMessageTool("disable-owned", undefined, { getIMessageThread: async () => { if (phase === "preflight") enabled = false; return { conversationId: "conversation" }; } }, () => enabled);
    try {
      expect((await tool.execute("send", { text: "answer" })).isError).toBe(true); expect(sendIMessage).not.toHaveBeenCalled();
      if (phase !== "intent") expect(src.beforeSend).not.toHaveBeenCalled();
    } finally { close(); }
    const proactive = iMessageTool("unrelated-proactive", undefined, {}, () => false);
    await proactive.tool.execute("fresh", { conversationId: "conversation", text: "explicit proactive" });
    expect(proactive.sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation", text: "explicit proactive" });
  });
  it("binds explicit iMessage replies to first source with API-only fallback", async () => {
    const src = source(), close = bindNativeSource("session-one", src), { tool, sendIMessage } = iMessageTool("session-one");
    try {
      const result = await tool.execute("call-id", { conversationId: "conversation", text: "answer", completeSilently: true });
      expect(result.terminate).toBe(true);
      expect(sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation", replyToMessageId: "first-source", plainReplyFallback: true, idempotencyKey: expect.stringMatching(/^openclaw:tool:[a-f0-9]{64}$/), text: "answer" });
      expect(src.beforeSend).toHaveBeenCalledWith("call-id"); expect(src.afterSend).toHaveBeenCalledWith("call-id", "accepted", "answer");
    } finally { close(); }
  });
  it.each([{ replyToMessageId: "other" }, { plainReplyFallback: false }])("rejects model-controlled retargeting %j", async (override) => {
    const close = bindNativeSource("session-reject", source()), { tool, sendIMessage } = iMessageTool("session-reject");
    try { expect((await tool.execute("call", { text: "answer", ...override })).isError).toBe(true); expect(sendIMessage).not.toHaveBeenCalled(); } finally { close(); }
  });
  it.each([{ to: "+15555550102" }, { conversationId: "another-conversation" }])("keeps an explicitly separate iMessage send independent of source-answer receipts: %j", async (target) => {
    const src = source(), close = bindNativeSource("separate-send", src), { tool, sendIMessage } = iMessageTool("separate-send");
    try {
      expect((await tool.execute("separate", { ...target, text: "same text" })).isError).not.toBe(true);
      expect(sendIMessage).toHaveBeenCalledWith({ ...target, text: "same text" });
      expect(src.validate).toHaveBeenCalledOnce(); expect(src.beforeSend).not.toHaveBeenCalled(); expect(src.afterSend).not.toHaveBeenCalled();
      expect((await tool.execute("answer", { text: "same text" })).isError).not.toBe(true);
      expect(sendIMessage).toHaveBeenCalledTimes(2);
      expect(src.afterSend).toHaveBeenCalledTimes(1); expect(src.afterSend).toHaveBeenCalledWith("answer", "accepted", "same text");
    } finally { close(); }
  });
  it("rejects independent sends when the captured owner closes during its final validation", async () => {
    const src = source(), close = bindNativeSource("separate-stale", src), { tool, sendIMessage } = iMessageTool("separate-stale");
    src.validate = async () => { close(); };
    expect((await tool.execute("separate", { conversationId: "another-conversation", text: "not sent" })).isError).toBe(true);
    expect(sendIMessage).not.toHaveBeenCalled(); expect(src.beforeSend).not.toHaveBeenCalled();
  });
  it("does not inherit a previous source in proactive turns or stale prepared tools", async () => {
    const close = bindNativeSource("session-old", source()), prepared = iMessageTool("session-old"); close();
    expect((await prepared.tool.execute("old", { text: "answer" })).isError).toBe(true); expect(prepared.sendIMessage).not.toHaveBeenCalled();
    const proactive = iMessageTool("session-old"); await proactive.tool.execute("new", { conversationId: "conversation", text: "fresh" });
    expect(proactive.sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation", text: "fresh" });
  });
  it("does not send after source closure while durable send intent is awaited", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), hold = new Promise<void>((resolve) => { release = resolve; });
    const src = source(); src.beforeSend = async () => { entered(); await hold; };
    const close = bindNativeSource("closing-source", src), { tool, sendIMessage } = iMessageTool("closing-source");
    const pending = tool.execute("intent", { text: "answer" }); await started; close(); release();
    expect((await pending).isError).toBe(true); expect(sendIMessage).not.toHaveBeenCalled();
  });
  it("revokes only the exact native run and blocks its already prepared tool", async () => {
    const src = { ...source(), runId: "owned-run" }, close = bindNativeSource("fenced-source", src);
    const { tool, sendIMessage } = iMessageTool("fenced-source");
    try {
      revokeNativeSourceRun("another-session", "owned-run");
      revokeNativeSourceRun("fenced-source", "other-run");
      expect(src.closed).toBe(false);
      revokeNativeSourceRun("fenced-source", "owned-run");
      expect((await tool.execute("stale", { text: "answer" })).isError).toBe(true);
      expect(sendIMessage).not.toHaveBeenCalled();
    } finally { close(); }
  });
  it("serializes native iMessage source and API fallback through the published SDK without retry", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init: RequestInit) => { requests.push(init); return new Response(JSON.stringify(String(url).includes("/thread") ? { conversation_id: "conversation", messages: [], thread_id: null } : init.method === "POST" ? { message: { id: "accepted", agent_identity_id: "identity", conversation_id: "conversation", content: "answer", status: "sent" } } : { id: "first-source", agent_identity_id: "identity", conversation_id: "conversation", content: "answer", status: "received" }), { status: 200, headers: { "content-type": "application/json" } }); }));
    const sdk = new Inkbox({ apiKey: "synthetic-key", baseUrl: "https://sdk.test" });
    const identity = new AgentIdentity({ id: "identity", agentHandle: "synthetic", imessageEnabled: true } as any, sdk);
    const src = source(), close = bindNativeSource("sdk-native-source", src); let factory: any;
    registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, { getIdentity: async () => identity } as any);
    try {
      const result = await factory({ sessionKey: "sdk-native-source" }).execute("native-call|1", { text: "answer" });
      expect(result.isError).not.toBe(true); expect(requests).toHaveLength(3);
      expect(requests.map((request) => request.method)).toEqual(["GET", "GET", "POST"]);
      expect(JSON.parse(String(requests[2]!.body))).toMatchObject({ conversation_id: "conversation", reply_to_message_id: "first-source", plain_reply_fallback: true });
      expect(new Headers(requests[2]!.headers).get("Idempotency-Key")).toMatch(/^openclaw:tool:[a-f0-9]{64}$/);
    } finally { close(); }
  });
  it.each(["missing-sdk", "foreign-source", "foreign-thread", "old-api"])("fails before intent or send when native preflight fails: %s", async (mode) => {
    const src = source(), close = bindNativeSource("preflight", src);
    const overrides = mode === "missing-sdk" ? { getIMessageThread: undefined } : mode === "foreign-source" ? { getIMessage: async () => ({ id: "first-source", conversationId: "other" }) } : { getIMessageThread: async () => { if (mode === "old-api") throw new Error("unavailable"); return { conversationId: "other" }; } };
    const { tool, sendIMessage } = iMessageTool("preflight", undefined, overrides);
    try {
      expect((await tool.execute("send", { text: "answer" })).isError).toBe(true);
      expect(src.beforeSend).not.toHaveBeenCalled(); expect(sendIMessage).not.toHaveBeenCalled();
    } finally { close(); }
  });
  it("rejects a source canceled during the native capability probe before recording intent", async () => {
    const src = source(), close = bindNativeSource("probe-stop", src);
    const { tool, sendIMessage } = iMessageTool("probe-stop", undefined, { getIMessageThread: async () => { close(); return { conversationId: "conversation" }; } });
    expect((await tool.execute("send", { text: "answer" })).isError).toBe(true);
    expect(src.beforeSend).not.toHaveBeenCalled(); expect(sendIMessage).not.toHaveBeenCalled();
  });
  it("scopes native thread reads to active conversation and never expands Companion history", async () => {
    const src = source(), close = bindNativeSource("thread-read", src), tools: any[] = [];
    const identity = { id: "identity", getIMessage: vi.fn(async () => ({ conversationId: "other" })), getIMessageThread: vi.fn(async () => ({})), getIMessageConversationThread: vi.fn(async () => ({})) };
    registerIMessageReads({ registerTool: (value: any) => { tools.push(typeof value === "function" ? value({ sessionKey: "thread-read" }) : value); } }, { getIdentity: async () => identity } as any);
    const message = tools.find((tool) => tool.name === "inkbox_get_imessage_thread"), conversation = tools.find((tool) => tool.name === "inkbox_get_imessage_conversation_thread");
    try {
      expect((await message.execute("wrong", { messageId: "foreign-source" })).isError).toBe(true); expect(identity.getIMessageThread).not.toHaveBeenCalled();
      expect((await conversation.execute("wrong", { conversationId: "other", threadId: "opaque" })).isError).toBe(true); expect(identity.getIMessageConversationThread).not.toHaveBeenCalled();
      identity.getIMessage.mockResolvedValue({ conversationId: "conversation" });
      expect((await message.execute("right", { messageId: "visible-source", cursor: "opaque-cursor" })).isError).not.toBe(true); expect(identity.getIMessageThread).toHaveBeenCalledTimes(1);
      src.companion = true; expect((await message.execute("companion", { messageId: "visible-source" })).isError).toBe(true); expect(identity.getIMessageThread).toHaveBeenCalledTimes(1);
    } finally { close(); }
    src.companion = false; expect((await conversation.execute("stale", { conversationId: "conversation", threadId: "opaque" })).isError).toBe(true); expect(identity.getIMessageConversationThread).not.toHaveBeenCalled();
  });
  it("withholds a thread page if its native source closes during the final SDK await", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), hold = new Promise<void>((resolve) => { release = resolve; });
    const src = source(), close = bindNativeSource("read-closing", src), tools: any[] = [];
    const identity = { id: "identity", getIMessageConversationThread: vi.fn(async () => { entered(); await hold; return { text: "must-not-expose-history" }; }) };
    registerIMessageReads({ registerTool: (value: any) => tools.push(typeof value === "function" ? value({ sessionKey: "read-closing" }) : value) }, { getIdentity: async () => identity } as any);
    const pending = tools.find((tool) => tool.name === "inkbox_get_imessage_conversation_thread").execute("read", { conversationId: "conversation", threadId: "opaque" });
    await started; close(); release(); const result = await pending;
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("must-not-expose-history");
  });
  it("allows enabled iMessage reads from Slack Companion without bypassing current source ownership", async () => {
    const src = { ...source(), companion: true, replyToMessageId: undefined, slackRoute: { conversationId: "CROOM" } as any }, close = bindNativeSource("companion-no-imessage-target", src), tools: any[] = [];
    const getIMessageThread = vi.fn(async () => ({ messages: [] })), getIdentity = vi.fn(async () => ({ id: "identity", getIMessageThread }));
    registerIMessageReads({ registerTool: (value: any) => tools.push(typeof value === "function" ? value({ sessionKey: "companion-no-imessage-target" }) : value) }, { getIdentity } as any);
    try {
      const result = await tools.find((tool) => tool.name === "inkbox_get_imessage_thread").execute("read", { messageId: "any" });
      expect(result.isError).not.toBe(true); expect(getIMessageThread).toHaveBeenCalledTimes(1); expect(getIMessageThread).toHaveBeenCalledWith("any", { limit: undefined, cursor: undefined });
      close();
      expect((await tools.find((tool) => tool.name === "inkbox_get_imessage_thread").execute("stale", { messageId: "any" })).isError).toBe(true);
      expect(getIMessageThread).toHaveBeenCalledOnce();
    } finally { close(); }
  });
  it("preserves inline source replies and treats an explicitly different thread as an independent send", async () => {
    const src: NativeSource = { ...source(), replyToMessageId: undefined, slackRoute: { identityId: "identity", connectionId: "connection", conversationId: "CROOM", workspaceId: "TWORK", actorId: "USER", messageTs: "1.1", sourceEventId: "event", author: "TWORK:USER", threadTs: null, mentioned: true, addressed: true, direct: false, rawText: "ask", text: "ask" } };
    const close = bindNativeSource("slack", src), factories: any[] = [], sendMessage = vi.fn(async () => ({ id: "accepted", status: "sent" }));
    try {
      registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getIdentity: async () => ({ id: "identity" }), getClient: async () => ({ slack: { listConnections: async () => ({ connections: [{ id: "connection", identityId: "identity", workspaceId: "TWORK", status: "connected" }] }), sendMessage } }) } as any, () => ({ slackEnabled: true }));
      const tool = factories.map((factory) => factory({ sessionKey: "slack" })).find((tool) => tool.name === "inkbox_slack_send_message");
      expect((await tool.execute("separate", { connectionId: "connection", conversationId: "CROOM", threadTs: "1.1", text: "answer", idempotencyKey: "separate" })).isError).not.toBe(true);
      expect(sendMessage).toHaveBeenCalledWith("connection", { conversationId: "CROOM", threadTs: "1.1", text: "answer", idempotencyKey: "separate" });
      expect(src.beforeSend).not.toHaveBeenCalled(); expect(src.afterSend).not.toHaveBeenCalled(); expect(src.validate).toHaveBeenCalledOnce();
      await tool.execute("right", { connectionId: "connection", conversationId: "CROOM", text: "answer", idempotencyKey: "right" });
      expect(sendMessage).toHaveBeenCalledWith("connection", { conversationId: "CROOM", threadTs: null, text: "answer", idempotencyKey: "right" });
    } finally { close(); }
  });
});
