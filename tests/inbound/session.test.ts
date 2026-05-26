import { describe, expect, it, vi } from "vitest";

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

import { createInkboxSessionBridge } from "../../src/inbound/session.js";
import { shouldBlockInkboxOutboundToolDuringVoice } from "../../src/voice-guard.js";

class FakeInkboxWebSocket {
  readonly headers = new Map<string, string>();
  readonly url = "wss://example.com/inkbox/phone/media/ws?call_id=call-1";
  readonly sent: string[] = [];
  readonly accept = vi.fn(async () => undefined);
  readonly send = vi.fn(async (message: string) => {
    this.sent.push(message);
  });
  readonly close = vi.fn(async () => undefined);

  constructor(private readonly messages: string[]) {}

  async *[Symbol.asyncIterator](): AsyncIterableIterator<string> {
    for (const message of this.messages) {
      yield message;
    }
  }
}

function createRuntime() {
  const sendText = vi.fn();
  const runtime = {
    getIdentity: vi.fn(async () => ({
      phoneNumber: { id: "phone-1" },
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
  const runAssembled = vi.fn(async (params: any) => {
    await params.delivery.deliver({ text: replyText });
  });
  return {
    turn: {
      buildContext: vi.fn((input) => input),
      runAssembled,
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
  it("speaks greeting and agent replies over TTS, not SMS", async () => {
    const { runtime, sendText } = createRuntime();
    const channelRuntime = createChannelRuntime();
    const bridge = createInkboxSessionBridge({
      cfg: {},
      account: { accountId: "default", config: {} } as any,
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
    expect(channelRuntime.turn.runAssembled).toHaveBeenCalledTimes(1);
    expect(channelRuntime.turn.runAssembled).toHaveBeenCalledWith(
      expect.objectContaining({
        replyOptions: { sourceReplyDeliveryMode: "automatic" },
      }),
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(bridge.activeCalls.size).toBe(0);
    expect(
      shouldBlockInkboxOutboundToolDuringVoice(
        "inkbox_send_sms",
        "agent:main:inkbox:direct:+15551234567",
      ),
    ).toBe(false);

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
      account: { accountId: "default", config: {} } as any,
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

  it("marks the route session as voice-active during agent processing", async () => {
    const { runtime } = createRuntime();
    const runAssembled = vi.fn(async (params: any) => {
      expect(
        shouldBlockInkboxOutboundToolDuringVoice(
          "inkbox_send_sms",
          "agent:main:inkbox:direct:+15551234567",
        ),
      ).toBe(true);
      await params.delivery.deliver({ text: "Still on the call." });
    });
    const channelRuntime = {
      turn: {
        buildContext: vi.fn((input) => input),
        runAssembled,
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
      account: { accountId: "default", config: {} } as any,
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

    expect(runAssembled).toHaveBeenCalledTimes(1);
    expect(
      shouldBlockInkboxOutboundToolDuringVoice(
        "inkbox_send_sms",
        "agent:main:inkbox:direct:+15551234567",
      ),
    ).toBe(false);
  });
});
