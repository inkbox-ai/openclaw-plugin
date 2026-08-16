import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeOptions: [] as any[],
  rawOnText: vi.fn(),
  configureDelivery: vi.fn(),
  shutdownA2A: vi.fn(),
  wsHandler: vi.fn(),
  createUpgradeHandler: vi.fn(() => vi.fn(() => true)),
}));

vi.mock("../src/client.js", () => ({
  createInkboxRuntime: vi.fn(() => ({})),
}));

vi.mock("../src/inbound/http-route.js", () => ({
  registerInboundHttpRoute: vi.fn((opts: any) => {
    mocks.routeOptions.push(opts);
  }),
}));

vi.mock("../src/inbound/session.js", () => ({
  configureInkboxIdentityDelivery: mocks.configureDelivery,
  createInkboxSessionBridge: vi.fn(() => ({
    handlers: { onText: mocks.rawOnText },
    wsHandler: mocks.wsHandler,
    catchUpA2A: vi.fn(),
    catchUpHostedCalls: vi.fn(),
    shutdownA2A: mocks.shutdownA2A,
  })),
  prewarmInkboxAgent: vi.fn(),
}));

vi.mock("../src/inbound/tunnel.js", () => ({
  openInkboxTunnel: vi.fn(),
}));

vi.mock("../src/inbound/websocket-upgrade.js", () => ({
  createInkboxWebSocketUpgradeHandler: mocks.createUpgradeHandler,
}));

import {
  registerInkboxPublicUrlInboundRoutes,
  startInkboxGatewayAccount,
} from "../src/gateway.js";

function textEvent(remote: string, text: string): any {
  return {
    event_type: "text.received",
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      text_message: {
        id: `txt-${text}`,
        direction: "inbound",
        remote_phone_number: remote,
        text,
      },
    },
  };
}

describe("gateway inbound batching", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.routeOptions.length = 0;
    mocks.rawOnText.mockReset();
    mocks.configureDelivery.mockReset();
    mocks.shutdownA2A.mockReset();
  });

  it("registers an exact account-aware call websocket upgrade route", () => {
    const registerHttpRoute = vi.fn();
    registerInkboxPublicUrlInboundRoutes({
      registerHttpRoute,
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: {
        config: {
          current: () => ({
            channels: {
              inkbox: {
                accounts: {
                  media: {
                    apiKey: "ApiKey_test",
                    identity: "media-agent",
                    signingKey: "whsec_test",
                    publicUrl: "https://voice.example/base",
                    voiceStack: "openai_realtime",
                  },
                },
              },
            },
          }),
        },
        channel: {},
      },
    });

    const wsRoute = registerHttpRoute.mock.calls
      .map(([route]) => route)
      .find((route) => route.path === "/inkbox/media/phone/media/ws");
    expect(wsRoute).toEqual(
      expect.objectContaining({
        auth: "plugin",
        match: "exact",
        handleUpgrade: expect.any(Function),
      }),
    );
    expect(mocks.createUpgradeHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        handler: mocks.wsHandler,
        publicWebsocketUrl:
          "wss://voice.example/base/inkbox/media/phone/media/ws",
      }),
    );
    const response = {
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    };
    expect(wsRoute.handler({}, response)).toBe(true);
    expect(response.statusCode).toBe(426);
    expect(response.setHeader).toHaveBeenCalledWith("upgrade", "websocket");
    expect(response.end).toHaveBeenCalledWith("WebSocket upgrade required");
  });

  it("does not claim a websocket route owned by an external URL", () => {
    const registerHttpRoute = vi.fn();
    registerInkboxPublicUrlInboundRoutes({
      registerHttpRoute,
      runtime: {
        config: {
          current: () => ({
            channels: {
              inkbox: {
                accounts: {
                  external: {
                    apiKey: "ApiKey_test",
                    identity: "external-agent",
                    signingKey: "whsec_test",
                    publicUrl: "https://voice.example/base",
                    callWebsocketUrl: "wss://external.example/calls",
                    voiceStack: "inkbox_tts_stt",
                  },
                },
              },
            },
          }),
        },
      },
    });

    expect(
      registerHttpRoute.mock.calls.some(
        ([route]) => route.path === "/inkbox/external/phone/media/ws",
      ),
    ).toBe(false);
  });

  it("allows websocket route registration to retry after a host rejection", () => {
    const current = () => ({
      channels: {
        inkbox: {
          accounts: {
            retry: {
              apiKey: "ApiKey_test",
              identity: "retry-agent",
              signingKey: "whsec_test",
              publicUrl: "https://voice.example/base",
              voiceStack: "openai_realtime",
            },
          },
        },
      },
    });
    const failing = vi.fn((route) => {
      if (route.path.endsWith("/phone/media/ws")) throw new Error("route conflict");
    });
    expect(() =>
      registerInkboxPublicUrlInboundRoutes({
        registerHttpRoute: failing,
        runtime: { config: { current } },
      }),
    ).toThrow("route conflict");

    const retry = vi.fn();
    registerInkboxPublicUrlInboundRoutes({
      registerHttpRoute: retry,
      runtime: { config: { current } },
    });
    expect(
      retry.mock.calls.some(
        ([route]) => route.path === "/inkbox/retry/phone/media/ws",
      ),
    ).toBe(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers public-url gateway routes with batched SMS handlers", async () => {
    registerInkboxPublicUrlInboundRoutes({
      registerHttpRoute: vi.fn(),
      logger: { info: vi.fn(), warn: vi.fn() },
      runtime: {
        config: {
          current: () => ({
            channels: {
              inkbox: {
                apiKey: "ApiKey_test",
                identity: "smoke-agent",
                signingKey: "whsec_test",
                publicUrl: "https://example.com",
                sms: { batchDelayMs: 100, maxMessages: 8, maxChars: 4000 },
              },
            },
          }),
        },
        channel: {},
      },
    });

    expect(mocks.routeOptions).toHaveLength(1);
    const onText = mocks.routeOptions[0].handlers.onText;

    await onText(textEvent("+15551234567", "first"));
    await onText(textEvent("+15551234567", "second"));
    expect(mocks.rawOnText).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(110);

    expect(mocks.rawOnText).toHaveBeenCalledTimes(1);
    expect(mocks.rawOnText.mock.calls[0][0].data.text_message.text).toBe(
      "first\nsecond",
    );
  });
});

describe("public-url call routing", () => {
  beforeEach(() => {
    mocks.configureDelivery.mockReset();
    mocks.shutdownA2A.mockReset();
  });

  it.each([
    {
      voiceStack: "openai_realtime",
      accountId: "default",
      expected: "wss://voice.example/base/inkbox/phone/media/ws",
    },
    {
      voiceStack: "inkbox_tts_stt",
      accountId: "secondary",
      expected: "wss://voice.example/base/inkbox/secondary/phone/media/ws",
    },
    {
      voiceStack: "openai_realtime",
      accountId: "custom",
      callWebsocketUrl: "wss://media.example/custom/ws",
      expected: "wss://media.example/custom/ws",
    },
  ] as const)(
    "wires $voiceStack to the canonical account websocket",
    async ({ voiceStack, accountId, expected, ...testCase }) => {
      const abort = new AbortController();
      abort.abort();
      const dispose = vi.fn();
      const register = vi.fn(() => ({ dispose }));

      await startInkboxGatewayAccount({
        cfg: {},
        accountId,
        account: {
          accountId,
          enabled: true,
          configured: true,
          publicUrl: "https://voice.example/base",
          config: {
            apiKey: "ApiKey_test",
            identity: "agent",
            signingKey: "whsec_test",
            publicUrl: "https://voice.example/base",
            voiceStack,
            ...(testCase.callWebsocketUrl
              ? { callWebsocketUrl: testCase.callWebsocketUrl }
              : {}),
          },
        } as any,
        abortSignal: abort.signal,
        log: {},
        setStatus: vi.fn(),
        channelRuntime: { runtimeContexts: { register } },
      });

      expect(mocks.configureDelivery).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookUrl:
            accountId === "default"
              ? "https://voice.example/base/inkbox/webhook"
              : `https://voice.example/base/inkbox/${accountId}/webhook`,
          callWebsocketUrl: expected,
          voiceStack,
        }),
      );
      expect(mocks.configureDelivery.mock.calls[0][0]).not.toHaveProperty(
        "callWebhookUrl",
      );
      expect(register).toHaveBeenCalledWith(
        expect.objectContaining({
          channelId: "inkbox",
          accountId,
          capability: "call-websocket",
          context: { url: expected },
        }),
      );
      expect(dispose).toHaveBeenCalled();
      expect(mocks.shutdownA2A).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps Inkbox Voice AI hosted with no local callback", async () => {
    const abort = new AbortController();
    abort.abort();
    const register = vi.fn();

    await startInkboxGatewayAccount({
      cfg: {},
      accountId: "default",
      account: {
        accountId: "default",
        enabled: true,
        configured: true,
        publicUrl: "https://voice.example/base",
        config: {
          apiKey: "ApiKey_test",
          identity: "agent",
          signingKey: "whsec_test",
          publicUrl: "https://voice.example/base",
          voiceStack: "inkbox_voice_ai",
        },
      } as any,
      abortSignal: abort.signal,
      log: {},
      setStatus: vi.fn(),
      channelRuntime: { runtimeContexts: { register } },
    });

    expect(mocks.configureDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "https://voice.example/base/inkbox/webhook",
        voiceStack: "inkbox_voice_ai",
      }),
    );
    expect(mocks.configureDelivery.mock.calls[0][0]).not.toHaveProperty(
      "callWebsocketUrl",
    );
    expect(mocks.configureDelivery.mock.calls[0][0]).not.toHaveProperty(
      "callWebhookUrl",
    );
    expect(register).not.toHaveBeenCalled();
    expect(mocks.shutdownA2A).toHaveBeenCalledTimes(1);
  });

  it("disposes the websocket runtime context when startup fails", async () => {
    mocks.configureDelivery.mockRejectedValueOnce(new Error("route update failed"));
    const abort = new AbortController();
    const dispose = vi.fn();

    await expect(
      startInkboxGatewayAccount({
        cfg: {},
        accountId: "default",
        account: {
          accountId: "default",
          enabled: true,
          configured: true,
          publicUrl: "https://voice.example/base",
          config: {
            apiKey: "ApiKey_test",
            identity: "agent",
            signingKey: "whsec_test",
            publicUrl: "https://voice.example/base",
            voiceStack: "openai_realtime",
          },
        } as any,
        abortSignal: abort.signal,
        log: {},
        setStatus: vi.fn(),
        channelRuntime: {
          runtimeContexts: { register: vi.fn(() => ({ dispose })) },
        },
      }),
    ).rejects.toThrow("route update failed");

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownA2A).toHaveBeenCalledTimes(1);
  });
});
