import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindNativeSource } from "../../src/native-source.js";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
import { InkboxAPIError } from "@inkbox/sdk";
function fixture(allowed?: string[], sessionKey?: string) {
  const tools = new Map<string, any>();
  const identity: any = {
    id: "identity-a",
    whatsappEnabled: false,
    getWhatsAppStatus: vi.fn(async () => ({ enabled: true, status: "ready" })),
    getWhatsAppLimits: vi.fn(async () => ({
      agentIdentityId: "identity-a",
      limits: { "whatsapp.texts_per_agent_identity_per_24h": 1000 },
      usage: { "whatsapp.texts_per_agent_identity_per_24h": 2 },
    })),
    getWhatsAppConversation: vi.fn(async () => ({
      agentIdentityId: "identity-a",
      isGroup: false,
      participants: ["+15555550123"],
      remoteNumber: "+15555550123",
    })),
    sendWhatsApp: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000005",
      conversationId: "00000000-0000-4000-8000-000000000001",
      status: "queued",
      deliveryState: "pending",
    })),
    getWhatsAppMedia: vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000004", status: "ready" })),
    markWhatsAppRead: vi.fn(async () => ({ updatedCount: 1 })),
  };
  const lookup = vi.fn(async () => "00000000-0000-4000-8000-000000000005");
  registerWhatsAppTools(
    {
      registerTool(def: any) {
        const tool = typeof def === "function" ? def({ sessionKey }) : def;
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
  it("reads daily-only effective limits without billing-cycle fields", async () => {
    const f = fixture();
    const result = await f.tools.get("inkbox_get_whatsapp_status").execute("limits", {});
    expect(JSON.parse(result.content[0].text.replace(/^```json\n|\n```$/g, ""))).toEqual({
      enabled: true,
      status: "ready",
      limits: { "whatsapp.texts_per_agent_identity_per_24h": 1000 },
      usage: { "whatsapp.texts_per_agent_identity_per_24h": 2 },
    });
  });
  it("treats email-address policy as a curated rejection without freeing unknown outcomes", async () => {
    const rejectSend = vi.fn(async () => {});
    const release = bindNativeSource("wa-email-policy", { whatsapp: true, identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001",
      author: "+15555550123", closed: false, validate: async () => {}, beforeSend: async () => {}, afterSend: async () => {}, rejectSend });
    try {
      const f = fixture(undefined, "wa-email-policy");
      const policy = { error: "whatsapp_reply_required_for_email_addresses", quota: "whatsapp.pre_reply_email_addresses_allowed",
        limit: 0, retry_condition: "recipient_reply_or_configuration" };
      f.identity.sendWhatsApp.mockRejectedValueOnce(new InkboxAPIError(422, { ...policy, message: "private-diagnostic" }));
      const payload = { text: "Email sender@example.com", idempotencyKey: "original-email-key" };
      const first = await f.tools.get("inkbox_send_whatsapp").execute("first", payload);
      expect(first.details).toEqual({ ...policy, status_code: 422, idempotencyKey: "original-email-key", requestAccepted: false });
      expect(JSON.stringify(first)).not.toContain("private-diagnostic");
      expect(rejectSend).toHaveBeenCalledWith("first", "original-email-key", { ...policy, status_code: 422 });
      await f.tools.get("inkbox_send_whatsapp").execute("retry", payload);
      expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual(f.identity.sendWhatsApp.mock.calls[1][0]);
      for (const error of [new InkboxAPIError(429, policy), new InkboxAPIError(402, { error: "whatsapp_cycle_limit_exceeded" })]) {
        f.identity.sendWhatsApp.mockRejectedValueOnce(error);
        const unknown = await f.tools.get("inkbox_send_whatsapp").execute("unknown", payload);
        expect(unknown.details.requestAccepted).toBeUndefined();
        expect(unknown.content[0].text).not.toContain("Request not accepted");
      }
      expect(rejectSend).toHaveBeenCalledOnce();
    } finally { release(); }
  });
  it("registers all fifteen tools before approval and checks fresh readiness rather than cached flags", async () => {
    const f = fixture();
    expect(f.tools.size).toBe(15);
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
      conversationId: "00000000-0000-4000-8000-000000000001",
      text: "Brief",
      mediaIds: ["00000000-0000-4000-8000-000000000004"],
    };
    const unknown = await f.tools.get("inkbox_send_whatsapp").execute("call-a", p);
    const key = unknown.details.idempotencyKey;
    expect(unknown.content[0].text).toContain(key);
    const accepted = await f.tools.get("inkbox_send_whatsapp").execute("different-host-call", { ...p, idempotencyKey: key });
    expect(JSON.parse(accepted.content[0].text.replace(/^```json\n|\n```$/g, "")).idempotencyKey).toBe(key);
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toEqual(
      f.identity.sendWhatsApp.mock.calls[1][0],
    );
    expect(f.identity.sendWhatsApp.mock.calls[1][0].mediaIds).toEqual([
      "00000000-0000-4000-8000-000000000004",
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
  it("journals the exact source-bound recovery key before dispatch and permits an explicit different recipient", async () => {
    const beforeSend = vi.fn(async () => {});
    const release = bindNativeSource("wa-source-test", { whatsapp: true, sourceMessageId: "incoming-a", identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false,
      validate: async () => {}, beforeSend, afterSend: async () => {} });
    try {
      const f = fixture(undefined, "wa-source-test");
      const first = await f.tools.get("inkbox_send_whatsapp").execute("call-a", { text: "Reply" });
      const key = JSON.parse(first.content[0].text.replace(/^```json\n|\n```$/g, "")).idempotencyKey;
      expect(beforeSend).toHaveBeenCalledWith("call-a", { idempotencyKey: key, text: "Reply" });
      const second = await f.tools.get("inkbox_send_whatsapp").execute("call-b", { text: "Reply" });
      expect(JSON.parse(second.content[0].text.replace(/^```json\n|\n```$/g, "")).idempotencyKey).not.toBe(key);
      const explicit = await f.tools.get("inkbox_send_whatsapp").execute("call-c", { to: "+15555550124", text: "Explicit outreach" });
      expect(explicit.isError).not.toBe(true);
      expect(f.identity.sendWhatsApp.mock.calls[2][0].to).toBe("+15555550124");
      expect(beforeSend).toHaveBeenCalledTimes(3);
    } finally { release(); }
  });

  it("reports the earlier key, not a new unattempted key, when the source fence rejects a second intent", async () => {
    const release = bindNativeSource("wa-rejected-test", { whatsapp: true, sourceMessageId: "incoming-a", identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false,
      validate: async () => {}, beforeSend: async () => { throw Object.assign(new Error("Earlier send uncertain"), { idempotencyKey: "earlier-actual-key" }); }, afterSend: async () => {} });
    try {
      const f = fixture(undefined, "wa-rejected-test");
      const result = await f.tools.get("inkbox_send_whatsapp").execute("different-call", { text: "Different new intent", idempotencyKey: "not-attempted-key" });
      expect(result.isError).toBe(true); expect(result.details).toEqual({ sendAttempted: false, idempotencyKey: "earlier-actual-key" });
      expect(result.content[0].text).toContain("No new WhatsApp request");
      expect(result.content[0].text).not.toContain("not-attempted-key");
      expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it.each(["conversation", "readiness", "validation", "intent"])("does not send after source closes during %s", async (phase) => {
    let validations = 0;
    const release = bindNativeSource(`wa-closed-${phase}`, {
      whatsapp: true, sourceMessageId: "incoming-a", identityId: "identity-a",
      conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false,
      validate: async () => { if (++validations > 1 && phase === "validation") release(); },
      beforeSend: async () => { if (phase === "intent") release(); }, afterSend: async () => {},
    });
    try {
      const f = fixture(undefined, `wa-closed-${phase}`);
      if (phase === "conversation") f.identity.getWhatsAppConversation.mockImplementation(async () => {
        release();
        return { agentIdentityId: "identity-a", isGroup: false, participants: ["+15555550124"] };
      });
      if (phase === "readiness") f.identity.getWhatsAppStatus.mockImplementation(async () => {
        release(); return { enabled: true, status: "ready" };
      });
      const target = phase === "conversation" ? { conversationId: "00000000-0000-4000-8000-000000000002" }
        : phase === "intent" ? {} : { to: "+15555550124" };
      const result = await f.tools.get("inkbox_send_whatsapp").execute("call-a", { ...target, text: "Answer" });
      expect(result.isError).toBe(true);
      expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
    } finally { release(); }
  });

  it("does not upload after its final asynchronous source validation closes the turn", async () => {
    const directory = mkdtempSync(join(tmpdir(), "whatsapp-source-"));
    const filePath = join(directory, "notes.txt");
    writeFileSync(filePath, "Notes");
    let validations = 0;
    const release = bindNativeSource("wa-upload-closed", {
      whatsapp: true, identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001",
      author: "+15555550123", closed: false,
      validate: async () => { if (++validations === 2) release(); },
      beforeSend: async () => {}, afterSend: async () => {},
    });
    try {
      const f = fixture(undefined, "wa-upload-closed");
      f.identity.uploadWhatsAppMedia = vi.fn(async () => ({ id: "00000000-0000-4000-8000-000000000004" }));
      const result = await f.tools.get("inkbox_upload_whatsapp_media").execute("upload-a", { filePath });
      expect(result.isError).toBe(true);
      expect(f.identity.uploadWhatsAppMedia).not.toHaveBeenCalled();
    } finally { release(); rmSync(directory, { recursive: true, force: true }); }
  });

});


describe("WhatsApp groups, explicit quotes, and reaction receipts", () => {
  it("checks every new group recipient and rejects duplicate numbers or group identifiers", async () => {
    const f = fixture(["+15555550123", "+15555550124"]);
    const send = f.tools.get("inkbox_send_whatsapp");
    await send.execute("group", { to: ["+1 (555) 555-0123", "+15555550124"], groupName: "Team", text: "Hello", idempotencyKey: "group-key" });
    expect(f.identity.sendWhatsApp).toHaveBeenCalledWith({ to: ["+15555550123", "+15555550124"], groupName: "Team", text: "Hello", idempotencyKey: "group-key" });
    for (const to of [["+15555550123", "+15555550125"], ["+15555550123", "+1 (555)555-0123"], ["123@g.us"]]) {
      expect((await send.execute("bad", { to, text: "No" })).isError).toBe(true);
    }
    expect(f.identity.sendWhatsApp).toHaveBeenCalledOnce();
  });
  it("supports existing larger groups by ID and journals explicit quotes without inferring one", async () => {
    const beforeSend = vi.fn(async () => {});
    const release = bindNativeSource("wa-v2-group", { whatsapp: true, isGroup: true, sourceMessageId: "incoming", identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false, validate: async () => {}, beforeSend, afterSend: async () => {} });
    try {
      const f = fixture(undefined, "wa-v2-group");
      f.identity.getWhatsAppConversation.mockResolvedValue({ agentIdentityId: "identity-a", isGroup: true, participants: Array.from({length: 10}, (_,i) => `+15555550${String(120+i)}`) });
      const send = f.tools.get("inkbox_send_whatsapp");
      await send.execute("quoted", { conversationId: "00000000-0000-4000-8000-000000000001", replyToMessageId: "00000000-0000-4000-8000-000000000007", text: "Answer", idempotencyKey: "quote-key" });
      expect(beforeSend).toHaveBeenCalledWith("quoted", { text: "Answer", replyToMessageId: "00000000-0000-4000-8000-000000000007", idempotencyKey: "quote-key" });
      expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ conversationId: "00000000-0000-4000-8000-000000000001", replyToMessageId: "00000000-0000-4000-8000-000000000007" });
      await send.execute("plain", { conversationId: "00000000-0000-4000-8000-000000000001", text: "Plain", idempotencyKey: "plain-key" });
      expect(f.identity.sendWhatsApp.mock.calls[1][0]).not.toHaveProperty("replyToMessageId");
      await send.execute("author-dm", { to: "+15555550123", text: "Private", idempotencyKey: "private-key" });
      expect(f.identity.sendWhatsApp.mock.calls[2][0]).toMatchObject({ to: "+15555550123" });
      expect(f.identity.sendWhatsApp.mock.calls[2][0]).not.toHaveProperty("conversationId");
    } finally { release(); }
  });
  it("retains exact reaction key and receipt status, checks all participants, and removes the exact ID", async () => {
    const f = fixture();
    f.identity.getWhatsAppMessage = vi.fn(async () => ({ agentIdentityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001" }));
    f.identity.sendWhatsAppReaction = vi.fn().mockRejectedValueOnce(new TypeError("timeout")).mockResolvedValue({ id: "reaction-a", status: "queued", revision: 1 });
    f.identity.getWhatsAppReaction = vi.fn(async () => ({ targetMessageId: "00000000-0000-4000-8000-000000000005" }));
    f.identity.removeWhatsAppReaction = vi.fn(async () => ({ id: "reaction-a", status: "removed" }));
    const send = f.tools.get("inkbox_send_whatsapp_reaction");
    const args = { messageId: "00000000-0000-4000-8000-000000000005", reaction: "eyes", idempotencyKey: "reaction-key" };
    const failed = await send.execute("attempt", args);
    expect(failed.details.idempotencyKey).toBe("reaction-key");
    const accepted = await send.execute("retry", args);
    expect(accepted.content[0].text).toContain('"queued"');
    expect(f.identity.sendWhatsAppReaction.mock.calls[0][0]).toEqual(f.identity.sendWhatsAppReaction.mock.calls[1][0]);
    await f.tools.get("inkbox_remove_whatsapp_reaction").execute("remove", { reactionId: "reaction-a", idempotencyKey: "remove-key" });
    expect(f.identity.removeWhatsAppReaction).toHaveBeenCalledWith("reaction-a", "remove-key");
    const invalid = await send.execute("bad", { ...args, customEmoji: "👀" });
    expect(invalid.isError).toBe(true);
    expect(f.identity.sendWhatsAppReaction).toHaveBeenCalledTimes(2);
  });
});


it("fences reaction writes against blocked group peers and a source revoked during reads", async () => {
  const release = bindNativeSource("wa-reaction-fence", { whatsapp: true, isGroup: true, identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false, validate: async () => {}, beforeSend: async () => {}, afterSend: async () => {} });
  try {
    const f = fixture(["+15555550123"], "wa-reaction-fence");
    f.identity.getWhatsAppMessage = vi.fn(async () => ({ agentIdentityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001" }));
    f.identity.sendWhatsAppReaction = vi.fn();
    f.identity.getWhatsAppConversation.mockResolvedValue({ agentIdentityId: "identity-a", participants: ["+15555550123", "+15555550124"] });
    const args = { messageId: "00000000-0000-4000-8000-000000000005", reaction: "eyes", idempotencyKey: "reaction-key" }, tool = f.tools.get("inkbox_send_whatsapp_reaction");
    expect((await tool.execute("blocked-peer", args)).isError).toBe(true);
    f.identity.getWhatsAppConversation.mockImplementation(async () => { release(); return { agentIdentityId: "identity-a", participants: ["+15555550123"] }; });
    expect((await tool.execute("revoked", args)).isError).toBe(true);
    expect(f.identity.sendWhatsAppReaction).not.toHaveBeenCalled();
  } finally { release(); }
});


it.each(["", " ", "\n", null])("does not silently omit an explicit invalid quote target %j", async (replyToMessageId) => {
  const f = fixture();
  const result = await f.tools.get("inkbox_send_whatsapp").execute("invalid-quote", { conversationId: "00000000-0000-4000-8000-000000000001", replyToMessageId, text: "Never plain" });
  expect(result.isError).toBe(true); expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
});


it.each([false, true])("inherits a source quote only for its own destination (group=%s)", async (isGroup) => {
  const beforeSend = vi.fn(async () => {});
  const release = bindNativeSource("autoquote-source", { whatsapp: true, isGroup,
    sourceMessageId: "00000000-0000-4000-8000-000000000006", replyToMessageId: "00000000-0000-4000-8000-000000000006",
    identityId: "identity-a", conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123",
    closed: false, validate: async () => {}, beforeSend, afterSend: async () => {} });
  try {
    const f = fixture(undefined, "autoquote-source"), send = f.tools.get("inkbox_send_whatsapp");
    await send.execute("source", { text: "Answer" });
    expect(f.identity.sendWhatsApp.mock.calls[0][0]).toMatchObject({ conversationId: "00000000-0000-4000-8000-000000000001",
      replyToMessageId: "00000000-0000-4000-8000-000000000006" });
    await send.execute("other", { to: "+15555550124", text: "Outreach" });
    expect(f.identity.sendWhatsApp.mock.calls[1][0]).toMatchObject({ to: "+15555550124" });
    expect(f.identity.sendWhatsApp.mock.calls[1][0]).not.toHaveProperty("replyToMessageId");
    await send.execute("room", { conversationId: "00000000-0000-4000-8000-000000000003", text: "Outreach" });
    expect(f.identity.sendWhatsApp.mock.calls[2][0]).toMatchObject({ conversationId: "00000000-0000-4000-8000-000000000003" });
    expect(f.identity.sendWhatsApp.mock.calls[2][0]).not.toHaveProperty("replyToMessageId");
    await send.execute("old-key", { text: "Old send", idempotencyKey: "legacy-plain-key" });
    expect(f.identity.sendWhatsApp.mock.calls[3][0]).not.toHaveProperty("replyToMessageId");
  } finally { release(); }
});

it.each([
  { replyToMessageId: "not-a-uuid" },
  { replyToMessageId: "reaction:00000000-0000-4000-8000-000000000005:1:applied" },
  { conversationId: "not-a-uuid" },
  { conversationId: null },
  { to: "+15555550124", conversationId: "00000000-0000-4000-8000-000000000001" },
  { mediaIds: ["not-a-uuid"] },
  { mediaIds: "not-an-array" },
  { mediaIds: [null] },
  { mediaIds: null },
  { text: 123 },
  { idempotencyKey: " " },
  { idempotencyKey: "key\n" },
  { idempotencyKey: "🔑" },
  { idempotencyKey: "a".repeat(256) },
  { groupName: " " },
  { to: ["+15555550124", "+15555550125"], groupName: " " },
  { to: ["+15555550124", "+15555550125"], groupName: "x".repeat(101) },
])("preflights malformed requests before any durable intent: %j", async (invalid) => {
  const beforeSend = vi.fn(), afterSend = vi.fn();
  const release = bindNativeSource("preflight", { whatsapp: true, identityId: "identity-a",
    conversationId: "00000000-0000-4000-8000-000000000001", author: "+15555550123", closed: false,
    validate: async () => {}, beforeSend, afterSend });
  try {
    const f = fixture(undefined, "preflight");
    const result = await f.tools.get("inkbox_send_whatsapp").execute("preflight-call", { text: "Hello", ...invalid });
    expect(result.isError).toBe(true);
    expect(beforeSend).not.toHaveBeenCalled(); expect(afterSend).not.toHaveBeenCalled();
    expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  } finally { release(); }
});

it("normalizes exact logical retries while keeping identical distinct sends independent", async () => {
  const f = fixture(), send = f.tools.get("inkbox_send_whatsapp");
  f.identity.sendWhatsApp.mockRejectedValueOnce(new TypeError("response lost"));
  const params = { to: ["+1 (555) 555-0124", "+15555550123"], groupName: "Team", text: "Hello" };
  const first = await send.execute("logical-attempt-a", params);
  await send.execute("logical-attempt-a", { ...params, to: ["+15555550123", "+15555550124"] });
  await send.execute("logical-attempt-b", { ...params, to: ["+15555550123", "+15555550124"] });
  const requests = f.identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(requests).toHaveLength(3);
  expect(requests[0].to).toEqual(["+15555550123", "+15555550124"]);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0].idempotencyKey).toBe(first.details.idempotencyKey);
  expect(requests[2].idempotencyKey).not.toBe(requests[0].idempotencyKey);
});

it("requires an explicit stable key without a host logical call ID", async () => {
  const f = fixture(), send = f.tools.get("inkbox_send_whatsapp");
  const params = { to: "+15555550123", text: "Hello" };
  expect((await send.execute("", params)).isError).toBe(true);
  expect(f.identity.sendWhatsApp).not.toHaveBeenCalled();
  await send.execute("", { ...params, idempotencyKey: "explicit-attempt" });
  expect(f.identity.sendWhatsApp).toHaveBeenCalledWith({ ...params, idempotencyKey: "explicit-attempt" });
});
