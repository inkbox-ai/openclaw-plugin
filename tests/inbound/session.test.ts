import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realtimeMock = vi.hoisted(() => ({
  available: true,
  sessions: [] as any[],
  toolCallOnAudio: false as any,
  resolveCalls: [] as any[],
  connectError: undefined as Error | undefined,
}));

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
  buildRealtimeVoiceAgentConsultChatMessage: vi.fn((args: any) => args.question),
  buildRealtimeVoiceAgentConsultPolicyInstructions: vi.fn(() => "Consult policy."),
  buildRealtimeVoiceAgentConsultWorkingResponse: vi.fn(() => ({
    status: "working",
  })),
  resolveRealtimeVoiceAgentConsultToolPolicy: vi.fn((value: any, fallback: any) => value ?? fallback),
  resolveRealtimeVoiceAgentConsultTools: vi.fn((policy: string, customTools: any[] = []) => [
    ...(policy === "none"
      ? []
      : [
          {
            type: "function",
            name: "consult_agent",
            description: "Consult OpenClaw",
            parameters: { type: "object", properties: {}, required: [] },
          },
        ]),
    ...customTools,
  ]),
  resolveConfiguredRealtimeVoiceProvider: vi.fn((params: any) => {
    if (!realtimeMock.available) {
      throw new Error("Realtime voice provider \"openai\" is not configured");
    }
    realtimeMock.resolveCalls.push(params);
    return {
      provider: { id: "openai", label: "OpenAI" },
      providerConfig: { model: "gpt-realtime" },
    };
  }),
  createRealtimeVoiceBridgeSession: vi.fn((params: any) => {
    let toolCalled = false;
    const normalizeToolCalls = (value: any) => {
      const values = Array.isArray(value) ? value : [value === true ? "consult" : value];
      return values.map((entry: any, index: number) => {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          return {
            itemId: entry.itemId ?? `item-${index + 1}`,
            callId: entry.callId ?? `tool-${index + 1}`,
            name: entry.name,
            args: entry.args ?? {},
          };
        }
        if (entry === "post_call") {
          return {
            itemId: `item-${index + 1}`,
            callId: `tool-${index + 1}`,
            name: "register_post_call_action",
            args: {
              action: "Send a follow-up email to Dima about the launch checklist.",
              details: "Include that staging is still pending.",
            },
          };
        }
        return {
          itemId: `item-${index + 1}`,
          callId: `tool-${index + 1}`,
          name: entry === "consult" ? "consult_agent" : String(entry),
          args:
            entry === "consult"
              ? { question: "Save this as a note." }
              : {},
        };
      });
    };
    const session: any = {
      bridge: { supportsToolResultContinuation: true },
      connect: vi.fn(async () => {
        if (realtimeMock.connectError) {
          throw realtimeMock.connectError;
        }
        params.onReady?.(session);
      }),
      sendAudio: vi.fn((audio: Buffer) => {
        if (realtimeMock.toolCallOnAudio && !toolCalled) {
          toolCalled = true;
          params.onTranscript?.("user", "Please handle this request.", true);
          for (const toolCall of normalizeToolCalls(realtimeMock.toolCallOnAudio)) {
            params.onToolCall?.(toolCall, session);
          }
        }
      }),
      setMediaTimestamp: vi.fn(),
      triggerGreeting: vi.fn(() => {
        params.onTranscript?.("assistant", "Hi there.", true);
        params.audioSink.sendAudio(Buffer.from([0xff, 0xff]));
        params.onEvent?.({ type: "response.done" });
      }),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      close: vi.fn(),
    };
    realtimeMock.sessions.push({ params, session });
    return session;
  }),
}));

import {
  IMESSAGE_TYPING_MAX_MS,
  IMESSAGE_TYPING_REFRESH_MS,
  InkboxRealtimeAudioPacer,
  createIMessageTypingPulse,
  createInkboxSessionBridge,
  prewarmInkboxAgent,
} from "../../src/inbound/session.js";
import {
  decorateCallWebsocketUrlWithContext,
  registerOutboundCallContext,
} from "../../src/outbound-call-context.js";
import { IMESSAGE_MAX_TEXT_CHARS, SMS_MAX_TEXT_CHARS } from "../../src/message-limits.js";

type FakeInkboxWebSocketMessage = string | { message: string; advanceMs?: number };

class FakeInkboxWebSocket {
  readonly headers = new Map<string, string>();
  readonly url: string;
  readonly sent: string[] = [];
  readonly accept = vi.fn(async () => undefined);
  readonly send = vi.fn(async (message: string) => {
    this.sent.push(message);
  });
  readonly close = vi.fn(async () => undefined);

  constructor(
    private readonly messages: FakeInkboxWebSocketMessage[],
    url = "wss://example.com/inkbox/phone/media/ws?call_id=call-1",
  ) {
    this.url = url;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for (const entry of this.messages) {
      if (typeof entry === "string") {
        yield entry;
        continue;
      }
      if (entry.advanceMs) {
        vi.advanceTimersByTime(entry.advanceMs);
      }
      yield entry.message;
    }
  }
}

function createRuntime(options: { conversations?: any[] } = {}) {
  const sendText = vi.fn(async () => ({ id: "txt-reply", deliveryStatus: "queued" }));
  const sendIMessage = vi.fn(async () => ({
    id: "im-reply",
    conversationId: "imconv-123",
    status: "queued",
  }));
  const sendIMessageTyping = vi.fn(async () => undefined);
  const listTextConversations = vi.fn(async () => options.conversations ?? []);
  const runtime = {
    getIdentity: vi.fn(async () => ({
      agentHandle: "smoke-agent",
      id: "identity-1",
      displayName: "Smoke Agent",
      emailAddress: "smoke-agent@inkboxmail.com",
      mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
      phoneNumber: {
        id: "phone-1",
        number: "+16282028580",
        type: "local",
        smsStatus: "ready",
      },
      tunnel: { publicHost: "smoke-agent.inkboxwire.com" },
      sendText,
      sendIMessage,
      sendIMessageTyping,
      listTextConversations,
    })),
    getClient: vi.fn(async () => ({
      calls: {
        get: vi.fn(async () => ({
          remotePhoneNumber: "+15551234567",
          direction: "inbound",
        })),
      },
      contacts: {
        lookup: vi.fn(async () => []),
      },
    })),
  };
  return { runtime, sendText, sendIMessage, sendIMessageTyping, listTextConversations };
}

function createChannelRuntime(replyText = "I can hear you on the call.") {
  const deliveryResults: any[] = [];
  const dispatchReply = vi.fn(async (params: any) => {
    deliveryResults.push(await params.delivery.deliver({ text: replyText }));
  });
  return {
    inbound: {
      buildContext: vi.fn((input) => input),
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

function textWebhookEvent(params: {
  text: string;
  conversationId?: string;
  remote?: string;
  local?: string;
}): any {
  return {
    event_type: "text.received",
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: {
        id: "txt-in-1",
        direction: "inbound",
        local_phone_number: params.local ?? "+16282028580",
        remote_phone_number: params.remote ?? "+15551234567",
        sender_phone_number: params.remote ?? "+15551234567",
        conversation_id: params.conversationId,
        text: params.text,
        type: "mms",
        media: null,
        is_read: false,
        delivery_status: null,
        origin: "user_initiated",
        error_code: null,
        error_detail: null,
        sent_at: null,
        delivered_at: null,
        failed_at: null,
        created_at: "2026-05-21T00:00:00Z",
        updated_at: "2026-05-21T00:00:00Z",
      },
    },
  };
}

function imessageWebhookEvent(params: {
  content: string;
  conversationId?: string;
  remote?: string;
  direction?: string;
  eventType?: string;
}): any {
  return {
    event_type: params.eventType ?? "imessage.received",
    timestamp: "2026-06-10T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      message: {
        id: "im-in-1",
        conversation_id: params.conversationId ?? "imconv-123",
        assignment_id: "assign-1",
        direction: params.direction ?? "inbound",
        remote_number: params.remote ?? "+15551234567",
        content: params.content,
        message_type: "message",
        service: "imessage",
        send_style: null,
        media: null,
        was_downgraded: null,
        status: null,
        error_code: null,
        error_message: null,
        error_reason: null,
        error_detail: null,
        is_read: false,
        recipients: null,
        reactions: null,
        created_at: "2026-06-10T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
      },
      reaction: null,
    },
  };
}

function imessageReactionWebhookEvent(params: {
  reaction: string;
  direction?: string;
  conversationId?: string;
  remote?: string;
  customEmoji?: string;
}): any {
  return {
    event_type: "imessage.reaction_received",
    timestamp: "2026-06-10T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      message: null,
      reaction: {
        id: "react-in-1",
        conversation_id: params.conversationId ?? "imconv-123",
        assignment_id: "assign-1",
        target_message_id: "im-target-9",
        direction: params.direction ?? "inbound",
        reaction: params.reaction,
        custom_emoji: params.customEmoji ?? null,
        remote_number: params.remote ?? "+15551234567",
        part_index: 0,
        created_at: "2026-06-10T00:00:00Z",
        updated_at: "2026-06-10T00:00:00Z",
      },
    },
  };
}

function mailWebhookEvent(params: {
  from: string;
  subject?: string;
  snippet?: string;
  agentIdentities?: any[];
}): any {
  return {
    event_type: "message.received",
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      message: {
        id: "mail-in-1",
        mailbox_id: "mailbox-1",
        thread_id: "thread-1",
        message_id: "<mail-in-1@example.com>",
        from_address: params.from,
        to_addresses: ["smoke-agent@inkboxmail.com"],
        cc_addresses: null,
        bcc_addresses: null,
        subject: params.subject ?? "Loop test",
        snippet: params.snippet ?? "Please reply to yourself.",
        direction: "inbound",
        status: "received",
        has_attachments: false,
        created_at: "2026-05-21T00:00:00Z",
      },
      contacts: [],
      agent_identities: params.agentIdentities ?? [],
    },
  };
}

function parseSentTextFrames(ws: FakeInkboxWebSocket) {
  return ws.sent.map((message) => JSON.parse(message));
}

describe("createInkboxSessionBridge", () => {
  beforeEach(() => {
    realtimeMock.available = true;
    realtimeMock.sessions = [];
    realtimeMock.toolCallOnAudio = false;
    realtimeMock.resolveCalls = [];
    realtimeMock.connectError = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not burst-catch up realtime audio after an outbound under-run", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const sent: Array<{ payload: any; at: number }> = [];
    const pacer = new InkboxRealtimeAudioPacer(
      async (payload) => {
        sent.push({ payload, at: Date.now() });
      },
      () => "stream-1",
    );
    const eightTelephonyChunks = Buffer.alloc(160 * 8, 0xff);

    pacer.sendAudio(eightTelephonyChunks);
    await vi.advanceTimersByTimeAsync(200);
    const firstRunMedia = sent.filter((entry) => entry.payload.event === "media");
    expect(firstRunMedia).toHaveLength(8);

    await vi.advanceTimersByTimeAsync(1000);
    pacer.sendAudio(eightTelephonyChunks);
    await Promise.resolve();

    const mediaAfterSecondRunStarts = sent.filter((entry) => entry.payload.event === "media");
    expect(mediaAfterSecondRunStarts).toHaveLength(9);
    expect(mediaAfterSecondRunStarts[8].at).toBe(Date.now());
    pacer.close();
  });

  it("prewarms the voice agent path without delivering a visible reply", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("ready");

    await prewarmInkboxAgent({
      cfg: {},
      account: {
        accountId: "warmup-test",
        config: {
          identity: "smoke-agent",
          voiceAgentPrewarmTtlMs: 0,
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
      reason: "unit-test",
    });

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.extra.InkboxWarmup).toBe(true);
    expect(run.ctxPayload.reply.to).toBe("inkbox-warmup:warmup-test");
    expect(run.ctxPayload.message.bodyForAgent).toContain("[inkbox:warmup");
    expect(run.ctxPayload.message.bodyForAgent).toContain("inkbox_identity=smoke-agent");
    expect(run.replyOptions).toEqual(
      expect.objectContaining({
        sourceReplyDeliveryMode: "automatic",
        bootstrapContextMode: "lightweight",
        fastModeOverride: true,
        thinkingLevelOverride: "minimal",
        suppressDefaultToolProgressMessages: true,
      }),
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ignores self-originated inbound email by mailbox address", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
      logger,
    });

    await bridge.handlers.onMail?.(
      mailWebhookEvent({
        from: "Smoke Agent <smoke-agent@inkboxmail.com>",
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.getClient).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-originated mail ignored"),
    );
  });

  it("logs and ignores inbound email with an unparseable sender", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
      logger,
    });

    await bridge.handlers.onMail?.(
      mailWebhookEvent({
        from: "Unknown Sender",
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.getIdentity).not.toHaveBeenCalled();
    expect(runtime.getClient).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("missing or unparseable from_address"),
    );
  });

  it("ignores self-originated inbound email by agent identity marker", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
      logger,
    });

    await bridge.handlers.onMail?.(
      mailWebhookEvent({
        from: "alias@inkboxmail.com",
        agentIdentities: [
          {
            bucket: "from",
            address: "alias@inkboxmail.com",
            id: "identity-1",
            agent_handle: "smoke-agent",
            display_name: "Smoke Agent",
          },
        ],
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.getIdentity).not.toHaveBeenCalled();
    expect(runtime.getClient).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("self-originated mail ignored"),
    );
  });

  it("speaks greeting and agent replies over TTS, not SMS", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: { accountId: "default", config: { voiceRealtime: { enabled: false } } } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "Can you hear me?",
        is_final: true,
        turn_id: "turn-1",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledWith(
      expect.objectContaining({
        routeSessionKey: "agent:main:inkbox:call:call-1",
        replyOptions: expect.objectContaining({
          sourceReplyDeliveryMode: "automatic",
          bootstrapContextMode: "lightweight",
          fastModeOverride: true,
          thinkingLevelOverride: "minimal",
        }),
      }),
    );
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain("[inkbox:voice_call");
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain("[call_ended]");
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain("Can you hear me?");
    expect(sendText).not.toHaveBeenCalled();
    expect(bridge.activeCalls.size).toBe(0);

    const frames = parseSentTextFrames(ws);
    expect(frames.filter((frame) => frame.event === "text" && frame.delta)).toEqual([
      expect.objectContaining({
        delta: "Hi there, how can I help?",
        turn_id: "greeting",
        sequence: 1,
      }),
      expect.objectContaining({
        delta: "I can hear you on the call.",
        turn_id: "turn-1",
        sequence: 3,
      }),
    ]);
    expect(frames.filter((frame) => frame.done)).toEqual([
      expect.objectContaining({ turn_id: "greeting", sequence: 2 }),
      expect.objectContaining({ turn_id: "turn-1", sequence: 4 }),
    ]);
  });

  it("sends the greeting before processing a first transcript event", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Yes, I am here.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: { accountId: "default", config: { voiceRealtime: { enabled: false } } } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({
        event: "transcript",
        text: "Hello?",
        is_final: true,
        turn_id: "turn-2",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);

    const frames = parseSentTextFrames(ws);
    expect(frames[0]).toEqual(
      expect.objectContaining({
        event: "text",
        delta: "Hi there, how can I help?",
        turn_id: "greeting",
      }),
    );
    expect(frames[2]).toEqual(
      expect.objectContaining({
        event: "text",
        delta: "Yes, I am here.",
        turn_id: "turn-2",
      }),
    );
  });

  it("coalesces consecutive final voice transcripts into one agent turn", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("That first message was split in two.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: false },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "What is it",
        is_final: true,
        turn_id: "turn-4a",
      }),
      JSON.stringify({
        event: "transcript",
        text: "take you so long to respond to my first message?",
        is_final: true,
        turn_id: "turn-4b",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain("segments=2");
    expect(run.ctxPayload.message.bodyForAgent).toContain("inkbox_identity=smoke-agent");
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Your Inkbox agent email address: smoke-agent@inkboxmail.com.",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Your Inkbox agent phone number: +16282028580.",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain("What is it");
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "take you so long to respond to my first message?",
    );
    expect(run.ctxPayload.reply.replyToId).toBe("turn-4b");
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_call",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain("[call_ended]");
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "That first message was split in two.",
    );

    const frames = parseSentTextFrames(ws);
    expect(frames.filter((frame) => frame.event === "text" && frame.delta)).toEqual([
      expect.objectContaining({ delta: "Hi there, how can I help?" }),
      expect.objectContaining({
        delta: "That first message was split in two.",
        turn_id: "turn-4b",
      }),
    ]);
  });

  it("puts voice reply mode instructions in the agent-visible turn body", async () => {
    const { runtime } = createRuntime();
    const dispatchReply = vi.fn(async (params: any) => {
      if (params.ctxPayload.message.bodyForAgent.includes("[call_ended]")) {
        expect(params.ctxPayload.message.bodyForAgent).toContain(
          "Do not redo work that was already completed on the call.",
        );
        await params.delivery.deliver({ text: "[SILENT]" });
        return;
      }
      expect(params.ctxPayload.message.bodyForAgent).toContain("reply_mode=voice_tts");
      expect(params.ctxPayload.message.bodyForAgent).toContain(
        "allow_separate_followup_tools_when_caller_explicitly_asks=true",
      );
      expect(params.ctxPayload.message.bodyForAgent).toContain(
        "Do not substitute SMS or email for the spoken call response unless the caller explicitly asks",
      );
      await params.delivery.deliver({ text: "Still on the call." });
    });
    const channelRuntime = {
      inbound: {
        buildContext: vi.fn((input) => input),
        dispatchReply,
      },
      session: {
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: { accountId: "default", config: { voiceRealtime: { enabled: false } } } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "Please text me.",
        is_final: true,
        turn_id: "turn-3",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(dispatchReply).toHaveBeenCalledTimes(2);
  });

  it("bridges raw Inkbox media through the OpenClaw realtime voice provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const inboundAudio = Buffer.from([0x01, 0x02, 0x03]);
    const echoedOutboundAudio = Buffer.from([0x09, 0x09, 0x09]);
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: {
            payload: echoedOutboundAudio.toString("base64"),
            timestamp: "20",
            track: "outbound",
          },
        }),
      },
      JSON.stringify({
        event: "media",
        stream_id: "stream-1",
        media: { payload: inboundAudio.toString("base64"), timestamp: "40", track: "inbound" },
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "false"],
        ["x-use-inkbox-speech-to-text", "false"],
      ],
    });
    const realtimeSession = realtimeMock.sessions[0].session;
    const params = realtimeMock.sessions[0].params;
    expect(realtimeSession.connect).toHaveBeenCalledTimes(1);
    expect(realtimeMock.resolveCalls.at(-1)).toEqual(
      expect.objectContaining({
        configuredProviderId: "openai",
        providerConfigOverrides: { voice: "cedar" },
      }),
    );
    expect(params.instructions).toContain(
      "Your Inkbox agent email address: smoke-agent@inkboxmail.com.",
    );
    expect(params.instructions).toContain("Your Inkbox agent phone number: +16282028580.");
    expect(params.instructions).toContain(
      "Do not deny that you have an agent email or phone number.",
    );
    expect(params.instructions).toContain("edit_post_call_action");
    expect(params.instructions).toContain("delete_post_call_action");
    expect(params.instructions).toContain("hang_up_call");
    expect(params.instructions).toContain(
      "If the caller asks for work to happen now during the live call and it needs OpenClaw/Inkbox tools, call consult_agent.",
    );
    expect(params.instructions).toContain(
      "If consult_agent completes or queues work that matches a previously registered after-call action, call delete_post_call_action",
    );
    expect(params.tools.map((tool: any) => tool.name)).toEqual([
      "consult_agent",
      "register_post_call_action",
      "edit_post_call_action",
      "delete_post_call_action",
      "hang_up_call",
    ]);
    expect(realtimeSession.triggerGreeting).toHaveBeenCalledWith(
      "Greet there in one short sentence and ask how you can help.",
    );
    expect(realtimeSession.sendAudio).not.toHaveBeenCalledWith(echoedOutboundAudio);
    expect(realtimeSession.sendAudio).toHaveBeenCalledWith(inboundAudio);
    expect(realtimeSession.setMediaTimestamp).toHaveBeenCalledWith(40);
    await Promise.resolve();
    await Promise.resolve();
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_call",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "If there is nothing still needed, return [SILENT].",
    );

    const frames = parseSentTextFrames(ws);
    expect(frames.some((frame) => frame.event === "text")).toBe(false);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "transcript",
        party: "local",
        text: "Hi there.",
        is_final: true,
      }),
    );
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "media",
        stream_id: "stream-1",
        media: expect.objectContaining({ track: "outbound" }),
      }),
    );
  });

  it("suppresses early caller media during realtime greeting startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const setupNoise = Buffer.from([0x01]);
    const callerAudio = Buffer.from([0x02]);
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "media",
        stream_id: "stream-1",
        media: { payload: setupNoise.toString("base64"), timestamp: "20", track: "inbound" },
      }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: callerAudio.toString("base64"), timestamp: "820", track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);

    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.sendAudio).not.toHaveBeenCalledWith(setupNoise);
    expect(realtimeSession.sendAudio).toHaveBeenCalledWith(callerAudio);
  });

  it("loads outbound call purpose into realtime greeting instructions", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const context = registerOutboundCallContext({
      toNumber: "+15551234567",
      purpose: "the project launch checklist",
      openingMessage: "I am calling about the project launch checklist.",
      context: "Ask whether the staging deploy has finished.",
    })!;
    const ws = new FakeInkboxWebSocket(
      [
        JSON.stringify({ event: "start", stream_id: "stream-1" }),
        JSON.stringify({ event: "stop" }),
      ],
      decorateCallWebsocketUrlWithContext(
        "wss://example.com/inkbox/phone/media/ws?call_id=call-out",
        context,
      ),
    );

    await bridge.wsHandler(ws as any);

    const realtimeSession = realtimeMock.sessions[0].session;
    const params = realtimeMock.sessions[0].params;
    expect(params.instructions).toContain("Purpose: the project launch checklist");
    expect(params.instructions).toContain("Ask whether the staging deploy has finished.");
    expect(realtimeSession.triggerGreeting).toHaveBeenCalledWith(
      expect.stringContaining("I am calling about the project launch checklist."),
    );
    expect(realtimeSession.triggerGreeting).toHaveBeenCalledWith(
      expect.not.stringContaining("how you can help"),
    );
    expect(realtimeSession.triggerGreeting).toHaveBeenCalledWith(
      expect.not.stringContaining("Greet there briefly"),
    );
  });

  it("does not add a second greeting before an outbound realtime opening message", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const context = registerOutboundCallContext({
      toNumber: "+15551234567",
      purpose: "the Boston weather update",
      openingMessage: "Hi Dima, I am calling because you asked for the Boston weather.",
    })!;
    const ws = new FakeInkboxWebSocket(
      [
        JSON.stringify({ event: "start", stream_id: "stream-1" }),
        JSON.stringify({ event: "stop" }),
      ],
      decorateCallWebsocketUrlWithContext(
        "wss://example.com/inkbox/phone/media/ws?call_id=call-out-greeting",
        context,
      ),
    );

    await bridge.wsHandler(ws as any);

    const realtimeSession = realtimeMock.sessions[0].session;
    const greeting = realtimeSession.triggerGreeting.mock.calls[0][0];
    expect(greeting).toContain("Hi Dima, I am calling because you asked");
    expect(greeting).toContain("Do not add another greeting before it.");
    expect(greeting).not.toContain("Greet there briefly");
  });

  it("does not prefix outbound fallback TTS when opening message already greets", async () => {
    realtimeMock.available = false;
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Fallback reply.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const context = registerOutboundCallContext({
      toNumber: "+15551234567",
      purpose: "the Boston weather update",
      openingMessage: "Hi Dima, I am calling because you asked for the Boston weather.",
    })!;
    const ws = new FakeInkboxWebSocket(
      [
        JSON.stringify({ event: "start", stream_id: "stream-1" }),
        JSON.stringify({ event: "stop" }),
      ],
      decorateCallWebsocketUrlWithContext(
        "wss://example.com/inkbox/phone/media/ws?call_id=call-out-fallback",
        context,
      ),
    );

    await bridge.wsHandler(ws as any);

    const frames = parseSentTextFrames(ws);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "text",
        delta: "Hi Dima, I am calling because you asked for the Boston weather.",
        turn_id: "greeting",
      }),
    );
    expect(frames).not.toContainEqual(
      expect.objectContaining({
        event: "text",
        delta: expect.stringContaining("Hi there. Hi Dima"),
      }),
    );
  });

  it("auto-detects realtime unavailability and falls back to Inkbox STT/TTS", async () => {
    realtimeMock.available = false;
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Fallback voice reply.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {},
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "Use fallback.",
        is_final: true,
        turn_id: "turn-fallback",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "[call_ended]",
    );
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(realtimeMock.sessions).toHaveLength(0);
    const frames = parseSentTextFrames(ws);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "text",
        delta: "Fallback voice reply.",
        turn_id: "turn-fallback",
      }),
    );
  });

  it("falls back to Inkbox STT/TTS when realtime connect fails before accepting media", async () => {
    realtimeMock.connectError = new Error("invalid_api_key");
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Connect fallback reply.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          voiceRealtime: {
            enabled: true,
            provider: "openai",
            fallbackToInkboxSttTts: true,
          },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "Use connect fallback.",
        is_final: true,
        turn_id: "turn-connect-fallback",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(realtimeMock.sessions).toHaveLength(1);
    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.connect).toHaveBeenCalledTimes(1);
    expect(realtimeSession.close).toHaveBeenCalledTimes(1);
    expect(ws.accept).toHaveBeenCalledTimes(1);
    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "[call_ended]",
    );
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    const frames = parseSentTextFrames(ws);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "text",
        delta: "Connect fallback reply.",
        turn_id: "turn-connect-fallback",
      }),
    );
  });

  it("uses Inkbox STT/TTS when realtime is explicitly disabled", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Disabled realtime reply.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          voiceRealtime: { enabled: false },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      JSON.stringify({
        event: "transcript",
        text: "Use STT TTS.",
        is_final: true,
        turn_id: "turn-disabled",
      }),
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "[call_ended]",
    );
    expect(channelRuntime.inbound.dispatchReply.mock.calls[1][0].ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(realtimeMock.sessions).toHaveLength(0);
    const frames = parseSentTextFrames(ws);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "text",
        delta: "Disabled realtime reply.",
        turn_id: "turn-disabled",
      }),
    );
  });

  it("delegates realtime tool calls to the OpenClaw Inkbox session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = "consult";
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Saved that note.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain("[inkbox:voice_realtime_consult");
    expect(run.ctxPayload.message.bodyForAgent).toContain("Save this as a note.");
    expect(run.ctxPayload.extra.InkboxVoiceReplyOnly).toBe(true);
    expect(channelRuntime.deliveryResults[0]).toEqual({ visibleReplySent: true });
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_call",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "In-call OpenClaw consult results:",
    );

    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith(
      "tool-1",
      expect.objectContaining({
        status: "working",
        message: expect.stringContaining("One moment"),
      }),
      { willContinue: true },
    );
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("tool-1", {
      status: "ok",
      result: "Saved that note.",
    });
    const frames = parseSentTextFrames(ws);
    expect(frames).toContainEqual(
      expect.objectContaining({
        event: "transcript",
        party: "remote",
        text: "Please handle this request.",
        is_final: true,
      }),
    );
  });

  it("deduplicates repeated in-call SMS consults while the first is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = [
      {
        callId: "consult-1",
        name: "consult_agent",
        args: {
          question:
            'Send SMS to +15551234567 now: "Hi, this is smoke-agent. I am here to help during your call."',
        },
      },
      {
        callId: "consult-2",
        name: "consult_agent",
        args: {
          question:
            'Proceed to send a quick generic SMS to +15551234567: "Hi, this is smoke-agent. I am here to help during your call."',
        },
      },
    ];
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("SMS queued during the call.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith(
      "consult-2",
      expect.objectContaining({
        status: "already_running",
        existingToolCallId: "consult-1",
      }),
    );
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("consult-1", {
      status: "ok",
      result: "SMS queued during the call.",
    });
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_call",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "SMS queued during the call.",
    );
  });

  it("runs registered realtime post-call actions after the call closes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = "post_call";
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Follow-up sent.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("tool-1", {
      status: "registered",
      action_id: "tool-1",
      action_index: 1,
      action_count: 1,
      message:
        "Post-call action registered. Tell the caller it is queued for after the call, not completed yet.",
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_post_call_actions",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Send a follow-up email to Dima about the launch checklist.",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Try SMS first; if SMS is unavailable or not opted in, try email; if email is unavailable, place a follow-up call",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Do not send a confirmation follow-up after successful work unless the caller explicitly requested one.",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "execute only the actions that are still needed",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "If an action was already completed or queued during the call",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain("Full live-call transcript:");
    expect(run.ctxPayload.extra.InkboxMode).toBe("sms");
  });

  it("includes in-call consult results in realtime post-call handoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = [
      {
        callId: "register-1",
        name: "register_post_call_action",
        args: {
          action: "Send an SMS to Dima.",
          details: "Caller initially accepted an after-call SMS.",
        },
      },
      {
        callId: "consult-1",
        name: "consult_agent",
        args: { question: "Send the SMS now during the live call." },
      },
    ];
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime(
      "Yes. The main agent queued the SMS during the live call.",
    );
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(2);
    expect(channelRuntime.deliveryResults[0]).toEqual({ visibleReplySent: true });
    expect(channelRuntime.deliveryResults[1]).toEqual({ visibleReplySent: true });
    const postCallRun = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    const body = postCallRun.ctxPayload.message.bodyForAgent;
    expect(body).toContain("In-call OpenClaw consult results:");
    expect(body).toContain("Request: Send the SMS now during the live call.");
    expect(body).toContain("Result: Yes. The main agent queued the SMS during the live call.");
    expect(body).toContain(
      "A same-channel in-call consult result that says an SMS/email was sent or queued counts as already handled.",
    );
  });

  it("edits and deletes queued realtime post-call actions by index", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = [
      {
        callId: "register-1",
        name: "register_post_call_action",
        args: { action: "Email Dima.", details: "Old draft." },
      },
      {
        callId: "register-2",
        name: "register_post_call_action",
        args: { action: "Create a note.", details: "Old note." },
      },
      {
        callId: "edit-2",
        name: "edit_post_call_action",
        args: {
          action_index: 2,
          action: "Create an Inkbox note about the launch checklist.",
          details: "Include that staging is still pending.",
        },
      },
      {
        callId: "delete-1",
        name: "delete_post_call_action",
        args: { action_index: 1 },
      },
    ];
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Note created.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
      JSON.stringify({ event: "stop" }),
    ]);

    await bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();

    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("edit-2", {
      status: "updated",
      action_id: "register-2",
      action_index: 2,
      action_count: 2,
      action: expect.objectContaining({
        action: "Create an Inkbox note about the launch checklist.",
        details: "Include that staging is still pending.",
      }),
      message: expect.stringContaining("updated"),
    });
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("delete-1", {
      status: "deleted",
      deleted_action: expect.objectContaining({ action: "Email Dima." }),
      action_index: 1,
      action_count: 1,
      remaining_actions: [
        expect.objectContaining({
          action: "Create an Inkbox note about the launch checklist.",
        }),
      ],
      message: expect.stringContaining("deleted"),
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Create an Inkbox note about the launch checklist.",
    );
    expect(run.ctxPayload.message.bodyForAgent).not.toContain("Email Dima.");
  });

  it("requires two realtime hangup calls before closing the Inkbox call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    realtimeMock.toolCallOnAudio = [
      {
        callId: "hangup-1",
        name: "hang_up_call",
        args: { reason: "caller said goodbye" },
      },
      {
        callId: "hangup-2",
        name: "hang_up_call",
        args: { reason: "caller said goodbye" },
      },
    ];
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime("Should not dispatch.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        config: {
          identity: "smoke-agent",
          voiceRealtime: { enabled: true, provider: "openai", toolPolicy: "owner" },
        },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });
    const ws = new FakeInkboxWebSocket([
      JSON.stringify({ event: "start", stream_id: "stream-1" }),
      {
        advanceMs: 800,
        message: JSON.stringify({
          event: "media",
          stream_id: "stream-1",
          media: { payload: Buffer.from([0x01]).toString("base64"), track: "inbound" },
        }),
      },
    ]);

    const run = bridge.wsHandler(ws as any);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2000);
    await run;

    const realtimeSession = realtimeMock.sessions[0].session;
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith("hangup-1", {
      status: "confirm_goodbye",
      message: expect.stringContaining("Don't hang up yet"),
    });
    expect(realtimeSession.submitToolResult).toHaveBeenCalledWith(
      "hangup-2",
      {
        status: "hangup_requested",
        reason: "caller said goodbye",
        message: "The call is ending now.",
      },
      { suppressResponse: true },
    );
    expect(parseSentTextFrames(ws)).toContainEqual({
      event: "stop",
      reason: "caller said goodbye",
      stream_id: "stream-1",
    });
    expect(realtimeSession.close).toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const reflectionRun = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:voice_call",
    );
    expect(reflectionRun.ctxPayload.message.bodyForAgent).toContain(
      "Do not redo work that was already completed on the call.",
    );
  });

  it("routes unaddressed group SMS to the agent and honors silent replies", async () => {
    const { runtime, sendText } = createRuntime({
      conversations: [
        {
          id: "conv-group",
          participants: ["+15551234567", "+15557654321"],
          isGroup: true,
        },
      ],
    });
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onText?.(
      textWebhookEvent({
        conversationId: "conv-group",
        text: "Dinner is at 7.",
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.conversation.kind).toBe("group");
    expect(run.ctxPayload.conversation.id).toBe("sms:conv-group");
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "you receive every message in this group so you can track context",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "Treat ordinary group chatter as context only.",
    );
    expect(sendText).not.toHaveBeenCalled();
  });

  it("routes addressed group SMS as a group conversation and replies by conversationId", async () => {
    const { runtime, sendText } = createRuntime({
      conversations: [
        {
          id: "conv-group",
          participants: ["+15551234567", "+15557654321"],
          isGroup: true,
        },
      ],
    });
    const channelRuntime = createChannelRuntime("Sure, I can help.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onText?.(
      textWebhookEvent({
        conversationId: "conv-group",
        text: "smoke-agent can you help with dinner?",
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.conversation.kind).toBe("group");
    expect(run.ctxPayload.conversation.id).toBe("sms:conv-group");
    expect(run.ctxPayload.reply.to).toBe("sms:conv-group");
    expect(run.ctxPayload.extra.InkboxConversationId).toBe("conv-group");
    expect(run.ctxPayload.message.bodyForAgent).toContain("Group SMS response policy");
    expect(sendText).toHaveBeenCalledWith({
      conversationId: "conv-group",
      text: "Sure, I can help.",
    });
  });

  it("rejects over-limit inbound SMS replies before sending", async () => {
    const { runtime, sendText, sendIMessage } = createRuntime({
      conversations: [
        {
          id: "conv-sms",
          participants: ["+15551234567"],
          isGroup: false,
        },
      ],
    });
    const deliveryErrors: unknown[] = [];
    const longReply = "x".repeat(SMS_MAX_TEXT_CHARS + 1);
    const dispatchReply = vi.fn(async (params: any) => {
      try {
        await params.delivery.deliver({ text: longReply });
      } catch (error) {
        deliveryErrors.push(error);
        params.delivery.onError?.(error);
      }
    });
    const channelRuntime = {
      inbound: {
        buildContext: vi.fn((input) => input),
        dispatchReply,
      },
      session: {
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onText?.(
      textWebhookEvent({
        conversationId: "conv-sms",
        text: "Can you send me all the details?",
      }),
    );

    expect(deliveryErrors).toHaveLength(1);
    expect(String((deliveryErrors[0] as Error).message)).toContain(
      "SMS text is 1601 characters",
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("routes inbound iMessage into a contact session and replies by conversationId", async () => {
    const { runtime, sendIMessage, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime("On my way!");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({ content: "Dinner moved to 7." }),
    );

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:imessage from=+15551234567 conversation_id=imconv-123",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain("Dinner moved to 7.");
    expect(run.ctxPayload.extra.InkboxMode).toBe("imessage");
    expect(run.ctxPayload.extra.InkboxConversationId).toBe("imconv-123");
    // The route/conversation id must stay channel-prefixed so a generic
    // `message`-tool send to this peer resolves to sendIMessage, not SMS.
    expect(run.ctxPayload.conversation.id).toBe("imessage:imconv-123");
    expect(run.ctxPayload.conversation.routePeer.id).toBe("imessage:imconv-123");
    expect(run.ctxPayload.reply.to).toBe("imessage:imconv-123");
    expect(run.ctxPayload.reply.messageThreadId).toBe("imessage:imconv-123");
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      text: "On my way!",
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("resolves inbound iMessage contact via SDK lookup and injects Hermes-style marker", async () => {
    const { runtime } = createRuntime();
    (runtime.getClient as any).mockResolvedValue({
      calls: {
        get: vi.fn(async () => ({
          remotePhoneNumber: "+15167251294",
          direction: "inbound",
        })),
      },
      contacts: {
        lookup: vi.fn(async () => [
          {
            id: "contact-dima",
            preferredName: "Dima",
            companyName: "Inkbox",
            jobTitle: "must not render",
            notes: "must not render",
            emails: [{ value: "dima@inkbox.ai" }],
            phones: [{ value: "+15167251294" }],
          },
        ]),
      },
    });
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({ remote: "+15167251294", content: "Who am I?" }),
    );

    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    const body = run.ctxPayload.message.bodyForAgent;
    expect(run.ctxPayload.conversation.id).toBe("contact-dima");
    expect(body).toContain("contact_id=contact-dima");
    expect(body).toContain('contact_name="Dima"');
    expect(body).toContain('contact_company="Inkbox"');
    expect(body).toContain("contact_emails=dima@inkbox.ai");
    expect(body).toContain("contact_phones=+15167251294");
    expect(body).not.toContain("contact_job_title");
    expect(body).not.toContain("contact_notes");
  });

  it("rejects over-limit inbound iMessage replies before sending", async () => {
    const { runtime, sendIMessage, sendText } = createRuntime();
    const deliveryErrors: unknown[] = [];
    const longReply = "x".repeat(IMESSAGE_MAX_TEXT_CHARS + 1);
    const dispatchReply = vi.fn(async (params: any) => {
      try {
        await params.delivery.deliver({ text: longReply });
      } catch (error) {
        deliveryErrors.push(error);
        params.delivery.onError?.(error);
      }
    });
    const channelRuntime = {
      inbound: {
        buildContext: vi.fn((input) => input),
        dispatchReply,
      },
      session: {
        recordInboundSession: vi.fn(),
      },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
      },
    };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({ content: "Dinner moved to 7." }),
    );

    expect(deliveryErrors).toHaveLength(1);
    expect(String((deliveryErrors[0] as Error).message)).toContain(
      "iMessage text is 18996 characters",
    );
    expect(sendIMessage).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("ignores outbound iMessage echoes without waking the agent", async () => {
    const { runtime, sendIMessage } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({ content: "agent reply", direction: "outbound" }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("logs iMessage delivery lifecycle events without dispatching an agent turn", async () => {
    const { runtime } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
      logger,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({
        content: "agent reply",
        direction: "outbound",
        eventType: "imessage.delivered",
      }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      "Inkbox iMessage lifecycle event: imessage.delivered",
    );
  });

  it("pulses the typing indicator while composing an iMessage reply", async () => {
    const { runtime, sendIMessageTyping } = createRuntime();
    const channelRuntime = createChannelRuntime("On my way!");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageWebhookEvent({ content: "Dinner moved to 7." }),
    );
    // The first pulse fires immediately on turn start; let it settle.
    await new Promise((resolve) => setImmediate(resolve));

    expect(sendIMessageTyping).toHaveBeenCalledWith("imconv-123");
  });

  it("dispatches inbound tapbacks with a reply-or-silent policy and replies into the thread", async () => {
    const { runtime, sendIMessage, sendIMessageTyping } = createRuntime();
    const channelRuntime = createChannelRuntime("Yes — 7pm at the usual place.");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageReactionWebhookEvent({ reaction: "question" }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain(
      "[inkbox:imessage_reaction from=+15551234567 reaction=question conversation_id=imconv-123 target_message_id=im-target-9",
    );
    expect(run.ctxPayload.message.bodyForAgent).toContain("return exactly [SILENT]");
    expect(run.ctxPayload.reply.to).toBe("imessage:imconv-123");
    expect(sendIMessage).toHaveBeenCalledWith({
      conversationId: "imconv-123",
      text: "Yes — 7pm at the usual place.",
    });
    // A "question" tapback usually expects a reply, so typing is shown.
    expect(sendIMessageTyping).toHaveBeenCalledWith("imconv-123");
  });

  it("does not promise a reply for non-question tapbacks and honors [SILENT]", async () => {
    const { runtime, sendIMessage, sendIMessageTyping } = createRuntime();
    const channelRuntime = createChannelRuntime("[SILENT]");
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageReactionWebhookEvent({ reaction: "love" }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    expect(sendIMessage).not.toHaveBeenCalled();
    expect(sendIMessageTyping).not.toHaveBeenCalled();
  });

  it("ignores outbound tapback echoes without waking the agent", async () => {
    const { runtime, sendIMessage } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: {
        accountId: "default",
        identity: "smoke-agent",
        config: { identity: "smoke-agent" },
      } as any,
      runtime: runtime as any,
      channelRuntime,
    });

    await bridge.handlers.onIMessage?.(
      imessageReactionWebhookEvent({ reaction: "like", direction: "outbound" }),
    );

    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(sendIMessage).not.toHaveBeenCalled();
  });
});

describe("createIMessageTypingPulse", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the safety cap at ten minutes", () => {
    expect(IMESSAGE_TYPING_MAX_MS).toBe(600_000);
  });

  it("refreshes the indicator on an interval until stopped", async () => {
    vi.useFakeTimers();
    const sendIMessageTyping = vi.fn(async () => undefined);
    const runtime = {
      getIdentity: async () => ({ sendIMessageTyping }),
      getClient: async () => ({}),
    };
    const pulse = createIMessageTypingPulse(runtime as any);

    pulse.start("imconv-1");
    await vi.advanceTimersByTimeAsync(0);
    expect(sendIMessageTyping).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS);
    expect(sendIMessageTyping).toHaveBeenCalledTimes(2);

    // Starting again for the same conversation does not double-pulse.
    pulse.start("imconv-1");
    await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS);
    expect(sendIMessageTyping).toHaveBeenCalledTimes(3);

    pulse.stop("imconv-1");
    await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS * 3);
    expect(sendIMessageTyping).toHaveBeenCalledTimes(3);
  });

  it("stops on its own at the safety cap", async () => {
    vi.useFakeTimers();
    const sendIMessageTyping = vi.fn(async () => undefined);
    const runtime = {
      getIdentity: async () => ({ sendIMessageTyping }),
      getClient: async () => ({}),
    };
    const pulse = createIMessageTypingPulse(runtime as any);

    pulse.start("imconv-1");
    await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_MAX_MS + IMESSAGE_TYPING_REFRESH_MS * 2);
    const countAtCap = sendIMessageTyping.mock.calls.length;
    // 1 immediate pulse + one per refresh tick, until elapsed hits the cap (the
    // capping tick stops without pulsing).
    const expectedAtCap =
      1 + Math.floor((IMESSAGE_TYPING_MAX_MS - 1) / IMESSAGE_TYPING_REFRESH_MS);
    expect(countAtCap).toBe(expectedAtCap);

    await vi.advanceTimersByTimeAsync(IMESSAGE_TYPING_REFRESH_MS * 2);
    expect(sendIMessageTyping).toHaveBeenCalledTimes(countAtCap);
  });
});
