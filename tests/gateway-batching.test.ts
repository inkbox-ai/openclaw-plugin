import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  routeOptions: [] as any[],
  rawOnText: vi.fn(),
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
  configureInkboxIdentityDelivery: vi.fn(),
  createInkboxSessionBridge: vi.fn(() => ({
    handlers: { onText: mocks.rawOnText },
    wsHandler: vi.fn(),
  })),
  prewarmInkboxAgent: vi.fn(),
}));

vi.mock("../src/inbound/tunnel.js", () => ({
  openInkboxTunnel: vi.fn(),
}));

import { registerInkboxPublicUrlInboundRoutes } from "../src/gateway.js";

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
