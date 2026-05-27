import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectInkboxHealthFindings } from "../src/health.js";

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
  const getIdentity = vi.fn();
  const Inkbox = vi.fn(() => ({ whoami, getIdentity }));
  return { Inkbox, InkboxAPIError: MockInkboxAPIError, whoami, getIdentity };
});

vi.mock("@inkbox/sdk", () => ({
  Inkbox: sdk.Inkbox,
  InkboxAPIError: sdk.InkboxAPIError,
}));

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-health-test-"));
  vi.stubEnv("HOME", tempHome);
  sdk.Inkbox.mockClear();
  sdk.whoami.mockReset();
  sdk.getIdentity.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

function ids(findings: readonly { checkId: string }[]): string[] {
  return findings.map((finding) => finding.checkId);
}

describe("detectInkboxHealthFindings", () => {
  it("reports missing required config without calling the SDK", async () => {
    const findings = await detectInkboxHealthFindings(
      { cfg: { channels: { inkbox: {} } } as any },
      {},
    );

    expect(ids(findings)).toEqual([
      "inkbox/config-missing-api-key",
      "inkbox/config-missing-identity",
      "inkbox/config-missing-signing-key",
    ]);
    expect(sdk.Inkbox).not.toHaveBeenCalled();
  });

  it("reports live readiness issues from whoami and identity lookup", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.admin_scoped",
      organizationId: "org-1",
    });
    sdk.getIdentity.mockResolvedValue({
      mailbox: { emailAddress: "agent@inkboxmail.com" },
      phoneNumber: {
        number: "+15551234567",
        smsStatus: "pending",
      },
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              publicUrl: "https://example.com/hooks",
              tunnelName: "agent",
            },
          },
        } as any,
      },
      {},
    );

    expect(ids(findings)).toEqual([
      "inkbox/config-missing-signing-key",
      "inkbox/tunnel-config-conflict",
      "inkbox/auth-key-admin-scoped",
      "inkbox/cached-state-missing",
      "inkbox/sms-not-ready",
    ]);
    expect(sdk.Inkbox).toHaveBeenCalledWith({
      apiKey: "ApiKey_test",
      baseUrl: undefined,
    });
    expect(sdk.getIdentity).toHaveBeenCalledWith("agent");
  });

  it("reports identity lookup failures as identity-not-found", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    sdk.getIdentity.mockRejectedValue(new sdk.InkboxAPIError(404, "not found"));

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "missing-agent",
              signingKey: "whsec_test",
            },
          },
        } as any,
      },
      {},
    );

    expect(ids(findings)).toEqual(["inkbox/identity-not-found"]);
    expect(findings[0].severity).toBe("error");
    expect(findings[0].message).toContain("missing-agent");
  });
});
