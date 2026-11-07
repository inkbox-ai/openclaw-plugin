import { describe, it, expect, vi } from "vitest";
import { renderWhatsAppMentions, whatsappControlText, validWhatsAppGroup } from "../../src/whatsapp-groups.js";
import { companionWakes, whatsappCommandText } from "../../src/inbound/reply-policy.js";

describe("WhatsApp mention presentation and attention", () => {
  it.each([false, true])("resolves only contact names in direct/group input (group=%s)", async (group) => {
    const lookup = vi.fn(async () => [{ preferredName: "Morgan", notes: "private note", memories: [{ content: "private memory" }] }]);
    const runtime: any = { getClient: async () => ({ contacts: { lookup } }) };
    const message = { is_group: group, content: "@12 @34 @56 @78 https://example.test/@12 x@12.example", mentions: [
      { text: "@12", phone_number: "+15555550123", is_agent: false },
      { text: "@34", phone_number: "+15555550100", is_agent: true },
      { text: "@56", phone_number: null, is_agent: false },
      { text: "@78", phone_number: "+15555550124", is_agent: false },
    ] };
    lookup.mockImplementation(async ({ phone }: any) => phone.endsWith("123") ? [{ preferredName: "Morgan", notes: "private note", memories: [{ content: "private memory" }] }] : []);
    const result = await renderWhatsAppMentions(runtime, message, "example");
    expect(result.text).toBe("@Morgan @example @unknown participant @+15555550124 https://example.test/@12 x@12.example");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it.each(["safe", "relaxed"] as const)("uses only current attention evidence (%s)", (mode) => {
    const config = { identity: "example", groupReplyMode: "mention" as const, companionResponseMode: mode };
    expect(companionWakes(config, { content: "@12", sender_access: "direct", agent_mentioned: true }, "whatsapp")).toBe(true);
    expect(companionWakes(config, { content: "@12", sender_access: "direct", mentions: [{ text: "@12", is_agent: true }] }, "whatsapp")).toBe(false);
    expect(companionWakes(config, { content: "@example", sender_access: "sponsored" }, "whatsapp")).toBe(mode === "relaxed");
    expect(companionWakes(config, { content: "ambient", sender_access: "direct", history: "@example", quoted: { agent_mentioned: true } }, "whatsapp")).toBe(false);
  });
  it("does not mistake another person's native token for a numeric agent handle", () => {
    const config = { identity: "12345", groupReplyMode: "mention" as const, companionResponseMode: "relaxed" as const };
    const message = { content: "@12345 question", sender_access: "direct", agent_mentioned: false,
      mentions: [{ text: "@12345", phone_number: "+15555550123", is_agent: false }] };
    expect(companionWakes(config, message, "whatsapp")).toBe(false);
    expect(companionWakes(config, { ...message, agent_mentioned: true }, "whatsapp")).toBe(true);
    expect(companionWakes(config, { ...message, content: "@12345 @agent question" }, "whatsapp")).toBe(true);
    expect(companionWakes(config, { ...message, mentions: [] }, "whatsapp")).toBe(true);
    expect(companionWakes(config, { ...message, content: "@123456 question" }, "whatsapp")).toBe(false);
  });
  it.each(["/stop", "/approve once"])("does not address native other-person tokens as control aliases (%s)", command => {
    const message = { content: `@12345 ${command}`, agent_mentioned: false,
      mentions: [{ text: "@12345", phone_number: "+15555550123", is_agent: false }] };
    expect(whatsappCommandText(message, "12345")).toBe(message.content);
    expect(whatsappCommandText({ ...message, content: command }, "12345")).toBe(command);
    expect(whatsappCommandText({ ...message, mentions: [] }, "12345")).toBe(command);
    expect(whatsappCommandText({ ...message, agent_mentioned: true, mentions: [{ ...message.mentions[0], is_agent: true }] }, "12345")).toBe(command);
  });
  it("strips only a current native self token for native controls", () => {
    const message = { content: "@12 /stop", agent_mentioned: true, mentions: [{ text: "@12", phone_number: null, is_agent: true }] };
    expect(whatsappControlText(message)).toBe("/stop");
    expect(whatsappControlText({ ...message, agent_mentioned: false })).toBe("@12 /stop");
    expect(whatsappControlText({ ...message, mentions: [{ ...message.mentions[0], is_agent: false }] })).toBe("@12 /stop");
  });
  it("requires explicit complete group shape, never interprets direct recipient lists as groups", () => {
    expect(validWhatsAppGroup({ participants: ["+15555550123", "+15555550124"] })).toBe(false);
    expect(validWhatsAppGroup({ isGroup: true, remoteNumber: null, participants: ["+15555550123"], unresolvedParticipantCount: 1 })).toBe(true);
    expect(validWhatsAppGroup({ isGroup: true, remoteNumber: "+15555550123", participants: [], unresolvedParticipantCount: 0 })).toBe(false);
  });
});
