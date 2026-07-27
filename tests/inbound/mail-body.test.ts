// Inbound email turns carry the full body, not the 200-char snippet.
// `message.received` ships the body alongside the snippet and self-describes
// when it had to abbreviate; payloads without a body still fall back to it.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inkbox/sdk", () => ({ verifyWebhook: vi.fn(() => true) }));

vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:inkbox:direct:atlas@inkboxmail.com",
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
  resolveRealtimeVoiceAgentConsultToolPolicy: vi.fn((v: any, f: any) => v ?? f),
  resolveRealtimeVoiceAgentConsultTools: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(() => {
    throw new Error("realtime voice not configured in this test");
  }),
  createRealtimeVoiceBridgeSession: vi.fn(),
}));

import { createInkboxSessionBridge } from "../../src/inbound/session.js";

const LONG_BODY = "Pricing details follow. ".repeat(40);
const SNIPPET = LONG_BODY.slice(0, 200);

function createRuntime() {
  return {
    getIdentity: vi.fn(async () => ({
      agentHandle: "smoke-agent",
      id: "identity-1",
      emailAddress: "smoke-agent@inkboxmail.com",
      mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
      sendEmail: vi.fn(async () => ({ id: "mail-reply" })),
    })),
    getClient: vi.fn(async () => ({
      contacts: { lookup: vi.fn(async () => []) },
    })),
  };
}

function createChannelRuntime() {
  return {
    inbound: {
      buildContext: vi.fn((input: any) => input),
      dispatchReply: vi.fn(async () => undefined),
    },
    session: { recordInboundSession: vi.fn() },
    reply: { dispatchReplyWithBufferedBlockDispatcher: vi.fn() },
  };
}

function createBridge(runtime: any, channelRuntime: any) {
  return createInkboxSessionBridge({
    cfg: {},
    account: { accountId: "default", config: { identity: "smoke-agent" } } as any,
    runtime,
    channelRuntime,
    logger: { info: vi.fn(), warn: vi.fn() },
  });
}

function bodyOf(channelRuntime: any): string {
  return channelRuntime.inbound.dispatchReply.mock.calls[0][0].ctxPayload.message.bodyForAgent;
}

function mailEvent(overrides: Record<string, unknown> = {}): any {
  return {
    id: "evt-mail-1",
    event_type: "message.received",
    timestamp: "2026-07-11T00:00:00Z",
    data: {
      message: {
        id: "mail-in-1",
        mailbox_id: "mailbox-1",
        thread_id: "thread-1",
        message_id: "<mail-in-1@inkboxmail.com>",
        from_address: "atlas@inkboxmail.com",
        to_addresses: ["smoke-agent@inkboxmail.com"],
        cc_addresses: null,
        bcc_addresses: null,
        subject: "Coordinating",
        snippet: SNIPPET,
        direction: "inbound",
        status: "received",
        has_attachments: false,
        created_at: "2026-07-11T00:00:00Z",
        ...overrides,
      },
      contacts: [],
      agent_identities: [],
    },
  };
}

describe("inbound email body", () => {
  let runtime: any;
  let channelRuntime: any;

  beforeEach(() => {
    runtime = createRuntime();
    channelRuntime = createChannelRuntime();
  });

  it("delivers the whole body when it fits", async () => {
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onMail?.(mailEvent({ body: LONG_BODY, body_state: "complete" }));

    const body = bodyOf(channelRuntime);
    expect(body).toContain(LONG_BODY);
    expect(body.length).toBeGreaterThan(SNIPPET.length);
  });

  it("appends a truncation notice naming the message id", async () => {
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onMail?.(
      mailEvent({
        body: LONG_BODY,
        body_state: "truncated",
        body_truncated: true,
        body_total_chars: 40000,
        body_included_chars: LONG_BODY.length,
      }),
    );

    const body = bodyOf(channelRuntime);
    expect(body).toContain(LONG_BODY);
    expect(body).toContain("too long to deliver in full");
    expect(body).toContain(`${LONG_BODY.length} of 40000 characters`);
    expect(body).toContain("mail-in-1");
  });

  it("falls back to the snippet when the payload carries no body", async () => {
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onMail?.(mailEvent());

    expect(bodyOf(channelRuntime)).toContain(SNIPPET);
  });

  it("falls back to the snippet when the body is unavailable", async () => {
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onMail?.(mailEvent({ body: "", body_state: "unavailable" }));

    expect(bodyOf(channelRuntime)).toContain(SNIPPET);
  });
});
