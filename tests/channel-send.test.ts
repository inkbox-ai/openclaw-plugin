import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIdentity = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendText: vi.fn(),
  sendIMessage: vi.fn(),
  getThread: vi.fn(),
  iterEmails: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  createInkboxRuntime: vi.fn(() => ({
    getIdentity: async () => mockIdentity,
  })),
}));

import { sendInkboxChannelText } from "../src/outbound.js";
import { IMESSAGE_MAX_TEXT_CHARS, SMS_MAX_TEXT_CHARS } from "../src/message-limits.js";

const cfg = {
  channels: {
    inkbox: {
      apiKey: "ApiKey_test",
      identity: "agent-test",
    },
  },
};

async function* emailMessages(messages: any[]) {
  for (const message of messages) {
    yield message;
  }
}

describe("sendInkboxChannelText", () => {
  beforeEach(() => {
    mockIdentity.sendEmail.mockReset().mockResolvedValue({ id: "email-1" });
    mockIdentity.sendText.mockReset().mockResolvedValue({ id: "sms-1" });
    mockIdentity.sendIMessage.mockReset().mockResolvedValue({ id: "im-1" });
    mockIdentity.getThread.mockReset();
    mockIdentity.iterEmails.mockReset().mockImplementation(() => emailMessages([]));
  });

  it("sends iMessage conversation targets through sendIMessage", async () => {
    const result = await sendInkboxChannelText({
      cfg,
      to: "imessage:550e8400-e29b-41d4-a716-446655440000",
      text: "reply body",
    });

    expect(mockIdentity.sendIMessage).toHaveBeenCalledWith({
      conversationId: "550e8400-e29b-41d4-a716-446655440000",
      text: "reply body",
    });
    expect(mockIdentity.sendText).not.toHaveBeenCalled();
    expect(result.messageId).toBe("im-1");
  });

  it("sends explicit iMessage number targets through sendIMessage", async () => {
    await sendInkboxChannelText({
      cfg,
      to: "imessage:+14155550123",
      text: "hi there",
    });

    expect(mockIdentity.sendIMessage).toHaveBeenCalledWith({
      to: "+14155550123",
      text: "hi there",
    });
  });

  it("rejects over-limit iMessage text before sending", async () => {
    await expect(
      sendInkboxChannelText({
        cfg,
        to: "imessage:550e8400-e29b-41d4-a716-446655440000",
        text: "x".repeat(IMESSAGE_MAX_TEXT_CHARS + 1),
      }),
    ).rejects.toThrow("iMessage text is 18996 characters");

    expect(mockIdentity.sendIMessage).not.toHaveBeenCalled();
    expect(mockIdentity.sendText).not.toHaveBeenCalled();
  });

  it("rejects over-limit SMS text before sending", async () => {
    await expect(
      sendInkboxChannelText({
        cfg,
        to: "+14155550123",
        text: "x".repeat(SMS_MAX_TEXT_CHARS + 1),
      }),
    ).rejects.toThrow("SMS text is 1601 characters");

    expect(mockIdentity.sendText).not.toHaveBeenCalled();
    expect(mockIdentity.sendIMessage).not.toHaveBeenCalled();
  });

  it("preserves the Inkbox email thread subject for generic message replies", async () => {
    mockIdentity.getThread.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440000",
      subject: "Hello",
      messages: [],
    });

    await sendInkboxChannelText({
      cfg,
      to: "dima@example.com",
      text: "reply body",
      threadId: "email:550e8400-e29b-41d4-a716-446655440000",
      replyToId: "<original@example.com>",
    });

    expect(mockIdentity.getThread).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(mockIdentity.sendEmail).toHaveBeenCalledWith({
      to: ["dima@example.com"],
      subject: "Re: Hello",
      bodyText: "reply body",
      inReplyToMessageId: "<original@example.com>",
    });
  });

  it("recovers the email subject from replyToId when threadId is not forwarded", async () => {
    mockIdentity.iterEmails.mockImplementation(() =>
      emailMessages([
        {
          id: "message-1",
          messageId: "<original@example.com>",
          subject: "First note",
          threadId: "550e8400-e29b-41d4-a716-446655440000",
        },
      ]),
    );

    await sendInkboxChannelText({
      cfg,
      to: "dima@example.com",
      text: "reply body",
      replyToId: "<original@example.com>",
    });

    expect(mockIdentity.sendEmail).toHaveBeenCalledWith({
      to: ["dima@example.com"],
      subject: "Re: First note",
      bodyText: "reply body",
      inReplyToMessageId: "<original@example.com>",
    });
  });
});

describe("WhatsApp channel adapter and session routes", () => {
  const groupA = "550e8400-e29b-41d4-a716-446655440001";
  const groupB = "550e8400-e29b-41d4-a716-446655440002";
  const dm = "550e8400-e29b-41d4-a716-446655440003";
  const quote = "550e8400-e29b-41d4-a716-446655440004";
  const identity = mockIdentity as any;
  beforeEach(() => {
    identity.id = "identity-a";
    identity.getWhatsAppStatus = vi.fn(async () => ({ enabled: true, status: "ready" }));
    identity.getWhatsAppConversation = vi.fn(async (id: string) => ({ agentIdentityId: identity.id, isGroup: id !== dm, participants: ["+15555550123"], unresolvedParticipantCount: 0 }));
    identity.sendWhatsApp = vi.fn(async () => ({ id: "sent-message" }));
  });
  it("forwards a keyed channel quote unchanged", async () => {
    const { inkboxPlugin } = await import("../src/channel.js");
    const result = await sendInkboxChannelText({ cfg, to: `whatsapp:${groupA}`, text: "Answer", replyToId: quote, idempotencyKey: "quoted-attempt" });
    expect(identity.sendWhatsApp).toHaveBeenCalledWith(expect.objectContaining({ conversationId: groupA, replyToMessageId: quote }));
    expect(result.messageId).toBe("sent-message");
  });
  it("never replaces an unavailable adapter quote with a plain send", async () => {
    const { inkboxPlugin } = await import("../src/channel.js");
    identity.sendWhatsApp.mockRejectedValueOnce(new Error("whatsapp_quote_unavailable"));
    await expect(sendInkboxChannelText({ cfg, to: `whatsapp:${groupA}`, text: "Answer", replyToId: quote, idempotencyKey: "quoted-attempt" })).rejects.toThrow("whatsapp_quote_unavailable");
    expect(identity.sendWhatsApp).toHaveBeenCalledOnce();
    expect(identity.sendWhatsApp.mock.calls[0][0].replyToMessageId).toBe(quote);
  });
  it.each([{ to: "whatsapp:+15555550123", replyToId: quote }, { to: `whatsapp:${dm}`, replyToId: "not-a-message-id" }])("rejects unsupported quoted addressing before sending ($to)", async (target) => {
    await expect(sendInkboxChannelText({ cfg, ...target, text: "Answer" })).rejects.toThrow("quoted replies require");
    expect(identity.sendWhatsApp).not.toHaveBeenCalled();
  });
  it("resolves two owned groups separately from a DM under main DM scope", async () => {
    const { inkboxPlugin } = await import("../src/channel.js");
    const messaging = inkboxPlugin.messaging!;
    const config = { ...cfg, session: { dmScope: "main" } };
    const routes = [];
    for (const id of [groupA, groupB, dm]) {
      const to = `whatsapp:${id}`;
      const route = await messaging.resolveOutboundSessionRoute!({ cfg: config as any, agentId: "main", target: to } as any);
      expect(route?.chatType).toBe(id === dm ? "direct" : "group");
      expect(messaging.inferTargetChatType!({ to })).toBeUndefined();
      const target = await messaging.targetResolver!.resolveTarget!({ cfg: config as any, input: to, normalized: to });
      expect(target?.kind).toBe(id === dm ? "user" : "group");
      routes.push(route!.sessionKey);
    }
    expect(new Set(routes).size).toBe(3);
    expect(routes[2]).toBe("agent:main:main");
  });
  it("rejects foreign conversation routing", async () => {
    const { inkboxPlugin } = await import("../src/channel.js");
    identity.getWhatsAppConversation.mockResolvedValue({ agentIdentityId: "another-identity", isGroup: true });
    await expect(Promise.resolve().then(() => inkboxPlugin.messaging!.resolveOutboundSessionRoute!({ cfg, agentId: "main", target: `whatsapp:${groupA}` } as any))).rejects.toThrow("owned WhatsApp conversation");
  });
});

it.each([undefined, "550e8400-e29b-41d4-a716-446655440004"])("requires logical identity for generic host WhatsApp sends, independent of quote %s", async (replyToId) => {
  const { inkboxPlugin } = await import("../src/channel.js");
  const identity = mockIdentity as any;
  identity.sendWhatsApp = vi.fn();
  const ctx = { cfg, to: "whatsapp:550e8400-e29b-41d4-a716-446655440001", text: "Same reply", replyToId };
  for (let retry = 0; retry < 2; retry++) await expect(inkboxPlugin.message!.send!.text!(ctx as any)).rejects.toThrow("stable logical-send key");
  expect(identity.sendWhatsApp).not.toHaveBeenCalled();
});

it("preserves explicit channel retry keys and unquoted phone bodies without content deduplication", async () => {
  const identity = mockIdentity as any;
  identity.getWhatsAppStatus = vi.fn(async () => ({ enabled: true, status: "ready" }));
  identity.sendWhatsApp = vi.fn().mockRejectedValueOnce(new TypeError("response lost")).mockResolvedValue({ id: "sent" });
  const params = { cfg, to: "whatsapp:+15555550123", text: "Hello", idempotencyKey: "stable-attempt" };
  await expect(sendInkboxChannelText(params)).rejects.toThrow("response lost");
  await sendInkboxChannelText(params);
  await sendInkboxChannelText({ ...params, idempotencyKey: "distinct-attempt" });
  const requests = identity.sendWhatsApp.mock.calls.map(([request]: any) => request);
  expect(requests[0]).toEqual(requests[1]);
  expect(requests[0]).toEqual({ to: "+15555550123", text: "Hello", idempotencyKey: "stable-attempt" });
  expect(requests[2].idempotencyKey).toBe("distinct-attempt");
});
