import { AgentIdentity, Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindNativeSource, type NativeSource } from "../src/native-source.js";
import { registerSendIMessage } from "../src/tools/send-imessage.js";
import { registerSlackTools } from "../src/tools/slack.js";
afterEach(() => vi.unstubAllGlobals());
function source(): NativeSource { return { identityId: "identity", conversationId: "conversation", replyToMessageId: "first-source", author: "+15555550100", closed: false, beforeSend: vi.fn(), afterSend: vi.fn() }; }
function iMessageTool(sessionKey: string, sendIMessage = vi.fn(async () => ({ id: "accepted" }))) {
  let factory: any;
  registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, { getIdentity: async () => ({ id: "identity", sendIMessage }) } as any);
  return { tool: factory({ sessionKey }), sendIMessage };
}
describe("immutable native reply source", () => {
  it("binds explicit iMessage replies to first source with API-only fallback", async () => {
    const src = source(), close = bindNativeSource("session-one", src), { tool, sendIMessage } = iMessageTool("session-one");
    try {
      const result = await tool.execute("call-id", { conversationId: "conversation", text: "answer", completeSilently: true });
      expect(result.terminate).toBe(true);
      expect(sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation", replyToMessageId: "first-source", plainReplyFallback: true, idempotencyKey: expect.stringMatching(/^openclaw:tool:[a-f0-9]{64}$/), text: "answer" });
      expect(src.beforeSend).toHaveBeenCalledWith("call-id"); expect(src.afterSend).toHaveBeenCalledWith("call-id", "accepted");
    } finally { close(); }
  });
  it.each([{ replyToMessageId: "other" }, { plainReplyFallback: false }, { to: "+15555550102" }, { conversationId: "other" }])("rejects model-controlled retargeting %j", async (override) => {
    const close = bindNativeSource("session-reject", source()), { tool, sendIMessage } = iMessageTool("session-reject");
    try { expect((await tool.execute("call", { text: "answer", ...override })).isError).toBe(true); expect(sendIMessage).not.toHaveBeenCalled(); } finally { close(); }
  });
  it("does not inherit a previous source in proactive turns or stale prepared tools", async () => {
    const close = bindNativeSource("session-old", source()), prepared = iMessageTool("session-old"); close();
    expect((await prepared.tool.execute("old", { text: "answer" })).isError).toBe(true); expect(prepared.sendIMessage).not.toHaveBeenCalled();
    const proactive = iMessageTool("session-old"); await proactive.tool.execute("new", { conversationId: "conversation", text: "fresh" });
    expect(proactive.sendIMessage).toHaveBeenCalledWith({ conversationId: "conversation", text: "fresh" });
  });
  it("serializes native iMessage source and API fallback through the published SDK without retry", async () => {
    const requests: RequestInit[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => { requests.push(init); return new Response(JSON.stringify({ message: { id: "accepted", agent_identity_id: "identity", conversation_id: "conversation", content: "answer", status: "sent" } }), { status: 200, headers: { "content-type": "application/json" } }); }));
    const sdk = new Inkbox({ apiKey: "synthetic-key", baseUrl: "https://sdk.test" });
    const identity = new AgentIdentity({ id: "identity", agentHandle: "synthetic", imessageEnabled: true } as any, sdk);
    const src = source(), close = bindNativeSource("sdk-native-source", src); let factory: any;
    registerSendIMessage({ registerTool: (value: any) => { factory = value; } }, { getIdentity: async () => identity } as any);
    try {
      const result = await factory({ sessionKey: "sdk-native-source" }).execute("native-call|1", { text: "answer" });
      expect(result.isError).not.toBe(true); expect(requests).toHaveLength(1);
      expect(JSON.parse(String(requests[0]!.body))).toMatchObject({ conversation_id: "conversation", reply_to_message_id: "first-source", plain_reply_fallback: true });
      expect(new Headers(requests[0]!.headers).get("Idempotency-Key")).toMatch(/^openclaw:tool:[a-f0-9]{64}$/);
    } finally { close(); }
  });
  it("preserves explicit null Slack source thread and refuses a model thread override", async () => {
    const src: NativeSource = { ...source(), replyToMessageId: undefined, slackRoute: { identityId: "identity", connectionId: "connection", conversationId: "CROOM", workspaceId: "TWORK", actorId: "USER", messageTs: "1.1", sourceEventId: "event", author: "TWORK:USER", threadTs: null, mentioned: true, addressed: true, direct: false, rawText: "ask", text: "ask" } };
    const close = bindNativeSource("slack", src), factories: any[] = [], sendMessage = vi.fn(async () => ({ id: "accepted", status: "sent" }));
    try {
      registerSlackTools({ registerTool: (factory: any) => factories.push(factory) }, { getIdentity: async () => ({ id: "identity" }), getClient: async () => ({ slack: { listConnections: async () => ({ connections: [{ id: "connection", identityId: "identity", status: "connected" }] }), sendMessage } }) } as any, () => ({ slackEnabled: true }));
      const tool = factories.map((factory) => factory({ sessionKey: "slack" })).find((tool) => tool.name === "inkbox_slack_send_message");
      expect((await tool.execute("wrong", { connectionId: "connection", conversationId: "CROOM", threadTs: "1.1", text: "answer", idempotencyKey: "wrong" })).isError).toBe(true);
      expect(sendMessage).not.toHaveBeenCalled();
      await tool.execute("right", { connectionId: "connection", conversationId: "CROOM", text: "answer", idempotencyKey: "right" });
      expect(sendMessage).toHaveBeenCalledWith("connection", { conversationId: "CROOM", threadTs: null, text: "answer", idempotencyKey: "right" });
    } finally { close(); }
  });
});
