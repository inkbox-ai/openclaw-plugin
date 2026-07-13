import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inkbox/sdk", () => ({ verifyWebhook: vi.fn(() => true) }));

vi.mock("openclaw/plugin-sdk/inbound-envelope", () => ({
  resolveInboundRouteEnvelopeBuilderWithRuntime: vi.fn(() => ({
    route: {
      agentId: "main",
      accountId: "default",
      sessionKey: "agent:main:inkbox:direct:spawned",
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
import { registerSendSms } from "../../src/tools/send-sms.js";
import {
  consumeSpawnLink,
  getActiveConversation,
  normalizeRecipientKey,
  recordSpawnFromActive,
  resetSpawnContextForTest,
  setActiveConversation,
} from "../../src/spawn-context.js";

const PARENT = {
  sessionKey: "agent:main:inkbox:direct:parent",
  replyTarget: "sms:parent-conv",
  label: "Dima",
  party: normalizeRecipientKey("+15551110000"),
};

function seedSpawnLink(recipient: string, why: string): void {
  setActiveConversation(PARENT);
  recordSpawnFromActive({ recipient, body: why });
  setActiveConversation(undefined);
}

function createRuntime() {
  return {
    getIdentity: vi.fn(async () => ({
      agentHandle: "smoke-agent",
      id: "identity-1",
      emailAddress: "smoke-agent@inkboxmail.com",
      mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
      sendText: vi.fn(async () => ({ id: "txt-reply" })),
      sendIMessage: vi.fn(async () => ({ id: "im-reply", conversationId: "imconv-1" })),
      sendEmail: vi.fn(async () => ({ id: "mail-reply" })),
      sendIMessageTyping: vi.fn(async () => undefined),
      listTextConversations: vi.fn(async () => []),
    })),
    getClient: vi.fn(async () => ({
      contacts: { lookup: vi.fn(async () => []) },
    })),
  };
}

function createChannelRuntime() {
  const dispatchReply = vi.fn(async () => undefined);
  return {
    inbound: { buildContext: vi.fn((input: any) => input), dispatchReply },
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

function inboundText(remote: string): any {
  return {
    id: "evt-txt-in",
    event_type: "text.received",
    timestamp: "2026-07-13T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: [],
      recipient_phone_number: null,
      text_message: {
        id: "txt-in-1",
        direction: "inbound",
        local_phone_number: "+16282028580",
        remote_phone_number: remote,
        sender_phone_number: remote,
        conversation_id: "conv-alex",
        text: "Sure, the launch is at 4pm.",
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
        created_at: "2026-07-13T00:00:00Z",
        updated_at: "2026-07-13T00:00:00Z",
      },
    },
  };
}

function runOf(channelRuntime: any) {
  return channelRuntime.inbound.dispatchReply.mock.calls[0][0];
}

describe("spin-off thread context (module)", () => {
  beforeEach(() => resetSpawnContextForTest());

  it("normalizes phone and email recipient keys", () => {
    expect(normalizeRecipientKey("+1 (555) 111-0000")).toBe("+15551110000");
    expect(normalizeRecipientKey("Alex@Example.com")).toBe("alex@example.com");
    expect(normalizeRecipientKey("   ")).toBeUndefined();
  });

  it("records a spawn link to a new recipient and consumes it once", () => {
    setActiveConversation(PARENT);
    recordSpawnFromActive({ recipient: "+15559999999", body: "Can you confirm the time?" });

    const link = consumeSpawnLink("+15559999999");
    expect(link).toMatchObject({
      parentSessionKey: PARENT.sessionKey,
      parentReplyTarget: PARENT.replyTarget,
      parentLabel: "Dima",
      why: "Can you confirm the time?",
    });
    // One-shot: a second consume finds nothing.
    expect(consumeSpawnLink("+15559999999")).toBeUndefined();
  });

  it("does not record a link when the recipient is the active conversation's own party", () => {
    setActiveConversation(PARENT);
    recordSpawnFromActive({ recipient: "+1 555 111 0000", body: "replying to you" });
    expect(consumeSpawnLink("+15551110000")).toBeUndefined();
  });

  it("does not record a link when there is no active conversation", () => {
    setActiveConversation(undefined);
    recordSpawnFromActive({ recipient: "+15559999999", body: "no parent" });
    expect(consumeSpawnLink("+15559999999")).toBeUndefined();
  });
});

describe("spin-off thread context (inbound reply)", () => {
  let runtime: any;
  let channelRuntime: any;

  beforeEach(() => {
    resetSpawnContextForTest();
    runtime = createRuntime();
    channelRuntime = createChannelRuntime();
  });

  it("inherits the parent when a spun-off recipient replies", async () => {
    seedSpawnLink("+15559999999", "Hey Alex, can you confirm the launch time?");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(inboundText("+15559999999"));

    const run = runOf(channelRuntime);
    const body = run.ctxPayload.message.bodyForAgent;
    expect(body).toContain("[inkbox:spinoff_thread");
    expect(body).toContain('parent="Dima"');
    expect(body).toContain("relay_to=sms:parent-conv");
    expect(body).toContain("Hey Alex, can you confirm the launch time?");
    // The reply's session inherits the parent's context.
    expect(run.ctxPayload.route.modelParentSessionKey).toBe(PARENT.sessionKey);
  });

  it("leaves an ordinary reply untouched when there is no spawn link", async () => {
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(inboundText("+15558888888"));

    const run = runOf(channelRuntime);
    expect(run.ctxPayload.message.bodyForAgent).not.toContain("spinoff_thread");
    expect(run.ctxPayload.route.modelParentSessionKey).toBeUndefined();
  });

  it("consumes the link so a later reply from the same person is ordinary", async () => {
    seedSpawnLink("+15559999999", "one-shot question");
    const bridge = createBridge(runtime, channelRuntime);

    await bridge.handlers.onText?.(inboundText("+15559999999"));
    await bridge.handlers.onText?.(inboundText("+15559999999"));

    const second = channelRuntime.inbound.dispatchReply.mock.calls[1][0];
    expect(second.ctxPayload.message.bodyForAgent).not.toContain("spinoff_thread");
    expect(second.ctxPayload.route.modelParentSessionKey).toBeUndefined();
  });
});

describe("spin-off thread context (send tool records the link)", () => {
  beforeEach(() => resetSpawnContextForTest());

  function registerTool() {
    let execute: ((id: string, params: any) => Promise<any>) | undefined;
    const api = { registerTool: (t: any) => { execute = t.execute; } };
    const runtime = createRuntime();
    registerSendSms(api as any, runtime as any);
    return (params: any) => execute!("call-1", params);
  }

  it("records a spawn link when the agent texts a new number mid-conversation", async () => {
    const run = registerTool();
    setActiveConversation(PARENT);
    await run({ to: "+15559999999", text: "Hey Alex, quick question." });
    setActiveConversation(undefined);

    const link = consumeSpawnLink("+15559999999");
    expect(link?.parentSessionKey).toBe(PARENT.sessionKey);
    expect(link?.why).toBe("Hey Alex, quick question.");
  });

  it("does not record a spawn link when texting the active party back", async () => {
    const run = registerTool();
    setActiveConversation(PARENT);
    await run({ to: "+15551110000", text: "replying to you directly" });
    setActiveConversation(undefined);

    expect(consumeSpawnLink("+15551110000")).toBeUndefined();
  });

  it("does not parent a group send (ambiguous which recipient is the spin-off)", async () => {
    const run = registerTool();
    setActiveConversation(PARENT);
    await run({ to: ["+15559999999", "+15557777777"], text: "group ping" });
    setActiveConversation(undefined);

    expect(consumeSpawnLink("+15559999999")).toBeUndefined();
    expect(consumeSpawnLink("+15557777777")).toBeUndefined();
  });

  it("clears the active conversation after a turn so idle sends are unparented", async () => {
    // Sanity: getActiveConversation reflects set/clear.
    setActiveConversation(PARENT);
    expect(getActiveConversation()).toEqual(PARENT);
    setActiveConversation(undefined);
    expect(getActiveConversation()).toBeUndefined();
  });
});
