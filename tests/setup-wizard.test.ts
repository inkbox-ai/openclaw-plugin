import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenClawConfigBatch,
  persistOpenClawConfigFile,
  runSetupWizard,
  validateOpenAiRealtimeApiKey,
} from "../src/setup-wizard.js";
import type { Prompter } from "../src/prompt.js";

const sdk = vi.hoisted(() => {
  class MockInkboxAPIError extends Error {
    statusCode: number;
    detail: unknown;

    constructor(statusCode: number, detail: unknown) {
      super(typeof detail === "string" ? detail : JSON.stringify(detail));
      this.statusCode = statusCode;
      this.detail = detail;
    }
  }

  const whoami = vi.fn();
  const listIdentities = vi.fn();
  const getIdentity = vi.fn();
  const createSigningKey = vi.fn();
  const signup = vi.fn();
  const verifySignup = vi.fn();
  const mailboxesUpdate = vi.fn();
  const phoneNumbersUpdate = vi.fn();
  const subscriptionsList = vi.fn();
  const subscriptionsCreate = vi.fn();
  const subscriptionsUpdate = vi.fn();
  const Inkbox = Object.assign(
    vi.fn(() => ({
      whoami,
      listIdentities,
      getIdentity,
      createSigningKey,
      mailboxes: { update: mailboxesUpdate },
      phoneNumbers: { update: phoneNumbersUpdate },
      webhooks: {
        subscriptions: {
          list: subscriptionsList,
          create: subscriptionsCreate,
          update: subscriptionsUpdate,
        },
      },
    })),
    {
      signup,
      verifySignup,
    },
  );
  return {
    Inkbox,
    InkboxAPIError: MockInkboxAPIError,
    whoami,
    listIdentities,
    getIdentity,
    createSigningKey,
    signup,
    verifySignup,
    mailboxesUpdate,
    phoneNumbersUpdate,
    subscriptionsList,
    subscriptionsCreate,
    subscriptionsUpdate,
  };
});

vi.mock("@inkbox/sdk", () => ({
  Inkbox: sdk.Inkbox,
  InkboxAPIError: sdk.InkboxAPIError,
  AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED: "admin",
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED: "agent_claimed",
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED: "agent_unclaimed",
}));

let tempHome: string;

const disabledOpenAiRealtime = {
  enabled: false,
  provider: "openai",
  model: "gpt-realtime-2",
  voice: "cedar",
  toolPolicy: "owner",
  consultPolicy: "substantive",
  fallbackToInkboxSttTts: true,
} as const;

function enabledOpenAiRealtime(apiKey: string) {
  return {
    ...disabledOpenAiRealtime,
    enabled: true,
    providers: {
      openai: {
        apiKey,
        model: "gpt-realtime-2",
        voice: "cedar",
      },
    },
  } as const;
}

function createPrompter(params: {
  asks?: string[];
  confirms?: boolean[];
} = {}): Prompter & { ask: ReturnType<typeof vi.fn>; confirm: ReturnType<typeof vi.fn> } {
  const asks = [...(params.asks ?? [])];
  const confirms = [...(params.confirms ?? [])];
  return {
    ask: vi.fn(async () => asks.shift() ?? ""),
    confirm: vi.fn(async (_question: string, defaultYes?: boolean) =>
      confirms.length ? confirms.shift()! : Boolean(defaultYes),
    ),
    close: vi.fn(),
  };
}

function createIdentity(overrides: Record<string, unknown> = {}) {
  const identity: any = {
    id: "identity-1",
    agentHandle: "smoke-agent",
    displayName: "Smoke Agent",
    emailAddress: "smoke-agent@inkboxmail.com",
    mailbox: { id: "mailbox-1", emailAddress: "smoke-agent@inkboxmail.com" },
    phoneNumber: {
      id: "phone-1",
      number: "+15551234567",
      type: "local",
      smsStatus: "ready",
    },
    tunnel: { publicHost: "smoke-agent.inkboxwire.com" },
    refresh: vi.fn(async () => identity),
    provisionPhoneNumber: vi.fn(),
    listTexts: vi.fn(),
    ...overrides,
  };
  return identity;
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-setup-test-"));
  vi.stubEnv("HOME", tempHome);
  sdk.Inkbox.mockClear();
  sdk.whoami.mockReset();
  sdk.listIdentities.mockReset();
  sdk.getIdentity.mockReset();
  sdk.createSigningKey.mockReset();
  sdk.createSigningKey.mockResolvedValue({ signingKey: "whsec_test" });
  sdk.signup.mockReset();
  sdk.verifySignup.mockReset();
  sdk.mailboxesUpdate.mockReset();
  sdk.phoneNumbersUpdate.mockReset();
  sdk.mailboxesUpdate.mockResolvedValue({});
  sdk.phoneNumbersUpdate.mockResolvedValue({});
  sdk.subscriptionsList.mockReset();
  sdk.subscriptionsCreate.mockReset();
  sdk.subscriptionsUpdate.mockReset();
  sdk.subscriptionsList.mockResolvedValue([]);
  sdk.subscriptionsCreate.mockImplementation(async (opts: any) => ({
    id: "sub-stub",
    organizationId: "org-1",
    mailboxId: opts.mailboxId ?? null,
    phoneNumberId: opts.phoneNumberId ?? null,
    url: opts.url,
    eventTypes: opts.eventTypes,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  sdk.subscriptionsUpdate.mockResolvedValue({});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("runSetupWizard", () => {
  it("builds an OpenClaw config batch for channel config and tool access", () => {
    expect(
      buildOpenClawConfigBatch(
        {
          apiKey: "ApiKey_test",
          identity: "smoke-agent",
          signingKey: "whsec_test",
        },
        {
          tools: {
            profile: "coding",
          },
        },
      ),
    ).toEqual([
      { path: "channels.inkbox.enabled", value: true },
      { path: "channels.inkbox.apiKey", value: "ApiKey_test" },
      { path: "channels.inkbox.identity", value: "smoke-agent" },
      { path: "channels.inkbox.signingKey", value: "whsec_test" },
      { path: "tools.alsoAllow", value: ["inkbox"] },
    ]);
  });

  it("writes explicit realtime call overrides when provided", () => {
    expect(
      buildOpenClawConfigBatch(
        {
          apiKey: "ApiKey_test",
          identity: "smoke-agent",
          voiceRealtime: {
            enabled: false,
            provider: "google",
            model: "custom-realtime",
            toolPolicy: "owner",
            consultPolicy: "substantive",
            fallbackToInkboxSttTts: false,
          },
        },
        {
          channels: {
            inkbox: {},
          },
        },
      ),
    ).toContainEqual({
      path: "channels.inkbox.voiceRealtime",
      value: {
        enabled: false,
        provider: "google",
        model: "custom-realtime",
        toolPolicy: "owner",
        consultPolicy: "substantive",
        fallbackToInkboxSttTts: false,
      },
    });
  });

  it("merges Inkbox into an existing tools.allow array", () => {
    expect(
      buildOpenClawConfigBatch(
        {
          apiKey: "ApiKey_test",
          identity: "smoke-agent",
        },
        {
          tools: {
            allow: ["fs"],
          },
        },
      ).at(-1),
    ).toEqual({ path: "tools.allow", value: ["fs", "inkbox"] });
  });

  it("persists channel config directly to the active OpenClaw config file", async () => {
    const configPath = join(tempHome, "profile", "openclaw.json");
    await mkdir(join(tempHome, "profile"), { recursive: true });
    await writeFile(
      configPath,
      `{
        // JSON5 config should be readable.
        tools: { profile: "coding" }
      }\n`,
    );

    const result = await persistOpenClawConfigFile(
      {
        apiKey: "ApiKey_test",
        identity: "smoke-agent",
        signingKey: "whsec_test",
      },
      {
        env: { HOME: tempHome, OPENCLAW_CONFIG_PATH: configPath } as any,
      },
    );

    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    expect(saved.channels.inkbox).toEqual({
      enabled: true,
      apiKey: "ApiKey_test",
      identity: "smoke-agent",
      signingKey: "whsec_test",
    });
    expect(saved.tools).toEqual({
      profile: "coding",
      alsoAllow: ["inkbox"],
    });
  });

  it("persists setup output when a config persister is supplied", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [false, true] });
    const persistConfig = vi.fn(async () => ({ ok: true }));
    const currentConfig = { tools: { profile: "coding" } };

    const result = await runSetupWizard({
      prompter,
      currentConfig,
      persistConfig,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
    expect(persistConfig).toHaveBeenCalledWith(
      {
        apiKey: "ApiKey_test",
        identity: "smoke-agent",
        signingKey: "whsec_test",
        voiceRealtime: disabledOpenAiRealtime,
      },
      {
        currentConfig,
        env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" },
      },
    );
  });

  it("uses and stores an OpenClaw OpenAI API-key auth profile for realtime calls", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const authDir = join(tempHome, ".openclaw", "agents", "main", "agent");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      join(authDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            key: "sk-profile",
          },
          "openai-codex:default": {
            type: "oauth",
            provider: "openai-codex",
            token: "codex-token",
          },
        },
      }),
    );
    const prompter = createPrompter({ confirms: [true, true] });
    const validateOpenAiRealtimeApiKey = vi.fn(async () => ({ ok: true as const }));
    const currentConfig = {
      auth: {
        order: { openai: ["openai:default"] },
        profiles: {
          "openai:default": { provider: "openai", mode: "api_key" },
          "openai-codex:default": { provider: "openai-codex", mode: "oauth" },
        },
      },
    };

    const result = await runSetupWizard({
      prompter,
      currentConfig,
      validateOpenAiRealtimeApiKey,
      env: {
        HOME: tempHome,
        INKBOX_API_KEY: "ApiKey_test",
        INKBOX_SIGNING_KEY: "whsec_test",
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceRealtime).toEqual(enabledOpenAiRealtime("sk-profile"));
    expect(validateOpenAiRealtimeApiKey).toHaveBeenCalledWith("sk-profile", "gpt-realtime-2");
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Paste your OpenAI API key for Realtime calls",
    );
  });

  it("prefers the plugin-specific OpenAI realtime env key over OPENAI_API_KEY", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [true, true] });
    const validateOpenAiRealtimeApiKey = vi.fn(async () => ({ ok: true as const }));

    const result = await runSetupWizard({
      prompter,
      validateOpenAiRealtimeApiKey,
      env: {
        INKBOX_API_KEY: "ApiKey_test",
        INKBOX_SIGNING_KEY: "whsec_test",
        INKBOX_REALTIME_API_KEY: "sk-realtime",
        OPENAI_API_KEY: "sk-openai",
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceRealtime).toEqual(enabledOpenAiRealtime("sk-realtime"));
    expect(validateOpenAiRealtimeApiKey).toHaveBeenCalledWith("sk-realtime", "gpt-realtime-2");
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Paste your OpenAI API key for Realtime calls",
    );
  });

  it("re-asks the realtime opt-in question after a failed OpenAI key validation", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      asks: ["sk-bad", "sk-good"],
      confirms: [true, true, true],
    });
    const validateOpenAiRealtimeApiKey = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, message: "invalid_api_key: sk-bad" })
      .mockResolvedValueOnce({ ok: true });

    const result = await runSetupWizard({
      prompter,
      validateOpenAiRealtimeApiKey,
      env: {
        INKBOX_API_KEY: "ApiKey_test",
        INKBOX_SIGNING_KEY: "whsec_test",
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceRealtime).toEqual(enabledOpenAiRealtime("sk-good"));
    expect(validateOpenAiRealtimeApiKey).toHaveBeenNthCalledWith(
      1,
      "sk-bad",
      "gpt-realtime-2",
    );
    expect(validateOpenAiRealtimeApiKey).toHaveBeenNthCalledWith(
      2,
      "sk-good",
      "gpt-realtime-2",
    );
    expect(
      prompter.confirm.mock.calls.filter(
        ([question]) => question === "Use OpenAI Realtime API for phone calls?",
      ),
    ).toHaveLength(2);
  });

  it("validates OpenAI realtime access with the GA client-secret payload shape", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ value: "ek-test" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(validateOpenAiRealtimeApiKey("sk-test", "gpt-realtime-2")).resolves.toEqual({
      ok: true,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/realtime/client_secrets",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer sk-test",
          "Content-Type": "application/json",
        },
      }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual({
      expires_after: { anchor: "created_at", seconds: 60 },
      session: { type: "realtime", model: "gpt-realtime-2" },
    });
  });

  it("starts the full setup flow again when reconfiguring an existing profile", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      asks: ["ApiKey_new"],
      confirms: [true, true, false, false, true],
    });
    const persistConfig = vi.fn(async () => ({ ok: true }));

    const result = await runSetupWizard({
      prompter,
      currentConfig: {
        channels: {
          inkbox: {
            apiKey: "ApiKey_old",
            identity: "human-agent",
            signingKey: "whsec_old",
          },
        },
      },
      persistConfig,
      env: {} as any,
    });

    expect(result.ok).toBe(true);
    expect(prompter.confirm.mock.calls.map(([question]) => question)).toContain(
      "Do you already have an Inkbox API key?",
    );
    expect(prompter.ask.mock.calls.map(([question]) => question)).toContain(
      "Paste your Inkbox API key (starts with ApiKey_)",
    );
    expect(sdk.Inkbox).toHaveBeenCalledWith({ apiKey: "ApiKey_new", baseUrl: undefined });
    expect(persistConfig).toHaveBeenCalledWith(
      {
        apiKey: "ApiKey_new",
        identity: "smoke-agent",
        signingKey: "whsec_test",
        voiceRealtime: disabledOpenAiRealtime,
      },
      {
        currentConfig: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_old",
              identity: "human-agent",
              signingKey: "whsec_old",
            },
          },
        },
        env: {},
      },
    );
  });

  it("does not wait for START when the identity already had a phone number", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [false, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(identity.listTexts).not.toHaveBeenCalled();
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Owner phone number that must text START (E.164, e.g. +15551234567)",
    );
  });

  it("continues setup when phone provisioning fails", async () => {
    const identity = createIdentity({ phoneNumber: null });
    identity.provisionPhoneNumber.mockRejectedValue(new sdk.InkboxAPIError(403, "not allowed"));
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ asks: [""], confirms: [true, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test" } as any,
    });

    expect(result).toEqual({
      ok: true,
      persisted: false,
      config: {
        apiKey: "ApiKey_test",
        identity: "smoke-agent",
        signingKey: "whsec_test",
      },
    });
    expect(identity.provisionPhoneNumber).toHaveBeenCalledWith({ type: "local" });
  });

  it("provisions a phone without a state or owner prompt and waits for any START opt-in", async () => {
    const identity = createIdentity({ phoneNumber: null });
    const provisionedPhone = {
      id: "phone-2",
      number: "+15559876543",
      type: "local",
      smsStatus: "ready",
    };
    identity.provisionPhoneNumber.mockImplementation(async () => {
      identity.phoneNumber = provisionedPhone;
      return provisionedPhone;
    });
    identity.listTexts.mockResolvedValue([
      {
        direction: "inbound",
        text: "START",
        remotePhoneNumber: "+15167251294",
      },
    ]);
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      confirms: [true, false, false, true],
    });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(identity.provisionPhoneNumber).toHaveBeenCalledWith({ type: "local" });
    expect(identity.listTexts).toHaveBeenCalledWith({ limit: 25 });
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Owner phone number that must text START (E.164, e.g. +15551234567)",
    );
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "US state for the local number (optional, e.g. NY)",
    );
    expect(prompter.confirm.mock.calls.map(([question]) => question)).not.toContain(
      "Wait up to 5 minutes for that recipient to text START to this Inkbox number?",
    );
  });

  it("hardcodes the self-signup verification email note", async () => {
    const identity = createIdentity({
      agentHandle: "new-agent",
      emailAddress: "new-agent@inkboxmail.com",
      mailbox: { emailAddress: "new-agent@inkboxmail.com" },
      tunnel: { publicHost: "new-agent.inkboxwire.com" },
    });
    sdk.signup.mockResolvedValue({
      apiKey: "ApiKey_signup",
      agentHandle: "new-agent",
      emailAddress: "new-agent@inkboxmail.com",
      message: "Check your email.",
    });
    sdk.verifySignup.mockResolvedValue({});
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      asks: ["dima@example.com", "new-agent", "New Agent", "", "123456"],
      confirms: [false],
    });

    const result = await runSetupWizard({
      prompter,
      env: {} as any,
    });

    expect(result.ok).toBe(true);
    expect(sdk.signup).toHaveBeenCalledWith(
      {
        humanEmail: "dima@example.com",
        noteToHuman: "OpenClaw Inkbox plugin setup",
        agentHandle: "new-agent",
        displayName: "New Agent",
      },
      { baseUrl: undefined },
    );
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Verification email note",
    );
    expect(
      prompter.ask.mock.calls.some(([question]) => String(question).includes("leave blank")),
    ).toBe(false);
    expect(prompter.ask.mock.calls.map(([question]) => question)).toContain(
      "Verification code from email",
    );
    expect(sdk.verifySignup).toHaveBeenCalledWith(
      "ApiKey_signup",
      { verificationCode: "123456" },
      { baseUrl: undefined },
    );
  });

  it("routes an existing phone through the identity tunnel during setup", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(sdk.subscriptionsCreate).toHaveBeenCalledWith({
      mailboxId: "mailbox-1",
      url: "https://smoke-agent.inkboxwire.com/inkbox/webhook",
      eventTypes: [
        "message.received",
        "message.sent",
        "message.forwarded",
        "message.delivered",
        "message.bounced",
        "message.failed",
      ],
    });
    expect(sdk.subscriptionsCreate).toHaveBeenCalledWith({
      phoneNumberId: "phone-1",
      url: "https://smoke-agent.inkboxwire.com/inkbox/webhook",
      eventTypes: [
        "text.received",
        "text.sent",
        "text.delivered",
        "text.delivery_failed",
        "text.delivery_unconfirmed",
      ],
    });
    expect(sdk.phoneNumbersUpdate).toHaveBeenCalledWith("phone-1", {
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://smoke-agent.inkboxwire.com/inkbox/phone/media/ws",
      incomingCallWebhookUrl: null,
    });
    expect(sdk.mailboxesUpdate).not.toHaveBeenCalled();
  });

  it("reconciles existing subscriptions without re-creating on second setup", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const url = "https://smoke-agent.inkboxwire.com/inkbox/webhook";
    sdk.subscriptionsList.mockImplementation(async (filter: any) => [
      {
        id: filter.mailboxId ? "sub-mail" : "sub-text",
        organizationId: "org-1",
        mailboxId: filter.mailboxId ?? null,
        phoneNumberId: filter.phoneNumberId ?? null,
        url,
        eventTypes: filter.mailboxId
          ? [
              "message.received",
              "message.sent",
              "message.forwarded",
              "message.delivered",
              "message.bounced",
              "message.failed",
            ]
          : [
              "text.received",
              "text.sent",
              "text.delivered",
              "text.delivery_failed",
              "text.delivery_unconfirmed",
            ],
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);
    const prompter = createPrompter({ confirms: [false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(sdk.subscriptionsCreate).not.toHaveBeenCalled();
    expect(sdk.subscriptionsUpdate).not.toHaveBeenCalled();
  });
});
