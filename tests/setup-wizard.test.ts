import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenClawConfigBatch,
  persistOpenClawConfigFile,
  runSetupWizard,
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
  const mailboxesUpdate = vi.fn();
  const phoneNumbersUpdate = vi.fn();
  const Inkbox = vi.fn(() => ({
    whoami,
    listIdentities,
    getIdentity,
    createSigningKey,
    mailboxes: { update: mailboxesUpdate },
    phoneNumbers: { update: phoneNumbersUpdate },
  }));
  return {
    Inkbox,
    InkboxAPIError: MockInkboxAPIError,
    whoami,
    listIdentities,
    getIdentity,
    createSigningKey,
    mailboxesUpdate,
    phoneNumbersUpdate,
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
    mailbox: { emailAddress: "smoke-agent@inkboxmail.com" },
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
  sdk.mailboxesUpdate.mockReset();
  sdk.phoneNumbersUpdate.mockReset();
  sdk.mailboxesUpdate.mockResolvedValue({});
  sdk.phoneNumbersUpdate.mockResolvedValue({});
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
    const prompter = createPrompter({ confirms: [true] });
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
      },
      {
        currentConfig,
        env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" },
      },
    );
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
      confirms: [true, true, false, true],
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
    const prompter = createPrompter({ confirms: [false, true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(identity.listTexts).not.toHaveBeenCalled();
    expect(prompter.ask.mock.calls.map(([question]) => question)).not.toContain(
      "Owner phone number to wait for START opt-in (optional E.164, e.g. +15551234567)",
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

  it("routes an existing phone through the identity tunnel during setup", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [true] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test", INKBOX_SIGNING_KEY: "whsec_test" } as any,
    });

    expect(result.ok).toBe(true);
    expect(sdk.mailboxesUpdate).toHaveBeenCalledWith("smoke-agent@inkboxmail.com", {
      webhookUrl: "https://smoke-agent.inkboxwire.com/inkbox/webhook",
    });
    expect(sdk.phoneNumbersUpdate).toHaveBeenCalledWith("phone-1", {
      incomingTextWebhookUrl: "https://smoke-agent.inkboxwire.com/inkbox/webhook",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://smoke-agent.inkboxwire.com/inkbox/phone/media/ws",
      incomingCallWebhookUrl: null,
    });
  });
});
