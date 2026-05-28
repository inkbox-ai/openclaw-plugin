import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realtimeMock = vi.hoisted(() => ({
  available: true,
  sessions: [] as any[],
  toolCallOnAudio: false as false | true | "consult" | "post_call",
  resolveCalls: [] as any[],
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
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: "openclaw_agent_consult",
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
            name: "openclaw_agent_consult",
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
    const session: any = {
      bridge: { supportsToolResultContinuation: true },
      connect: vi.fn(async () => {
        params.onReady?.(session);
      }),
      sendAudio: vi.fn((audio: Buffer) => {
        if (realtimeMock.toolCallOnAudio && !toolCalled) {
          toolCalled = true;
          params.onTranscript?.("user", "Please handle this request.", true);
          const toolName =
            realtimeMock.toolCallOnAudio === "post_call"
              ? "inkbox_register_post_call_action"
              : "openclaw_agent_consult";
          params.onToolCall?.(
            {
              itemId: "item-1",
              callId: "tool-1",
              name: toolName,
              args:
                toolName === "inkbox_register_post_call_action"
                  ? {
                      action: "Send a follow-up email to Dima about the launch checklist.",
                      details: "Include that staging is still pending.",
                    }
                  : { question: "Save this as a note." },
            },
            session,
          );
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
  InkboxRealtimeAudioPacer,
  createInkboxSessionBridge,
  prewarmInkboxAgent,
} from "../../src/inbound/session.js";
import {
  decorateCallWebsocketUrlWithContext,
  registerOutboundCallContext,
} from "../../src/outbound-call-context.js";

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

function createRuntime() {
  const sendText = vi.fn();
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
  return { runtime, sendText };
}

function createChannelRuntime(replyText = "I can hear you on the call.") {
  const dispatchReply = vi.fn(async (params: any) => {
    await params.delivery.deliver({ text: replyText });
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
  };
}

function parseSentTextFrames(ws: FakeInkboxWebSocket) {
  return ws.sent.map((message) => JSON.parse(message));
}

describe("createInkboxSessionBridge call WebSocket", () => {
  beforeEach(() => {
    realtimeMock.available = true;
    realtimeMock.sessions = [];
    realtimeMock.toolCallOnAudio = false;
    realtimeMock.resolveCalls = [];
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

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(dispatchReply).toHaveBeenCalledTimes(1);
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
    expect(realtimeSession.triggerGreeting).toHaveBeenCalledWith(
      "Greet there in one short sentence and ask how you can help.",
    );
    expect(realtimeSession.sendAudio).not.toHaveBeenCalledWith(echoedOutboundAudio);
    expect(realtimeSession.sendAudio).toHaveBeenCalledWith(inboundAudio);
    expect(realtimeSession.setMediaTimestamp).toHaveBeenCalledWith(40);
    expect(channelRuntime.inbound.dispatchReply).not.toHaveBeenCalled();

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
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(ws.accept).toHaveBeenCalledWith({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
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

    expect(channelRuntime.inbound.dispatchReply).toHaveBeenCalledTimes(1);
    const run = channelRuntime.inbound.dispatchReply.mock.calls[0][0];
    expect(run.ctxPayload.message.bodyForAgent).toContain("[inkbox:voice_realtime_consult");
    expect(run.ctxPayload.message.bodyForAgent).toContain("Save this as a note.");
    expect(run.ctxPayload.extra.InkboxVoiceReplyOnly).toBe(true);

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
      actionId: "tool-1",
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
    expect(run.ctxPayload.extra.InkboxMode).toBe("sms");
  });
});
