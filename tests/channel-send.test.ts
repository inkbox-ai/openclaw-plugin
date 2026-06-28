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
import { IMESSAGE_MAX_TEXT_CHARS } from "../src/message-limits.js";

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
