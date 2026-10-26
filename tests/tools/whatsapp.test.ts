import { describe, expect, it, vi } from "vitest";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
function fixture(allowed?: string[]) {
  const tools = new Map<string, any>();
  const identity: any = {
    id: "identity-a",
    whatsappEnabled: false,
    getWhatsAppStatus: vi.fn(async () => ({ enabled: true, status: "ready" })),
    getWhatsAppConversation: vi.fn(async () => ({
      agentIdentityId: "identity-a",
      isGroup: false,
      participants: ["+15555550123"],
      remoteNumber: "+15555550123",
    })),
    sendWhatsApp: vi.fn(async () => ({
      id: "message-a",
      conversationId: "conversation-a",
      status: "queued",
      deliveryState: "pending",
    })),
    getWhatsAppMedia: vi.fn(async () => ({ id: "media-a", status: "ready" })),
    markWhatsAppRead: vi.fn(async () => ({ updatedCount: 1 })),
  };
  const lookup = vi.fn(async () => "message-a");
  registerWhatsAppTools(
    {
      registerTool(def: any) {
        const tool = typeof def === "function" ? def({}) : def;
        tools.set(tool.name, tool);
      },
    },
    {
      getIdentity: async () => identity,
      getClient: async () => ({ messageSends: { lookup } }) as any,
    },
    allowed,
  );
  return { identity, lookup, tools };
}
describe("dedicated WhatsApp tools", () => {
  it("registers all ten tools before approval and checks fresh readiness rather than cached flags", async () => {
    const f = fixture();
    expect(f.tools.size).toBe(10);
    await f.tools
      .get("inkbox_send_whatsapp")
      .execute("call-a", { to: "+15555550123", text: "Hello" });
    expect(f.identity.getWhatsAppStatus).toHaveBeenCalled();
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  });
  it("reuses the logical key and owned media IDs across an uncertain tool retry", async () => {
    const f = fixture();
    f.identity.sendWhatsApp.mockRejectedValueOnce(
      new TypeError("lost response"),
    );
    const p = {
      conversationId: "conversation-a",
      text: "Brief",
      mediaIds: ["media-a"],
    };
    await f.tools.get("inkbox_send_whatsapp").execute("call-a", p);
    await f.tools.get("inkbox_send_whatsapp").execute("call-a", p);
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual(
      f.identity.sendWhatsApp.mock.calls[1][0],
    );
    expect(f.identity.sendWhatsApp.mock.calls[1][0].mediaIds).toEqual([
      "media-a",
    ]);
  });
  it("rejects disabled, group-shaped, overlong and locally blocked sends without fallback", async () => {
    const f = fixture(["+15555550111"]);
    for (const p of [
      { to: "+15555550123", text: "Hi" },
      { to: "+15555550111", text: "x".repeat(4001) },
      { to: "+15555550111", text: "Hi", mediaIds: ["a", "b"] },
    ])
      expect(
        (await f.tools.get("inkbox_send_whatsapp").execute("call-a", p))
          .isError,
      ).toBe(true);
    f.identity.getWhatsAppStatus.mockResolvedValue({
      enabled: false,
      status: "access_required",
    });
    expect(
      (
        await f.tools
          .get("inkbox_send_whatsapp")
          .execute("call-a", { to: "+15555550111", text: "Hi" })
      ).isError,
    ).toBe(true);
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  });
  it("recovers with the immutable identity and WhatsApp operation without sending", async () => {
    const f = fixture();
    await f.tools
      .get("inkbox_lookup_whatsapp_send")
      .execute("call-a", { idempotency_key: "original-key" });
    expect(f.lookup).toHaveBeenCalledWith({
      senderKind: "whatsapp_identity",
      senderId: "identity-a",
      operation: "whatsapp.send",
      idempotencyKey: "original-key",
    });
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  });
});
