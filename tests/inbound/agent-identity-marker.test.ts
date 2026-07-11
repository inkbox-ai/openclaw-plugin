import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inkbox/sdk", () => ({ verifyWebhook: vi.fn(() => true) }));

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
  resolveRealtimeVoiceAgentConsultToolPolicy: vi.fn((v: any, f: any) => v ?? f),
  resolveRealtimeVoiceAgentConsultTools: vi.fn(() => []),
  resolveConfiguredRealtimeVoiceProvider: vi.fn(() => {
    throw new Error("realtime voice not configured in this test");
  }),
  createRealtimeVoiceBridgeSession: vi.fn(),
}));

import { createInkboxSessionBridge } from "../../src/inbound/session.js";

function createRuntime(options: { contactMatch?: any } = {}) {
  const runtime = {
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
      contacts: {
        lookup: vi.fn(async () => (options.contactMatch ? [options.contactMatch] : [])),
      },
    })),
  };
  return runtime;
}

function createChannelRuntime() {
  const dispatchReply = vi.fn(async () => undefined);
  return {
    inbound: {
      buildContext: vi.fn((input: any) => input),
      dispatchReply,
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

const AGENT_IDENTITY = {
  id: "agent-42",
  agent_handle: "atlas-agent",
  display_name: "Atlas",
};

function textEvent(agentIdentities: any[], remote = "+15551234567"): any {
  return {
    id: "evt-txt-1",
    event_type: "text.received",
    timestamp: "2026-07-11T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: agentIdentities,
      recipient_phone_number: null,
      text_message: {
        id: "txt-in-1",
        direction: "inbound",
        local_phone_number: "+16282028580",
        remote_phone_number: remote,
        sender_phone_number: remote,
        conversation_id: "conv-1",
        text: "Hey from another agent.",
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
        created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z",
      },
    },
  };
}

function imessageEvent(agentIdentities: any[]): any {
  return {
    id: "evt-im-1",
    event_type: "imessage.received",
    timestamp: "2026-07-11T00:00:00Z",
    data: {
      contacts: [],
      agent_identities: agentIdentities,
      reaction: null,
      message: {
        id: "im-in-1",
        conversation_id: "imconv-1",
        assignment_id: "assign-1",
        direction: "inbound",
        remote_number: "+15551234567",
        content: "iMessage from another agent.",
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
        created_at: "2026-07-11T00:00:00Z",
        updated_at: "2026-07-11T00:00:00Z",
      },
    },
  };
}

function mailEvent(agentIdentities: any[], from = "atlas@inkboxmail.com"): any {
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
        from_address: from,
        to_addresses: ["smoke-agent@inkboxmail.com"],
        cc_addresses: null,
        bcc_addresses: null,
        subject: "Coordinating",
        snippet: "Email from another agent.",
        direction: "inbound",
        status: "received",
        has_attachments: false,
        created_at: "2026-07-11T00:00:00Z",
      },
      contacts: [],
      agent_identities: agentIdentities,
    },
  };
}

describe("inbound sender marker for a recognized agent identity", () => {
  let runtime: any;
  let channelRuntime: any;

  beforeEach(() => {
    runtime = createRuntime();
    channelRuntime = createChannelRuntime();
  });

  it("renders an SMS sender's single agent identity instead of unknown_in_inkbox", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onText?.(textEvent([AGENT_IDENTITY]));

    const body = bodyOf(channelRuntime);
    expect(body).not.toContain("unknown_in_inkbox");
    expect(body).toContain("contact_agent_identity_id=agent-42");
    expect(body).toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain('contact_name="Atlas"');
  });

  it("renders an iMessage sender's agent identity", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onIMessage?.(imessageEvent([AGENT_IDENTITY]));

    const body = bodyOf(channelRuntime);
    expect(body).not.toContain("unknown_in_inkbox");
    expect(body).toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain('contact_name="Atlas"');
  });

  it("renders an email sender's from-bucket agent identity", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onMail?.(
      mailEvent([{ ...AGENT_IDENTITY, bucket: "from", address: "atlas@inkboxmail.com" }]),
    );

    const body = bodyOf(channelRuntime);
    expect(body).not.toContain("unknown_in_inkbox");
    expect(body).toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain('contact_name="Atlas"');
  });

  it("ignores an email agent identity resolved in a non-sender bucket", async () => {
    // The identity here matches a recipient (`to`), not the sender, so it must
    // not be surfaced as the sender.
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onMail?.(
      mailEvent([{ ...AGENT_IDENTITY, bucket: "to", address: "smoke-agent@inkboxmail.com" }]),
    );

    const body = bodyOf(channelRuntime);
    expect(body).not.toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain("contact=unknown_in_inkbox");
  });

  it("still renders unknown_in_inkbox when no contact and no agent identity resolve", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onText?.(textEvent([]));

    expect(bodyOf(channelRuntime)).toContain("contact=unknown_in_inkbox");
  });

  it("prefers an address-book contact over an agent identity", async () => {
    runtime = createRuntime({
      contactMatch: { id: "contact-9", preferredName: "Dima" },
    });
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onText?.(textEvent([AGENT_IDENTITY]));

    const body = bodyOf(channelRuntime);
    expect(body).toContain("contact_id=contact-9");
    expect(body).toContain('contact_name="Dima"');
    expect(body).not.toContain("contact_agent_handle");
  });

  it("does not surface a single sender marker when multiple identities resolve (group)", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onText?.(
      textEvent([
        AGENT_IDENTITY,
        { id: "agent-43", agent_handle: "nova-agent", display_name: "Nova" },
      ]),
    );

    const body = bodyOf(channelRuntime);
    // Two identities => group; no single-sender agent marker.
    expect(body).not.toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain("contact=unknown_in_inkbox");
  });

  it("does not surface an iMessage sender marker when two identities resolve", async () => {
    // iMessage has no group split, so this directly exercises the exactly-one
    // rule: two resolved identities must not collapse to the first one.
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onIMessage?.(
      imessageEvent([
        AGENT_IDENTITY,
        { id: "agent-43", agent_handle: "nova-agent", display_name: "Nova" },
      ]),
    );

    const body = bodyOf(channelRuntime);
    expect(body).not.toContain("contact_agent_handle=atlas-agent");
    expect(body).toContain("contact=unknown_in_inkbox");
  });

  it("omits an agent-identity handle whose id is missing", async () => {
    const bridge = createBridge(runtime, channelRuntime);
    await bridge.handlers.onText?.(
      textEvent([{ agent_handle: "no-id-agent", display_name: "No Id" }]),
    );

    // No usable id => not a resolved identity => unchanged fallback.
    expect(bodyOf(channelRuntime)).toContain("contact=unknown_in_inkbox");
  });
});
