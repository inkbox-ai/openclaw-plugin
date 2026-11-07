import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { whatsappDestinationEvidence } from "../../src/whatsapp.js";
import { validWhatsAppGroup, renderWhatsAppReplyContext } from "../../src/whatsapp-groups.js";

afterEach(() => vi.unstubAllGlobals());
describe("installed WhatsApp SDK group wire contract", () => {
  it("preserves group metadata with the required published SDK", async () => {
    const id = "00000000-0000-4000-8000-000000000001", owner = "11111111-1111-4111-8111-111111111111";
    const raw = { id, agent_identity_id: owner, is_group: true, group_name: "Team", local_number: "+15555550100", remote_number: null,
      participants: ["+15555550123", "+15555550124"], unresolved_participant_count: 0,
      created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
    const fetch = vi.fn(async () => new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const sdk = new Inkbox({ apiKey: "synthetic-contract-only", baseUrl: "https://example.test" });
    const conversation = await sdk.whatsapp.getConversation(id, { agentIdentityId: owner });
    expect(validWhatsAppGroup(conversation)).toBe(true);
    expect(conversation).toMatchObject({ isGroup: true, groupName: "Team", remoteNumber: null, unresolvedParticipantCount: 0 });
    expect(whatsappDestinationEvidence(conversation, owner, id)).toEqual({ identityId: owner, conversationId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
    const activation = "00000000-0000-4000-8000-000000000002";
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ scope_id: "00000000-0000-4000-8000-000000000003", activation_id: activation,
      channel: "whatsapp", conversation_id: id, items: [], history_complete: true, next_cursor: null,
      reply_context: { channel: "whatsapp", conversation_id: id } }), { headers: { "content-type": "application/json" } }));
    const proof = await sdk.companion.activationMessages("example", activation, { limit: 1 });
    expect(proof).toMatchObject({ activationId: activation, channel: "whatsapp", conversationId: id, replyContext: { channel: "whatsapp", conversationId: id } });
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockImplementationOnce(async () => new Response(JSON.stringify({ ...raw, id: "quoted", conversation_id: id,
      direction: "outbound", content: "@123 earlier proposal", mentions: [{ text: "@123", phone_number: null, is_agent: true }],
      media: [{ id: "media", filename: "photo.png", content_type: "image/png", url: "https://example.test/private" }], recipients: [], is_blocked: false }),
      { headers: { "content-type": "application/json" } }));
    const runtime: any = { getIdentity: async () => ({ id: owner, getWhatsAppMessage: (messageId: string) => sdk.whatsapp.get(messageId, { agentIdentityId: owner }) }) };
    const quote = await renderWhatsAppReplyContext(runtime, { id: "current", conversation_id: id, reply_to_message_id: "quoted" }, "example", () => false);
    expect(quote).toContain('"text":"@example earlier proposal"');
    expect(quote).toContain('"content_type":"image/png"'); expect(quote).not.toContain("https://");
    expect(fetch).toHaveBeenCalledTimes(3);

  });
  it("retains the actual SDK timeout error as a temporary optional quote failure", async () => {
    const owner = "11111111-1111-4111-8111-111111111111";
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
    })));
    const sdk = new Inkbox({ apiKey: "synthetic-contract-only", baseUrl: "https://example.test", timeoutMs: 1 });
    let caught: unknown;
    const runtime: any = { getIdentity: async () => ({ id: owner, getWhatsAppMessage: async (id: string) => {
      try { return await sdk.whatsapp.get(id, { agentIdentityId: owner }); } catch (error) { caught = error; throw error; }
    } }) };
    const quote = await renderWhatsAppReplyContext(runtime, { id: "current", conversation_id: "conversation", reply_to_message_id: "parent" }, "example",
      error => error instanceof Error && error.name === "AbortError");
    expect(caught).toBeInstanceOf(DOMException);
    expect(quote).toContain('"status":"temporarily_unavailable"'); expect(quote).toContain('"reply_to_message_id":"parent"');
  });

});
