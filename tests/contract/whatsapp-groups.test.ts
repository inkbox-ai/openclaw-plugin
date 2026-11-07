import { Inkbox } from "@inkbox/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isUnsupportedWhatsAppShape, whatsappDestinationEvidence } from "../../src/whatsapp.js";
import { validWhatsAppGroup } from "../../src/whatsapp-groups.js";

afterEach(() => vi.unstubAllGlobals());
describe("installed WhatsApp SDK group wire contract", () => {
  it("preserves group metadata with a compatible SDK and fails closed at the published direct-message floor", async () => {
    const id = "00000000-0000-4000-8000-000000000001", owner = "11111111-1111-4111-8111-111111111111";
    const raw = { id, agent_identity_id: owner, is_group: true, group_name: "Team", local_number: "+15555550100", remote_number: null,
      participants: ["+15555550123", "+15555550124"], unresolved_participant_count: 0,
      created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
    const fetch = vi.fn(async () => new Response(JSON.stringify(raw), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const sdk = new Inkbox({ apiKey: "synthetic-contract-only", baseUrl: "https://example.test" });
    const conversation = await sdk.whatsapp.getConversation(id, { agentIdentityId: owner });
    if (!("isGroup" in conversation)) {
      expect(isUnsupportedWhatsAppShape(conversation)).toBe(true);
      expect(() => whatsappDestinationEvidence(conversation, owner, id)).toThrow();
      return;
    }
    expect(validWhatsAppGroup(conversation)).toBe(true);
    expect(conversation).toMatchObject({ isGroup: true, groupName: "Team", remoteNumber: null, unresolvedParticipantCount: 0 });
    expect(whatsappDestinationEvidence(conversation, owner, id)).toEqual({ identityId: owner, conversationId: id });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
