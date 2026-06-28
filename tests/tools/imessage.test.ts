import { describe, expect, it, vi } from "vitest";
import { registerSendIMessage } from "../../src/tools/send-imessage.js";
import { registerIMessageReads } from "../../src/tools/imessage-reads.js";
import type { InkboxRuntime } from "../../src/client.js";
import { IMESSAGE_MAX_TEXT_CHARS } from "../../src/message-limits.js";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): { api: any; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  return {
    api: {
      registerTool: (def: RegisteredTool) => {
        tools.set(def.name, def);
      },
    },
    tools,
  };
}

function createRuntime(
  identity: Record<string, any>,
  client: Record<string, any> = {},
): InkboxRuntime {
  return {
    getIdentity: async () => identity as any,
    getClient: async () => client as any,
  };
}

describe("registerSendIMessage", () => {
  it("sends by conversationId", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn().mockResolvedValue({
      id: "im-1",
      conversationId: "imconv-123",
      status: "queued",
    });
    registerSendIMessage(api, createRuntime({ sendIMessage }));
    const out = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
      text: "hello",
    });
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      text: "hello",
    });
    expect(out.content[0].text).toContain("im-1");
  });

  it("requires exactly one of to or conversationId", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn();
    registerSendIMessage(api, createRuntime({ sendIMessage }));
    const both = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
      to: "+15555550101",
      text: "hello",
    });
    const neither = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      text: "hello",
    });
    expect(both.isError).toBe(true);
    expect(neither.isError).toBe(true);
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("requires text or media", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn();
    registerSendIMessage(api, createRuntime({ sendIMessage }));
    const out = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
    });
    expect(out.isError).toBe(true);
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("rejects over-limit text before sending", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn();
    registerSendIMessage(api, createRuntime({ sendIMessage }));

    const out = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
      text: "x".repeat(IMESSAGE_MAX_TEXT_CHARS + 1),
    });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("iMessage text is 18996 characters");
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("passes sendStyle and a single media URL through", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn().mockResolvedValue({
      id: "im-2",
      conversationId: "imconv-123",
      status: "queued",
    });
    registerSendIMessage(api, createRuntime({ sendIMessage }));
    await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
      text: "party!",
      mediaUrls: ["https://example.com/cake.png"],
      sendStyle: "confetti",
    });
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      text: "party!",
      mediaUrls: ["https://example.com/cake.png"],
      sendStyle: "confetti",
    });
  });

  it("enforces the outbound recipient allowlist", async () => {
    const { api, tools } = createApi();
    const sendIMessage = vi.fn();
    registerSendIMessage(api, createRuntime({ sendIMessage }), ["+14155550123"]);
    const blocked = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      to: "+15555550101",
      text: "hello",
    });
    const conversation = await tools.get("inkbox_send_imessage")!.execute("turn-1", {
      conversationId: "imconv-123",
      text: "hello",
    });
    expect(blocked.isError).toBe(true);
    // Conversation sends cannot be verified against the allowlist locally.
    expect(conversation.isError).toBe(true);
    expect(sendIMessage).not.toHaveBeenCalled();
  });
});

describe("registerIMessageReads", () => {
  it("lists conversations with default paging", async () => {
    const { api, tools } = createApi();
    const listIMessageConversations = vi.fn().mockResolvedValue([
      {
        id: "imconv-123",
        remoteNumber: "+15555550101",
        latestText: "hi",
        unreadCount: 1,
        totalCount: 3,
        assignmentStatus: "active",
      },
    ]);
    registerIMessageReads(api, createRuntime({ listIMessageConversations }));
    const out = await tools.get("inkbox_list_imessage_conversations")!.execute("turn-1", {});
    expect(listIMessageConversations).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(out.content[0].text).toContain("imconv-123");
    expect(out.content[0].text).toContain("assignmentStatus");
  });

  it("fetches one conversation's messages by conversationId", async () => {
    const { api, tools } = createApi();
    const listIMessages = vi.fn().mockResolvedValue([
      { id: "im-1", conversationId: "imconv-123" },
    ]);
    registerIMessageReads(api, createRuntime({ listIMessages }));
    await tools.get("inkbox_get_imessage_conversation")!.execute("turn-1", {
      conversationId: "imconv-123",
    });
    expect(listIMessages).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      limit: 50,
      offset: 0,
    });
  });

  it("returns the triage number and pins the connect command to this handle", async () => {
    const { api, tools } = createApi();
    const getTriageNumber = vi.fn().mockResolvedValue({
      number: "+15550009999",
      connectCommand: "connect @your-handle",
    });
    registerIMessageReads(
      api,
      createRuntime({ agentHandle: "smoke-agent" }, { imessages: { getTriageNumber } }),
    );
    const out = await tools.get("inkbox_imessage_triage_number")!.execute("turn-1", {});
    expect(out.content[0].text).toContain("+15550009999");
    expect(out.content[0].text).toContain("connect @smoke-agent");
  });

  it("lists active assignments", async () => {
    const { api, tools } = createApi();
    const listIMessageAssignments = vi.fn().mockResolvedValue([
      { id: "assign-1", remoteNumber: "+15555550101", status: "active" },
    ]);
    registerIMessageReads(api, createRuntime({ listIMessageAssignments }));
    const out = await tools.get("inkbox_list_imessage_assignments")!.execute("turn-1", {});
    expect(listIMessageAssignments).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(out.content[0].text).toContain("+15555550101");
  });

  it("sends a tapback reaction", async () => {
    const { api, tools } = createApi();
    const sendIMessageReaction = vi.fn().mockResolvedValue({
      id: "react-1",
      reaction: "like",
    });
    registerIMessageReads(api, createRuntime({ sendIMessageReaction }));
    const out = await tools.get("inkbox_send_imessage_reaction")!.execute("turn-1", {
      messageId: "im-1",
      reaction: "like",
    });
    expect(sendIMessageReaction).toHaveBeenCalledWith({
      messageId: "im-1",
      reaction: "like",
      partIndex: 0,
    });
    expect(out.content[0].text).toContain("like");
  });

  it("marks a conversation read", async () => {
    const { api, tools } = createApi();
    const markIMessageConversationRead = vi.fn().mockResolvedValue({
      conversationId: "imconv-123",
      updatedCount: 2,
    });
    registerIMessageReads(api, createRuntime({ markIMessageConversationRead }));
    const out = await tools.get("inkbox_mark_imessage_conversation_read")!.execute("turn-1", {
      conversationId: "imconv-123",
    });
    expect(markIMessageConversationRead).toHaveBeenCalledWith("imconv-123");
    expect(out.content[0].text).toContain("2 message");
  });
});
