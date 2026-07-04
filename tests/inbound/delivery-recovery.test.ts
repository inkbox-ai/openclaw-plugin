import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inkbox/sdk", () => ({
  verifyWebhook: vi.fn(() => true),
}));

vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:inkbox:direct:+15551234567",
    },
    buildEnvelope: ({ body }: { body: string }) => ({
      storePath: "memory://inkbox/test",
      body,
    }),
  })),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: "consult_agent",
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: {
    encoding: "g711_ulaw",
    sampleRateHz: 8000,
    channels: 1,
  },
  buildRealtimeVoiceAgentConsultChatMessage: vi.fn(),
  buildRealtimeVoiceAgentConsultPolicyInstructions: vi.fn(() => "Consult policy."),
  buildRealtimeVoiceAgentConsultWorkingResponse: vi.fn(),
  resolveRealtimeVoiceAgentConsultToolPolicy: vi.fn((value: any, fallback: any) => value ?? fallback),
  resolveRealtimeVoiceAgentConsultTools: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(() => {
    throw new Error("realtime voice not configured in this test");
  }),
  createRealtimeVoiceBridgeSession: vi.fn(),
}));

import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import {
  IMESSAGE_EVENT_TYPES,
  MAIL_EVENT_TYPES,
  TEXT_EVENT_TYPES,
} from "../../src/inbound/subscriptions.js";
import {
  DELIVERY_FAILURE_EVENT_TYPES,
  recordOutboundDelivery,
  resetDeliveryFailureStateForTest,
} from "../../src/delivery-failure.js";

function createRuntime() {
  const sendText = vi.fn(async () => ({ id: "txt-reply", deliveryStatus: "queued" }));
  const sendIMessage = vi.fn(async () => ({
    id: "im-reply",
    conversationId: "imconv-123",
    status: "queued",
  }));
  const sendEmail = vi.fn(async () => ({ id: "mail-reply" }));
  const sendIMessageTyping = vi.fn(async () => undefined);
  const listTextConversations = vi.fn(async () => []);
  const runtime = {
    getIdentity: vi.fn(async () => ({
      agentHandle: "smoke-agent",
      id: "identity-1",
      emailAddress: "smoke-agent@inkboxmail.com",
      mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
      sendText,
      sendIMessage,
      sendEmail,
      sendIMessageTyping,
      listTextConversations,
    })),
    getClient: vi.fn(async () => ({
      contacts: {
        lookup: vi.fn(async () => []),
      },
    })),
  };
  return { runtime, sendText, sendIMessage, sendEmail };
}

function createChannelRuntime(replyText = "Recovered reply.") {
  const deliveryResults: any[] = [];
  const dispatchReply = vi.fn(async (params: any) => {
    deliveryResults.push(await params.delivery.deliver({ text: replyText }));
  });
  return {
    inbound: {
      buildContext: vi.fn((input: any) => input),
      dispatchReply,
    },
    session: {
      recordInboundSession: vi.fn(),
    },
    reply: {
      dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
    },
    deliveryResults,
  };
}

function createBridge(params: {
  runtime: any;
  channelRuntime: any;
  logger?: { info?: any; warn?: any };
}) {
  return createInkboxSessionBridge({
    cfg: {},
    account: {
      accountId: "default",
      config: { identity: "smoke-agent" },
    } as any,
    runtime: params.runtime,
    channelRuntime: params.channelRuntime,
    logger: params.logger,
  });
}

function textDeliveryFailedEvent(params: {
  eventType?: string;
  messageId?: string | null;
  text?: string | null;
  conversationId?: string | null;
  remote?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
}): any {
  return {
    id: "evt-txt-fail-1",
    event_type: params.eventType ?? "text.delivery_failed",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: {
        id: params.messageId === undefined ? "txt-out-1" : params.messageId,
        direction: "outbound",
        local_phone_number: "+16282028580",
        remote_phone_number: params.remote === undefined ? "+15551234567" : params.remote,
        sender_phone_number: null,
        conversation_id:
          params.conversationId === undefined ? "conv-9" : params.conversationId,
        text: params.text === undefined ? "Original outbound text." : params.text,
        type: "sms",
        media: null,
        is_read: false,
        delivery_status: "delivery_failed",
        origin: "user_initiated",
        error_code: params.errorCode === undefined ? "30006" : params.errorCode,
        error_detail:
          params.errorDetail === undefined ? "Landline or unreachable carrier" : params.errorDetail,
        sent_at: "2026-07-01T00:00:00Z",
        delivered_at: null,
        failed_at: "2026-07-01T00:00:05Z",
        recipients: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:05Z",
      },
    },
  };
}

function imessageDeliveryFailedEvent(params: {
  messageId?: string;
  content?: string | null;
  conversationId?: string | null;
  remote?: string;
  errorMessage?: string | null;
} = {}): any {
  return {
    id: "evt-im-fail-1",
    event_type: "imessage.delivery_failed",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      reaction: null,
      message: {
        id: params.messageId ?? "im-out-1",
        conversation_id:
          params.conversationId === undefined ? "imconv-123" : params.conversationId,
        assignment_id: "assign-1",
        direction: "outbound",
        remote_number: params.remote ?? "+15551234567",
        content: params.content === undefined ? "Original iMessage." : params.content,
        message_type: "message",
        service: "imessage",
        send_style: null,
        media: null,
        was_downgraded: null,
        status: "error",
        error_code: null,
        error_message:
          params.errorMessage === undefined ? "Recipient unavailable" : params.errorMessage,
        error_reason: null,
        error_detail: null,
        is_read: false,
        recipients: null,
        reactions: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:05Z",
      },
    },
  };
}

function mailFailureEvent(params: {
  eventType?: "message.bounced" | "message.failed";
  messageId?: string;
  to?: string[];
  subject?: string | null;
  snippet?: string | null;
} = {}): any {
  return {
    id: "evt-mail-fail-1",
    event_type: params.eventType ?? "message.bounced",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      message: {
        id: params.messageId ?? "mail-out-1",
        mailbox_id: "mailbox-1",
        thread_id: "thread-7",
        message_id: "<mail-out-1@inkboxmail.com>",
        from_address: "smoke-agent@inkboxmail.com",
        to_addresses: params.to ?? ["dima@example.com"],
        cc_addresses: null,
        bcc_addresses: null,
        subject: params.subject === undefined ? "Launch checklist" : params.subject,
        snippet: params.snippet === undefined ? "Original email body." : params.snippet,
        direction: "outbound",
        status: params.eventType === "message.failed" ? "failed" : "bounced",
        has_attachments: false,
        created_at: "2026-07-01T00:00:00Z",
      },
      contacts: [],
      agent_identities: [],
    },
  };
}

function inboundTextEvent(params: { conversationId?: string; remote?: string } = {}): any {
  return {
    id: "evt-txt-in-1",
    event_type: "text.received",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: {
        id: "txt-in-1",
        direction: "inbound",
        local_phone_number: "+16282028580",
        remote_phone_number: params.remote ?? "+15551234567",
        sender_phone_number: params.remote ?? "+15551234567",
        conversation_id: params.conversationId ?? "conv-9",
        text: "Hi, can you text me the details?",
        type: "sms",
        media: null,
        is_read: false,
        delivery_status: null,
        origin: "user_initiated",
        error_code: null,
        error_detail: null,
        sent_at: null,
        delivered_at: null,
        failed_at: null,
        recipients: null,
        created_at: "2026-07-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
      },
    },
  };
}

describe("failed outbound delivery recovery", () => {
  beforeEach(() => {
    resetDeliveryFailureStateForTest();
    vi.mocked(resolveInboundRouteEnvelopeBuilderWithRuntime).mockClear();
  });

  it("subscribes to every hard failure event on its channel", () => {
    expect(TEXT_EVENT_TYPES).toContain("text.delivery_failed");
    expect(IMESSAGE_EVENT_TYPES).toContain("imessage.delivery_failed");
    expect(MAIL_EVENT_TYPES).toContain("message.bounced");
    expect(MAIL_EVENT_TYPES).toContain("message.failed");
    // delivery_unconfirmed is telemetry: subscribed, but never a recovery
    // trigger.
    expect(DELIVERY_FAILURE_EVENT_TYPES).not.toContain("text.delivery_unconfirmed");
  });

  it("wakes the agent for an SMS delivery failure and replies on the same conversation", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("Shorter retry text.");
    const bridge = createBridge({ runtime, channelRuntime });

    await bridge.handlers.onText?.(textDeliveryFailedEvent({}));

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.extra.InkboxMode).toBe("sms");
    expect(run.ctxPayload.reply.to).toBe("sms:conv-9");
    const body = run.ctxPayload.message.bodyForAgent;
    expect(body).toContain("[inkbox:delivery_failure channel=sms event=text.delivery_failed");
    expect(body).toContain("NOT delivered");
    expect(body).toContain("Landline or unreachable carrier");
    expect(body).toContain("Original outbound text.");
    expect(body).toContain("[SILENT]");
    // The recovery reply is delivered back into the failed conversation.
    expect(sendText).toHaveBeenCalledWith({
      conversationId: "conv-9",
      text: "Shorter retry text.",
    });
  });

  it("wakes the agent for an iMessage delivery failure and replies on the same conversation", async () => {
    const { runtime, sendIMessage } = createRuntime();
    const channelRuntime = createChannelRuntime("Retry over iMessage.");
    const bridge = createBridge({ runtime, channelRuntime });

    await bridge.handlers.onIMessage?.(imessageDeliveryFailedEvent());

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.extra.InkboxMode).toBe("imessage");
    expect(run.ctxPayload.reply.to).toBe("imessage:imconv-123");
    const body = run.ctxPayload.message.bodyForAgent;
    expect(body).toContain("channel=imessage event=imessage.delivery_failed");
    expect(body).toContain("Recipient unavailable");
    expect(body).toContain("Original iMessage.");
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      text: "Retry over iMessage.",
    });
  });

  it.each(["message.bounced", "message.failed"] as const)(
    "wakes the agent for %s and replies on the same email thread",
    async (eventType) => {
      const { runtime, sendEmail } = createRuntime();
      const channelRuntime = createChannelRuntime("Resending without the attachment link.");
      const bridge = createBridge({ runtime, channelRuntime });

      await bridge.handlers.onMail?.(mailFailureEvent({ eventType }));

      expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
      const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
      expect(run.ctxPayload.extra.InkboxMode).toBe("email");
      expect(run.ctxPayload.reply.messageThreadId).toBe("email:thread-7");
      const body = run.ctxPayload.message.bodyForAgent;
      expect(body).toContain(`event=${eventType}`);
      expect(body).toContain("Original email body.");
      expect(sendEmail).toHaveBeenCalledWith({
        to: ["dima@example.com"],
        subject: "Re: Launch checklist",
        bodyText: "Resending without the attachment link.",
        inReplyToMessageId: "<mail-out-1@inkboxmail.com>",
      });
    },
  );

  it("does not wake the agent for text.delivery_unconfirmed", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge({ runtime, channelRuntime, logger });

    await bridge.handlers.onText?.(
      textDeliveryFailedEvent({ eventType: "text.delivery_unconfirmed" }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("text lifecycle event: text.delivery_unconfirmed"),
    );
  });

  it("ignores duplicate failure webhooks for the same message", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge({ runtime, channelRuntime, logger });

    await bridge.handlers.onText?.(textDeliveryFailedEvent({}));
    await bridge.handlers.onText?.(textDeliveryFailedEvent({}));

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("duplicate delivery-failure webhook ignored"),
    );
  });

  it("dedups by payload hash when the failure carries no message id", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createBridge({ runtime, channelRuntime });

    const event = textDeliveryFailedEvent({ messageId: null });
    await bridge.handlers.onText?.(event);
    await bridge.handlers.onText?.(event);

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });

  it("correlates a sparse failure webhook to the original send and thread via outbound context", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("Trying that message again.");
    const bridge = createBridge({ runtime, channelRuntime });

    // A normal inbound turn replies into conv-9; deliverReply records the
    // outbound context under the send's message id ("txt-reply").
    await bridge.handlers.onText?.(inboundTextEvent({ conversationId: "conv-9" }));
    expect(sendText).toHaveBeenCalledTimes(1);
    const inboundRoutePeer = vi.mocked(resolveInboundRouteEnvelopeBuilderWithRuntime)
      .mock.calls.at(-1)![0].peer;

    // The failure webhook arrives sparse: it names the failed message id but
    // carries no text, conversation, or recipient.
    await bridge.handlers.onText?.(
      textDeliveryFailedEvent({
        messageId: "txt-reply",
        text: null,
        conversationId: null,
        remote: null,
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    // Failed body recovered from the recorded outbound context (the fake
    // channel runtime replies with the same text on every turn, so the first
    // turn's reply is what was recorded under "txt-reply").
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      'The message that failed:\n"""\nTrying that message again.\n"""',
    );
    expect(run.ctxPayload.reply.to).toBe("sms:conv-9");
    // Routed to the same session peer as the original conversation.
    const recoveryRoutePeer = vi.mocked(resolveInboundRouteEnvelopeBuilderWithRuntime)
      .mock.calls.at(-1)![0].peer;
    expect(recoveryRoutePeer).toEqual(inboundRoutePeer);
    // And the retry goes back out on the recorded conversation.
    expect(sendText).toHaveBeenLastCalledWith({
      conversationId: "conv-9",
      text: "Trying that message again.",
    });
  });

  it("suppresses visible delivery when the agent replies exactly [SILENT]", async () => {
    const { runtime, sendText, sendIMessage, sendEmail } = createRuntime();
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createBridge({ runtime, channelRuntime });

    await bridge.handlers.onText?.(textDeliveryFailedEvent({}));

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendIMessage).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not wake the agent again when a recovery send itself fails", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("Retry text.");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge({ runtime, channelRuntime, logger });

    // First failure wakes the agent; its retry is sent as "txt-reply" and
    // recorded as a recovery send.
    await bridge.handlers.onText?.(textDeliveryFailedEvent({ messageId: "txt-out-1" }));
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledTimes(1);

    // The retry fails too — the agent must not be woken a second time.
    await bridge.handlers.onText?.(textDeliveryFailedEvent({ messageId: "txt-reply" }));
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not waking the agent again"),
    );
  });

  it("caps recovery turns per contact so a dead channel cannot loop the agent", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("[SILENT]");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge({ runtime, channelRuntime, logger });

    for (let i = 1; i <= 5; i += 1) {
      await bridge.handlers.onText?.(
        textDeliveryFailedEvent({ messageId: `txt-out-${i}` }),
      );
    }

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("recovery cap reached"),
    );
  });

  it("logs and does not wake when a failure cannot be correlated to any conversation", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge({ runtime, channelRuntime, logger });

    await bridge.handlers.onText?.(
      textDeliveryFailedEvent({
        messageId: "txt-unknown",
        text: null,
        conversationId: null,
        remote: null,
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("not correlated to a conversation"),
    );
  });
});
