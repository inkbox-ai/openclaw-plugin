import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSetupWizard } from "../src/setup-wizard.js";
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
  const Inkbox = vi.fn(() => ({ whoami, listIdentities, getIdentity, createSigningKey }));
  return { Inkbox, InkboxAPIError: MockInkboxAPIError, whoami, listIdentities, getIdentity, createSigningKey };
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
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("runSetupWizard", () => {
  it("does not wait for START when the identity already had a phone number", async () => {
    const identity = createIdentity();
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "agent_claimed",
      organizationId: "org-1",
    });
    sdk.listIdentities.mockResolvedValue([{ agentHandle: "smoke-agent" }]);
    sdk.getIdentity.mockResolvedValue(identity);
    const prompter = createPrompter({ confirms: [false, false] });

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
    const prompter = createPrompter({ asks: [""], confirms: [true, false, false] });

    const result = await runSetupWizard({
      prompter,
      env: { INKBOX_API_KEY: "ApiKey_test" } as any,
    });

    expect(result).toEqual({
      ok: true,
      config: {
        apiKey: "ApiKey_test",
        identity: "smoke-agent",
      },
    });
    expect(identity.provisionPhoneNumber).toHaveBeenCalledWith({ type: "local" });
  });
});
