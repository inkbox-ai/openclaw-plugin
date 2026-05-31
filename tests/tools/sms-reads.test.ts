import { describe, expect, it, vi } from "vitest";
import { registerSmsReads } from "../../src/tools/sms-reads.js";
import type { InkboxRuntime } from "../../src/client.js";

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

function createRuntime(identity: Record<string, any>): InkboxRuntime {
  return {
    getIdentity: async () => identity as any,
    getClient: async () => ({} as any),
  };
}

describe("registerSmsReads", () => {
  it("lists conversations with groups included by default", async () => {
    const { api, tools } = createApi();
    const listTextConversations = vi.fn().mockResolvedValue([
      { id: "conv-group", participants: ["+15551234567", "+15557654321"], isGroup: true },
    ]);
    registerSmsReads(api, createRuntime({ listTextConversations }));
    const out = await tools.get("inkbox_list_text_conversations")!.execute("turn-1", {});
    expect(listTextConversations).toHaveBeenCalledWith({
      limit: 25,
      offset: 0,
      includeGroups: true,
    });
    expect(out.content[0].text).toContain("conv-group");
  });

  it("gets a conversation by conversationId", async () => {
    const { api, tools } = createApi();
    const getTextConversation = vi.fn().mockResolvedValue([{ id: "txt-1" }]);
    registerSmsReads(api, createRuntime({ getTextConversation }));
    await tools.get("inkbox_get_text_conversation")!.execute("turn-1", {
      conversationId: "conv-1",
      limit: 10,
    });
    expect(getTextConversation).toHaveBeenCalledWith("conv-1", { limit: 10, offset: 0 });
  });

  it("keeps the remotePhoneNumber fallback for 1:1 conversations", async () => {
    const { api, tools } = createApi();
    const markTextConversationRead = vi.fn().mockResolvedValue({
      conversationId: "conv-1",
      updatedCount: 2,
    });
    registerSmsReads(api, createRuntime({ markTextConversationRead }));
    const out = await tools.get("inkbox_mark_text_conversation_read")!.execute("turn-1", {
      remotePhoneNumber: "+15551234567",
    });
    expect(markTextConversationRead).toHaveBeenCalledWith("+15551234567");
    expect(out.content[0].text).toContain("2 message");
  });

  it("rejects ambiguous conversation keys", async () => {
    const { api, tools } = createApi();
    const getTextConversation = vi.fn();
    registerSmsReads(api, createRuntime({ getTextConversation }));
    const out = await tools.get("inkbox_get_text_conversation")!.execute("turn-1", {
      conversationId: "conv-1",
      remotePhoneNumber: "+15551234567",
    });
    expect(out.isError).toBe(true);
    expect(getTextConversation).not.toHaveBeenCalled();
  });
});
