import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenClawConfigBatch,
  configureAgentAvatar,
  persistOpenClawConfigFile,
  runSetupWizard,
  smsToQrPayload,
  validateOpenAiRealtimeApiKey,
} from "../src/setup-wizard.js";
import { inkboxClientOptions } from "../src/sdk-options.js";
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
  const sdkCreateIdentity = vi.fn();
  const apiKeysCreate = vi.fn();
  const createSigningKey = vi.fn();
  const signup = vi.fn();
  const verifySignup = vi.fn();
  const mailboxesUpdate = vi.fn();
  const phoneNumbersUpdate = vi.fn();
  const subscriptionsList = vi.fn();
  const subscriptionsCreate = vi.fn();
  const subscriptionsUpdate = vi.fn();
  const getTriageNumber = vi.fn();
  const Inkbox = Object.assign(
    vi.fn(() => ({
      whoami,
      listIdentities,
      getIdentity,
      createIdentity: sdkCreateIdentity,
      apiKeys: { create: apiKeysCreate },
      createSigningKey,
      mailboxes: { update: mailboxesUpdate },
      phoneNumbers: { update: phoneNumbersUpdate },
      imessages: { getTriageNumber },
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
    createIdentity: sdkCreateIdentity,
    apiKeysCreate,
    createSigningKey,
    signup,
    verifySignup,
    mailboxesUpdate,
    phoneNumbersUpdate,
    subscriptionsList,
    subscriptionsCreate,
    subscriptionsUpdate,
    getTriageNumber,
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
  selections?: string[];
} = {}): Prompter & {
  ask: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
} {
  const asks = [...(params.asks ?? [])];
  const confirms = [...(params.confirms ?? [])];
  const selections = [...(params.selections ?? [])];
  const confirm = vi.fn(async (_question: string, defaultYes?: boolean) =>
    confirms.length ? confirms.shift()! : Boolean(defaultYes),
  );
  return {
    ask: vi.fn(async () => asks.shift() ?? ""),
    pause: vi.fn(async () => undefined),
    confirm,
    select: vi.fn(async (_question: string, _options: any[], defaultValue?: string) => {
      if (selections.length) return selections.shift() as any;
      // Preserve the legacy tests' yes/no realtime answer while exercising
      // the new native three-option selector.
      const realtime = await confirm("Use OpenAI Realtime API for phone calls?", false);
      return (realtime ? "openai_realtime" : defaultValue ?? "inkbox_tts_stt") as any;
    }) as any,
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
    getIncomingCallAction: vi.fn(async () => ({
      agentIdentityId: "identity-1",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/calls",
      incomingCallWebhookUrl: null,
    })),
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
  sdk.createIdentity.mockReset();
  sdk.apiKeysCreate.mockReset();
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
  sdk.getTriageNumber.mockReset();
  sdk.getTriageNumber.mockResolvedValue({
    number: "+15550009999",
    connectCommand: "connect @your-handle",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("ok", { status: 200 })),
  );
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
  vi.unstubAllGlobals();
  await rm(tempHome, { recursive: true, force: true });
});

describe("runSetupWizard", () => {
  it("uses SMSTO payloads for setup QR codes", () => {
    expect(smsToQrPayload("+16614031457", "START")).toBe("SMSTO:+16614031457:START");
    expect(smsToQrPayload("+15550009999", "connect @smoke-agent")).toBe(
      "SMSTO:+15550009999:connect @smoke-agent",
    );
  });

  it("attaches the bundled avatar automatically for a newly created agent", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = createPrompter();

    await configureAgentAvatar({
      baseUrl: "https://inkbox.ai",
      apiKey: "ApiKey_test",
      identityHandle: "smoke-agent",
      isSignup: true,
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://inkbox.ai/api/v1/identities/smoke-agent/avatar",
      expect.objectContaining({
        method: "PUT",
        headers: { "X-API-Key": "ApiKey_test" },
      }),
    );
  });

  it("leaves an existing agent avatar alone", async () => {
    const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = createPrompter();

    await configureAgentAvatar({
      baseUrl: "https://inkbox.ai",
      apiKey: "ApiKey_test",
      identityHandle: "smoke-agent",
      isSignup: false,
      prompter,
    });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://inkbox.ai/api/v1/identities/smoke-agent/avatar",
      expect.objectContaining({ headers: { "X-API-Key": "ApiKey_test" } }),
    );
  });

  it("offers and uploads the bundled avatar for an existing agent without one", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("missing", { status: 404 }))
      .mockResolvedValueOnce(new Response("ok", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = createPrompter({ confirms: [true] });

    await configureAgentAvatar({
      baseUrl: "https://inkbox.ai",
      apiKey: "ApiKey_test",
      identityHandle: "smoke-agent",
      isSignup: false,
      prompter,
    });

    expect(prompter.confirm).toHaveBeenCalledWith("Add the OpenClaw avatar?", true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://inkbox.ai/api/v1/identities/smoke-agent/avatar",
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("does not upload the bundled avatar when an existing agent declines", async () => {
    const fetchMock = vi.fn(async () => new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const prompter = createPrompter({ confirms: [false] });

    await configureAgentAvatar({
      baseUrl: "https://inkbox.ai",
      apiKey: "ApiKey_test",
      identityHandle: "smoke-agent",
      isSignup: false,
      prompter,
    });

    expect(prompter.confirm).toHaveBeenCalledWith("Add the OpenClaw avatar?", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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
      {
        path: "plugins.entries.inkbox.hooks.allowConversationAccess",
        value: true,
      },
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
    expect(saved.plugins.entries.inkbox.hooks).toEqual({
      allowConversationAccess: true,
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
    // Keep the closing gateway step from shelling out to the host CLI.
    const runGatewayCommand = vi.fn(() => ({ code: 1, stdout: "", stderr: "" }));
    const currentConfig = { tools: { profile: "coding" } };

    const result = await runSetupWizard({
      prompter,
      currentConfig,
      persistConfig,
      runGatewayCommand,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.persisted).toBe(true);
    expect(persistConfig).toHaveBeenCalledWith(
      {
        apiKey: "ApiKey_test",
        identity: "smoke-agent",
        signingKey: "whsec_test",
        voiceStack: "inkbox_tts_stt",
        voicemailDetection: "enabled",
        voiceRealtime: disabledOpenAiRealtime,
      },
      {
        currentConfig,
        env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" },
      },
    );
  });

  it("lets an admin-scoped API key select an existing identity and mints an agent key", async () => {
    const firstIdentity = createIdentity({
      id: "identity-1",
      agentHandle: "first-agent",
      mailbox: { id: "mailbox-1", emailAddress: "first-agent@inkboxmail.com" },
      tunnel: { publicHost: "first-agent.inkboxwire.com" },
    });
    const selectedIdentity = createIdentity({
      id: "identity-2",
      agentHandle: "selected-agent",
      mailbox: { id: "mailbox-2", emailAddress: "selected-agent@inkboxmail.com" },
      phoneNumber: {
        id: "phone-2",
        number: "+15551230002",
        type: "local",
        smsStatus: "ready",
      },
      tunnel: { publicHost: "selected-agent.inkboxwire.com" },
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "admin",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([
      { agentHandle: "first-agent" },
      { agentHandle: "selected-agent" },
    ]);
    sdk.getIdentity.mockImplementation(async (handle: string) => {
      if (handle === "first-agent") return firstIdentity;
      if (handle === "selected-agent") return selectedIdentity;
      throw new Error(`unexpected identity ${handle}`);
    });
    sdk.apiKeysCreate.mockResolvedValue({ apiKey: "ApiKey_agent_selected" });
    const prompter = createPrompter({ asks: ["2"], confirms: [false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_admin", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config).toEqual(
      expect.objectContaining({
        apiKey: "ApiKey_agent_selected",
        identity: "selected-agent",
        signingKey: "whsec_test",
      }),
    );
    expect(sdk.apiKeysCreate).toHaveBeenCalledWith({
      scopedIdentityId: "identity-2",
      label: "openclaw-plugin-selected-agent",
    });
    expect(sdk.Inkbox).toHaveBeenNthCalledWith(1, inkboxClientOptions("ApiKey_admin", undefined));
    expect(sdk.Inkbox).toHaveBeenNthCalledWith(2, inkboxClientOptions("ApiKey_agent_selected", undefined));
  });

  it("lets an admin-scoped API key create an identity and mints an agent key", async () => {
    const createdIdentity = createIdentity({
      id: "identity-new",
      agentHandle: "new-agent",
      mailbox: { id: "mailbox-new", emailAddress: "new-agent@inkboxmail.com" },
      phoneNumber: null,
      tunnel: { publicHost: "new-agent.inkboxwire.com" },
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "admin",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([]);
    sdk.createIdentity.mockResolvedValue(createdIdentity);
    sdk.getIdentity.mockImplementation(async (handle: string) => {
      if (handle === "new-agent") return createdIdentity;
      throw new Error(`unexpected identity ${handle}`);
    });
    sdk.apiKeysCreate.mockResolvedValue({ apiKey: "ApiKey_agent_new" });
    const prompter = createPrompter({
      asks: ["new-agent", "New Agent"],
      confirms: [false, false, true],
    });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_admin", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config).toEqual(
      expect.objectContaining({
        apiKey: "ApiKey_agent_new",
        identity: "new-agent",
        signingKey: "whsec_test",
      }),
    );
    expect(sdk.createIdentity).toHaveBeenCalledWith("new-agent", {
      displayName: "New Agent",
    });
    expect(sdk.apiKeysCreate).toHaveBeenCalledWith({
      scopedIdentityId: "identity-new",
      label: "openclaw-plugin-new-agent",
    });
    expect(sdk.Inkbox).toHaveBeenNthCalledWith(2, inkboxClientOptions("ApiKey_agent_new", undefined));
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

  it("configures Inkbox Voice AI contact-scoped without requesting an admin credential", async () => {
    const setHostedAgentConfig = vi.fn(async () => ({}));
    const setIncomingCallAction = vi.fn(async () => ({}));
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => ({ authorityMode: "contact_scoped" })),
      setHostedAgentConfig,
      setIncomingCallAction,
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      selections: ["inkbox_voice_ai", "contact_scoped"],
      confirms: [true],
    });

    const result = await runSetupWizard({
      prompter,
      env: {
        INKBOX_API_KEY: "ApiKey_test",
        INKBOX_SIGNING_KEY: "whsec_test",
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(prompter.pause).toHaveBeenCalledWith(
      "Press Enter to continue and set up phone call handling",
    );
    expect(prompter.pause.mock.invocationCallOrder[0]).toBeLessThan(
      (prompter.select as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
    expect(result.config).toMatchObject({
      voiceStack: "inkbox_voice_ai",
      voiceAiAuthorityMode: "contact_scoped",
      voicemailDetection: "enabled",
    });
    expect(setHostedAgentConfig).toHaveBeenCalledWith({});
    expect(setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Paste an admin-scoped Inkbox API key for this authority change",
    );
  });

  it("uses an admin key to elevate Voice AI to YOLO without persisting that key", async () => {
    const setHostedAgentAuthorityMode = vi.fn(async () => ({}));
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => ({ authorityMode: "contact_scoped" })),
      setHostedAgentConfig: vi.fn(async () => ({})),
      setHostedAgentAuthorityMode,
      setIncomingCallAction: vi.fn(async () => ({})),
    });
    sdk.whoami
      .mockResolvedValueOnce({
        authType: "api_key",
        authSubtype: "agent_claimed",
        organizationId: "org-1",
      })
      .mockResolvedValueOnce({
        authType: "api_key",
        authSubtype: "admin",
        organizationId: "org-1",
      });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      asks: ["ApiKey_admin_ephemeral"],
      selections: ["inkbox_voice_ai", "yolo"],
      confirms: [true],
    });

    const result = await runSetupWizard({
      prompter,
      env: {
        INKBOX_API_KEY: "ApiKey_agent",
        INKBOX_SIGNING_KEY: "whsec_test",
      } as any,
    });

    expect(result.ok).toBe(true);
    expect(setHostedAgentAuthorityMode).toHaveBeenCalledWith({ authorityMode: "yolo" });
    expect(result.config).toMatchObject({
      apiKey: "ApiKey_agent",
      voiceStack: "inkbox_voice_ai",
      voiceAiAuthorityMode: "yolo",
    });
    expect(JSON.stringify(result.config)).not.toContain("ApiKey_admin_ephemeral");
  });

  it("restores the hosted config and keeps the local stack when Voice AI setup fails", async () => {
    const previous = {
      authorityMode: "contact_scoped",
      voice: "alloy",
      model: "voice-model",
      instructions: "Previous instructions",
    };
    const setHostedAgentConfig = vi.fn()
      .mockRejectedValueOnce(new Error("hosted config write failed"))
      .mockResolvedValueOnce(previous);
    const setIncomingCallAction = vi.fn(async () => ({}));
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => previous),
      setHostedAgentConfig,
      setIncomingCallAction,
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key", authSubtype: "agent_claimed", organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      selections: ["inkbox_voice_ai", "contact_scoped", "inkbox_tts_stt"],
      confirms: [true],
    });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceStack).toBe("inkbox_tts_stt");
    expect(setHostedAgentConfig.mock.calls).toEqual([
      [{}],
      [{ voice: "alloy", model: "voice-model", instructions: "Previous instructions" }],
    ]);
    expect(setIncomingCallAction).not.toHaveBeenCalledWith(
      expect.objectContaining({ incomingCallAction: "hosted_agent" }),
    );
  });

  it("restores authority, hosted config, and incoming routing after a later Voice AI failure", async () => {
    const previousHosted = {
      authorityMode: "contact_scoped", voice: null, model: null, instructions: null,
    };
    const previousIncoming = {
      agentIdentityId: "identity-1",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/calls",
      incomingCallWebhookUrl: null,
    };
    const setHostedAgentConfig = vi.fn(async () => previousHosted);
    const setHostedAgentAuthorityMode = vi.fn(async () => previousHosted);
    const setIncomingCallAction = vi.fn()
      .mockRejectedValueOnce(new Error("incoming route failed"))
      .mockResolvedValue({});
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => previousHosted),
      getIncomingCallAction: vi.fn(async () => previousIncoming),
      setHostedAgentConfig,
      setHostedAgentAuthorityMode,
      setIncomingCallAction,
    });
    sdk.whoami
      .mockResolvedValueOnce({
        authType: "api_key", authSubtype: "agent_claimed", organizationId: "org-1",
      })
      .mockResolvedValueOnce({
        authType: "api_key", authSubtype: "admin", organizationId: "org-1",
      });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      asks: ["ApiKey_admin_ephemeral"],
      selections: ["inkbox_voice_ai", "yolo", "inkbox_tts_stt"],
      confirms: [true],
    });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_agent", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceStack).toBe("inkbox_tts_stt");
    expect(setHostedAgentAuthorityMode.mock.calls).toEqual([
      [{ authorityMode: "yolo" }],
      [{ authorityMode: "contact_scoped" }],
    ]);
    expect(setHostedAgentConfig.mock.calls).toEqual([[{}], [{}]]);
    expect(setIncomingCallAction).toHaveBeenNthCalledWith(1, {
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
    expect(setIncomingCallAction).toHaveBeenNthCalledWith(2, {
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/calls",
    });
  });

  it("continues to the stack selector when rollback itself is incomplete", async () => {
    const setHostedAgentConfig = vi.fn(async () => {
      throw new Error("hosted config unavailable");
    });
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => ({ authorityMode: "contact_scoped" })),
      setHostedAgentConfig,
      setIncomingCallAction: vi.fn(async () => ({})),
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key", authSubtype: "agent_claimed", organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      selections: ["inkbox_voice_ai", "contact_scoped", "inkbox_tts_stt"],
      confirms: [true],
    });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(result.config?.voiceStack).toBe("inkbox_tts_stt");
    expect(setHostedAgentConfig).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.flat().join("\n")).toContain(
      "Could not fully restore the prior phone-call configuration",
    );
  });

  it("rolls Voice AI remote state back when the local config write fails later", async () => {
    const previousHosted = {
      authorityMode: "contact_scoped", voice: "sage", model: null, instructions: null,
    };
    const previousIncoming = {
      agentIdentityId: "identity-1",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://old.example/calls",
      incomingCallWebhookUrl: null,
    };
    const setHostedAgentConfig = vi.fn(async () => previousHosted);
    const setIncomingCallAction = vi.fn(async () => previousIncoming);
    const identity = createIdentity({
      getHostedAgentConfig: vi.fn(async () => previousHosted),
      getIncomingCallAction: vi.fn(async () => previousIncoming),
      setHostedAgentConfig,
      setIncomingCallAction,
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key", authSubtype: "agent_claimed", organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({
      selections: ["inkbox_voice_ai", "contact_scoped"],
      confirms: [true],
    });

    const result = await runSetupWizard({
      prompter,
      persistConfig: vi.fn(async () => ({ ok: false, message: "disk full" })),
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(false);
    expect(setIncomingCallAction.mock.calls).toEqual([
      [{ incomingCallAction: "hosted_agent", clientWebsocketUrl: null, incomingCallWebhookUrl: null }],
      [{ incomingCallAction: "auto_accept", clientWebsocketUrl: "wss://old.example/calls" }],
    ]);
    expect(setHostedAgentConfig.mock.calls).toEqual([[{}], [{ voice: "sage" }]]);
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
    const realtimeConfirms = prompter.confirm.mock.calls.filter(
      ([question]) => question === "Use OpenAI Realtime API for phone calls?",
    );
    expect(realtimeConfirms).toHaveLength(2);
    expect(realtimeConfirms.map(([, defaultYes]) => defaultYes)).toEqual([false, false]);
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
    // Keep the closing gateway step from shelling out to the host CLI.
    const runGatewayCommand = vi.fn(() => ({ code: 1, stdout: "", stderr: "" }));

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
      runGatewayCommand,
      env: {} as any,
    });

    expect(result.ok).toBe(true);
    expect(prompter.confirm.mock.calls.map(([question]) => question)).toContain(
      "Do you already have an Inkbox API key?",
    );
    expect(prompter.ask.mock.calls.map(([question]) => question)).toContain(
      "Paste your Inkbox API key (starts with ApiKey_)",
    );
    expect(sdk.Inkbox).toHaveBeenCalledWith(inkboxClientOptions("ApiKey_new", undefined));
    expect(persistConfig).toHaveBeenCalledWith(
      {
        apiKey: "ApiKey_new",
        identity: "smoke-agent",
        signingKey: "whsec_test",
        voiceStack: "inkbox_tts_stt",
        voicemailDetection: "enabled",
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
        harness: "openclaw",
        agentHandle: "new-agent",
        displayName: "New Agent",
      },
      {},
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
      {},
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
        id: filter.mailboxId ? "sub-mail" : filter.phoneNumberId ? "sub-text" : "sub-call",
        organizationId: "org-1",
        mailboxId: filter.mailboxId ?? null,
        phoneNumberId: filter.phoneNumberId ?? null,
        agentIdentityId: filter.agentIdentityId ?? null,
        url,
        eventTypes: filter.agentIdentityId
          ? ["call.ended"]
          : filter.mailboxId
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

  function createIMessageIdentity(overrides: Record<string, unknown> = {}) {
    const identity: any = createIdentity({
      imessageEnabled: false,
      listIMessageAssignments: vi.fn(async () => []),
      listIMessages: vi.fn(async () => []),
      sendIMessage: vi.fn(async () => ({ id: "im-1" })),
      markIMessageConversationRead: vi.fn(async () => ({
        conversationId: "imconv-123",
        updatedCount: 1,
      })),
      ...overrides,
    });
    identity.update = vi.fn(async (opts: any) => {
      if ("imessageEnabled" in opts) {
        identity.imessageEnabled = opts.imessageEnabled;
      }
    });
    return identity;
  }

  it("enables iMessage and creates the identity-owned subscription", async () => {
    const identity = createIMessageIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    // enable iMessage: yes, connect walkthrough: no, realtime: no,
    // keep existing signing key: yes
    const prompter = createPrompter({ confirms: [true, false, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(identity.update).toHaveBeenCalledWith({ imessageEnabled: true });
    expect(sdk.subscriptionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        agentIdentityId: "identity-1",
        eventTypes: [
          "imessage.received",
          "imessage.sent",
          "imessage.delivered",
          "imessage.delivery_failed",
          "imessage.reaction_received",
        ],
      }),
    );
  });

  it("walks through the iPhone connect flow and greets back on the new thread", async () => {
    const identity = createIMessageIdentity();
    identity.listIMessages = vi.fn(async () => [
      {
        id: "im-old",
        direction: "inbound",
        conversationId: "imconv-old",
        remoteNumber: "+15555550101",
        createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
      {
        id: "im-new",
        direction: "inbound",
        conversationId: "imconv-123",
        remoteNumber: "+15555550101",
        createdAt: new Date(Date.now() + 5000),
      },
    ]);
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    // enable iMessage: yes, connect walkthrough: yes, realtime: no,
    // keep existing signing key: yes
    const prompter = createPrompter({ confirms: [true, true, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(sdk.getTriageNumber).toHaveBeenCalled();
    // The stale message from a prior connection is skipped; the welcome
    // lands in the fresh conversation and is marked read.
    expect(identity.sendIMessage).toHaveBeenCalledTimes(1);
    const sent = identity.sendIMessage.mock.calls[0][0];
    expect(sent.conversationId).toBe("imconv-123");
    expect(sent.text).toContain("@smoke-agent");
    expect(identity.markIMessageConversationRead).toHaveBeenCalledWith("imconv-123");
  });

  it("leaves the identity untouched when iMessage is declined", async () => {
    const identity = createIMessageIdentity();
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
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(identity.update).not.toHaveBeenCalled();
    expect(sdk.subscriptionsCreate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        agentIdentityId: "identity-1",
        eventTypes: expect.arrayContaining(["imessage.received"]),
      }),
    );
  });

  it("defaults the connect walkthrough off when a phone is already connected", async () => {
    const identity = createIMessageIdentity({
      imessageEnabled: true,
      listIMessageAssignments: vi.fn(async () => [
        { id: "assign-1", remoteNumber: "+15555550101", status: "active" },
      ]),
    });
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    // Only the realtime decline is scripted; the connect prompt falls back
    // to its default, which must be "no" when a connection already exists.
    const prompter = createPrompter({ confirms: [false] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(prompter.confirm.mock.calls).toContainEqual([
      "Connect another iPhone to this agent now?",
      false,
    ]);
    expect(identity.listIMessages).not.toHaveBeenCalled();
  });

  it("prefers the identity-scoped incoming-call config during delivery setup", async () => {
    const setIncomingCallAction = vi.fn(async () => ({}));
    const identity = createIdentity({ setIncomingCallAction });
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
    expect(setIncomingCallAction).toHaveBeenCalledWith({
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://smoke-agent.inkboxwire.com/inkbox/phone/media/ws",
      incomingCallWebhookUrl: null,
    });
    // The number-scoped legacy shim must not run when the identity-scoped
    // surface exists.
    expect(sdk.phoneNumbersUpdate).not.toHaveBeenCalled();
  });

  it("walks iMessage before the dedicated-number step", async () => {
    const identity = createIMessageIdentity({ phoneNumber: null });
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
      { direction: "inbound", text: "START", remotePhoneNumber: "+15550001111" },
    ]);
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    // enable iMessage: yes, connect walkthrough: no, provision number: yes,
    // realtime: no, keep existing signing key: yes
    const prompter = createPrompter({ confirms: [true, false, true, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    const questions = prompter.confirm.mock.calls.map(([question]) => String(question));
    const imessageIdx = questions.indexOf("Enable iMessage for this agent?");
    const phoneIdx = questions.indexOf("Provision a dedicated phone number now?");
    expect(imessageIdx).toBeGreaterThanOrEqual(0);
    expect(phoneIdx).toBeGreaterThan(imessageIdx);
    expect(identity.provisionPhoneNumber).toHaveBeenCalledWith({ type: "local" });
  });

  it("prints the existing number instead of prompting when one is provisioned", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const log = vi.spyOn(console, "log");
    const prompter = createPrompter({ confirms: [false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(log.mock.calls.flat().join("\n")).toContain("Already provisioned: +15551234567");
    expect(prompter.confirm.mock.calls.map(([question]) => question)).not.toContain(
      "Provision a dedicated phone number now?",
    );
    log.mockRestore();
  });

  it("points at paid tiers and keeps going when provisioning is refused", async () => {
    const identity = createIdentity({ phoneNumber: null });
    identity.provisionPhoneNumber.mockRejectedValue(
      new sdk.InkboxAPIError(403, "phone provisioning requires a paid plan"),
    );
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const log = vi.spyOn(console, "log");
    const prompter = createPrompter({ confirms: [true, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Dedicated phone numbers are available on Inkbox paid tiers —");
    expect(output).toContain("see https://inkbox.ai/pricing for details.");
    expect(output).toContain("phone provisioning requires a paid plan");
    log.mockRestore();
  });

  it("offers realtime calling for an iMessage-only identity", async () => {
    const identity = createIMessageIdentity({ phoneNumber: null, imessageEnabled: true });
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    // connect walkthrough: no, provision number: no, realtime: no,
    // keep existing signing key: yes
    const prompter = createPrompter({ confirms: [false, false, false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    // No dedicated number, but the shared iMessage line can take calls — the
    // realtime opt-in must still be offered.
    expect((prompter.select as any).mock.calls.map(([question]: [string]) => question)).toContain(
      "Choose how this agent should handle phone calls",
    );
    expect(result.config?.voiceRealtime).toEqual(
      expect.objectContaining({ enabled: false }),
    );
  });
});
