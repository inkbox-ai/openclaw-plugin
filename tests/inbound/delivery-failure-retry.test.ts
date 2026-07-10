// Outbound delivery-failure feedback loop — session routing.
//
// The session-facing half of the loop: an undelivered outbound message (async
// lifecycle webhook or a synchronous send rejection) wakes the agent in the
// failed conversation's own session/thread, capped at
// OUTBOUND_FAILURE_MAX_ATTEMPTS sends per reply, deduped per failed message,
// with [SILENT] still suppressing the visible reply. Budget math + prompt text
// are covered in tests/delivery-failure.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";

vi.mock("@inkbox/sdk", async (importActual) => {
  const actual = await importActual<typeof import("@inkbox/sdk")>();
  return { ...actual, verifyWebhook: vi.fn(() => true) };
});

vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
    route: { agentId: "main", accountId: "default", sessionKey: "agent:main:inkbox:direct:+15551234567" },
    buildEnvelope: ({ body }: { body: string }) => ({ storePath: "memory://inkbox/test", body }),
  })),
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", () => ({
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: "consult_agent",
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ: { encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 },
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

import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { IMESSAGE_EVENT_TYPES, MAIL_EVENT_TYPES, TEXT_EVENT_TYPES } from "../../src/inbound/subscriptions.js";
import {
  DELIVERY_FAILURE_EVENT_TYPES,
  OUTBOUND_FAILURE_MAX_ATTEMPTS as MAX,
  resetDeliveryFailureStateForTest,
} from "../../src/delivery-failure.js";

function createRuntime(opts: { sendText?: any } = {}) {
  const sendText = opts.sendText ?? vi.fn(async () => ({ id: "txt-reply", deliveryStatus: "queued" }));
  const sendIMessage = vi.fn(async () => ({ id: "im-reply", conversationId: "imconv-123", status: "queued" }));
  const sendEmail = vi.fn(async () => ({ id: "mail-reply" }));
  const runtime = {
    getIdentity: vi.fn(async () => ({
      agentHandle: "smoke-agent",
      id: "identity-1",
      emailAddress: "smoke-agent@inkboxmail.com",
      mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
      sendText,
      sendIMessage,
      sendEmail,
      sendIMessageTyping: vi.fn(async () => undefined),
      listTextConversations: vi.fn(async () => []),
    })),
    getClient: vi.fn(async () => ({ contacts: { lookup: vi.fn(async () => []) } })),
  };
  return { runtime, sendText, sendIMessage, sendEmail };
}

// dispatchReply delivers `replyText`; a function lets a test vary the reply
// per turn (e.g. a recovery reply that differs from the original).
function createChannelRuntime(replyText: string | ((call: number) => string) = "Recovered reply.") {
  let calls = 0;
  const dispatchReply = vi.fn(async (params: any) => {
    const text = typeof replyText === "function" ? replyText(calls) : replyText;
    calls += 1;
    await params.delivery.deliver({ text });
  });
  return {
    inbound: { buildContext: vi.fn((input: any) => input), dispatchReply },
    session: { recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  };
}

function createBridge(runtime: any, channelRuntime: any, logger?: any) {
  return createInkboxSessionBridge({
    cfg: {},
    account: { accountId: "default", config: { identity: "smoke-agent" } } as any,
    runtime,
    channelRuntime,
    logger,
  });
}

function textFailure(over: Partial<{ messageId: string | null; text: string | null; conversationId: string | null; remote: string | null; eventType: string; direction: string }> = {}): any {
  return {
    id: "evt-txt-fail",
    event_type: over.eventType ?? "text.delivery_failed",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: {
        id: over.messageId === undefined ? "txt-out-1" : over.messageId,
        direction: over.direction ?? "outbound",
        local_phone_number: "+16282028580",
        remote_phone_number: over.remote === undefined ? "+15551234567" : over.remote,
        conversation_id: over.conversationId === undefined ? "conv-9" : over.conversationId,
        text: over.text === undefined ? "Sorry Kim — the site isn't built yet." : over.text,
        type: "sms",
        delivery_status: "delivery_failed",
        error_code: "40002",
        error_detail: "The message was flagged by a SPAM filter and was not delivered.",
        recipients: null,
        created_at: "2026-07-01T00:00:00Z",
      },
    },
  };
}

function imessageFailure(): any {
  return {
    id: "evt-im-fail",
    event_type: "imessage.delivery_failed",
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      reaction: null,
      message: {
        id: "im-out-1",
        conversation_id: "imconv-123",
        direction: "outbound",
        remote_number: "+15551234567",
        content: "See you at 5!",
        status: "error",
        error_code: "OPTED_OUT",
        error_message: "Recipient has opted out.",
        recipients: null,
      },
    },
  };
}

function mailFailure(eventType: "message.bounced" | "message.failed" = "message.bounced"): any {
  return {
    id: "evt-mail-fail",
    event_type: eventType,
    timestamp: "2026-07-01T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      message: {
        id: "mail-out-1",
        thread_id: "thread-7",
        message_id: "<mail-out-1@inkboxmail.com>",
        from_address: "smoke-agent@inkboxmail.com",
        to_addresses: ["kim@example.com"],
        subject: "Launch checklist",
        snippet: "Original email body.",
        direction: "outbound",
        status: eventType === "message.failed" ? "failed" : "bounced",
      },
    },
  };
}

function inboundText(conversationId = "conv-9"): any {
  return {
    id: "evt-txt-in",
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
        remote_phone_number: "+15551234567",
        sender_phone_number: "+15551234567",
        conversation_id: conversationId,
        text: "Any update on the site?",
        type: "sms",
        media: null,
        delivery_status: null,
        created_at: "2026-07-01T00:00:00Z",
      },
    },
  };
}

function lastBody(channelRuntime: any): string {
  const calls = channelRuntime.inbound.dispatchReply.mock.calls;
  return calls[calls.length - 1][0].ctxPayload.message.bodyForAgent;
}

beforeEach(() => {
  resetDeliveryFailureStateForTest();
});

describe("outbound delivery-failure recovery — session routing", () => {
  it("subscribes to every hard failure event on its channel", () => {
    expect(TEXT_EVENT_TYPES).toContain("text.delivery_failed");
    expect(IMESSAGE_EVENT_TYPES).toContain("imessage.delivery_failed");
    expect(MAIL_EVENT_TYPES).toContain("message.bounced");
    expect(MAIL_EVENT_TYPES).toContain("message.failed");
    expect(DELIVERY_FAILURE_EVENT_TYPES).not.toContain("text.delivery_unconfirmed");
  });

  it("wakes the agent for an SMS carrier failure and resends on the conversation", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("Shorter retry text.");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(textFailure());

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.extra.InkboxMode).toBe("sms");
    expect(run.ctxPayload.reply.to).toBe("sms:conv-9");
    const body = run.ctxPayload.message.bodyForAgent;
    expect(body).toContain("[inkbox:delivery_failure channel=sms stage=delivery_failed");
    expect(body).toContain(`attempt=1/${MAX}`);
    expect(body).toContain("[40002]");
    expect(body).toContain("flagged by a SPAM filter");
    expect(body).toContain("Sorry Kim — the site isn't built yet.");
    expect(body).toContain("[SILENT]");
    expect(sendText).toHaveBeenCalledWith({ conversationId: "conv-9", text: "Shorter retry text." });
  });

  it("wakes the agent for an iMessage delivery failure on the same conversation", async () => {
    const { runtime, sendIMessage } = createRuntime();
    const channelRuntime = createChannelRuntime("Retry over iMessage.");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onIMessage?.(imessageFailure());

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.reply.to).toBe("imessage:imconv-123");
    const body = run.ctxPayload.message.bodyForAgent;
    expect(body).toContain("channel=imessage stage=delivery_failed");
    expect(body).toContain("[OPTED_OUT]");
    expect(body).toContain("See you at 5!");
    expect(sendIMessage).toHaveBeenCalledWith({ conversationId: "imconv-123", text: "Retry over iMessage." });
  });

  it.each(["message.bounced", "message.failed"] as const)(
    "wakes the agent for %s and resends on the same email thread",
    async (eventType) => {
      const { runtime, sendEmail } = createRuntime();
      const channelRuntime = createChannelRuntime("Resending to a corrected address.");
      const bridge = createBridge(runtime, channelRuntime);

      await bridge.handlers.onMail?.(mailFailure(eventType));

      expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
      const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
      expect(run.ctxPayload.extra.InkboxMode).toBe("email");
      expect(run.ctxPayload.reply.messageThreadId).toBe("email:thread-7");
      const body = run.ctxPayload.message.bodyForAgent;
      expect(body).toContain(`channel=email stage=${eventType === "message.bounced" ? "bounced" : "delivery_failed"}`);
      expect(body).toContain("Original email body.");
      expect(sendEmail).toHaveBeenCalledWith({
        to: ["kim@example.com"],
        subject: "Re: Launch checklist",
        bodyText: "Resending to a corrected address.",
        inReplyToMessageId: "<mail-out-1@inkboxmail.com>",
      });
    },
  );

  it("does not wake the agent for text.delivery_unconfirmed", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge(runtime, channelRuntime, logger);

    await bridge.handlers.onText?.(textFailure({ eventType: "text.delivery_unconfirmed" }));

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("text lifecycle event: text.delivery_unconfirmed"));
  });

  it("never wakes on an inbound-direction failure row", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(textFailure({ direction: "inbound" }));

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
  });

  it("dedups a replayed failure webhook for the same message", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge(runtime, channelRuntime, logger);

    await bridge.handlers.onText?.(textFailure());
    await bridge.handlers.onText?.(textFailure());

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("duplicate delivery-failure webhook ignored"));
  });

  it("suppresses the visible resend when the agent replies exactly [SILENT]", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(textFailure());

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(sendText).not.toHaveBeenCalled();
  });

  it("caps the shared budget so a dead conversation goes quiet after the cap", async () => {
    const { runtime } = createRuntime();
    // Silent recovery replies so the wake turns don't send anything downstream.
    const channelRuntime = createChannelRuntime("[SILENT]");
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createBridge(runtime, channelRuntime, logger);

    // Distinct message ids (dedup passes), same conversation (shared budget).
    for (let i = 1; i <= MAX + 1; i += 1) {
      await bridge.handlers.onText?.(textFailure({ messageId: `txt-out-${i}` }));
    }

    // Failures 1..MAX-1 wake; the cap silences the rest.
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(MAX - 1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("retry budget exhausted, thread goes quiet"));
  });

  it("resets the budget when a fresh inbound arrives on the conversation", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(textFailure({ messageId: "txt-out-1" }));
    await bridge.handlers.onText?.(textFailure({ messageId: "txt-out-2" }));
    // A real inbound resets the failed-send budget for this conversation…
    await bridge.handlers.onText?.(inboundText("conv-9"));
    // …so the next failure is back at attempt 1 and wakes again.
    await bridge.handlers.onText?.(textFailure({ messageId: "txt-out-3" }));

    const failureTurns = channelRuntime.inbound.dispatchReply.mock.calls.filter(
      (c: any[]) => c[0].ctxPayload.message.bodyForAgent.includes("delivery_failure"),
    );
    expect(failureTurns).toHaveLength(3);
    expect(failureTurns[2][0].ctxPayload.message.bodyForAgent).toContain(`attempt=1/${MAX}`);
  });

  it("wakes the agent when the agent's own reply is rejected at send time", async () => {
    // First send (the agent's reply) is rejected by the content policy; the
    // second (the recovery resend) succeeds.
    let call = 0;
    const sendText = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        throw new InkboxAPIError(422, {
          error: "message_blocked_spam_filter",
          rule: "emoji_overload",
          message: "Too many emojis for an SMS.",
        });
      }
      return { id: "txt-reply", deliveryStatus: "queued" };
    });
    const { runtime } = createRuntime({ sendText });
    const channelRuntime = createChannelRuntime("Here is the update.");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(inboundText("conv-9"));

    // The inbound turn + the woken recovery turn.
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    const body = lastBody(channelRuntime);
    expect(body).toContain("channel=sms stage=send_rejected");
    expect(body).toContain("message_blocked_spam_filter rule=emoji_overload");
    // The recovery resend actually went out.
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it("lets the host retry a transient send rejection instead of waking", async () => {
    const sendText = vi.fn(async () => {
      throw new InkboxAPIError(503, { error: "carrier_unavailable", message: "temporarily unavailable" });
    });
    const { runtime } = createRuntime({ sendText });
    // Only the inbound turn dispatches a reply; the transient failure must not
    // spawn a recovery turn. It rethrows unchanged so the host gateway's own
    // retry path (delivery.onError) owns it — exactly the pre-feature behavior.
    const channelRuntime = createChannelRuntime("Here is the update.");
    const bridge = createBridge(runtime, channelRuntime);

    await expect(bridge.handlers.onText?.(inboundText("conv-9"))).rejects.toThrow(
      "carrier_unavailable",
    );

    // Entered once (the inbound turn); no second, woken recovery turn.
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
  });
});
