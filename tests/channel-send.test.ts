import { beforeEach, describe, expect, it, vi } from "vitest";

const mockIdentity = vi.hoisted(() => ({
  sendEmail: vi.fn(),
  sendText: vi.fn(),
  getThread: vi.fn(),
  iterEmails: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  createInkboxRuntime: vi.fn(() => ({
    getIdentity: async () => mockIdentity,
  })),
}));

import { sendInkboxChannelText } from "../src/outbound.js";

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
    mockIdentity.getThread.mockReset();
    mockIdentity.iterEmails.mockReset().mockImplementation(() => emailMessages([]));
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
