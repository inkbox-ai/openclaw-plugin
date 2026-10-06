import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inkboxClientOptions } from "../src/sdk-options.js";
import {
  assessIncomingCallRoute,
  detectInkboxHealthFindings,
} from "../src/health.js";

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
  const subscriptionsList = vi.fn();
  const slack = { listConnections: vi.fn(), listConversations: vi.fn(), listMessages: vi.fn(), searchMessages: vi.fn(), sendMessage: vi.fn(), getAction: vi.fn() };
  const Inkbox = vi.fn(() => ({
    whoami,
    getIdentity,
    slack,
    webhooks: { subscriptions: { list: subscriptionsList } },
  }));
  return {
    Inkbox,
    InkboxAPIError: MockInkboxAPIError,
    whoami,
    getIdentity,
    subscriptionsList,
    slack,
  };
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
  sdk.subscriptionsList.mockReset();
  sdk.subscriptionsList.mockResolvedValue([]);
  sdk.slack.listConnections.mockReset().mockResolvedValue({ connections: [] });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

function ids(findings: readonly { checkId: string }[]): string[] {
  return findings.map((finding) => finding.checkId);
}

describe("assessIncomingCallRoute", () => {
  it.each(["openai_realtime", "inkbox_tts_stt"] as const)(
    "accepts the exact local websocket route for %s",
    (voiceStack) => {
      expect(
        assessIncomingCallRoute(
          voiceStack,
          {
            incomingCallAction: "auto_accept",
            clientWebsocketUrl: "wss://agent.example/inkbox/phone/media/ws",
            incomingCallWebhookUrl: null,
          },
          "wss://agent.example/inkbox/phone/media/ws",
        ).ok,
      ).toBe(true);
    },
  );

  it.each([
    {
      name: "a stale websocket URL",
      route: {
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://old.example/inkbox/phone/media/ws",
      },
    },
    {
      name: "a hosted route",
      route: { incomingCallAction: "hosted_agent" },
    },
    {
      name: "an auto-reject route",
      route: { incomingCallAction: "auto_reject" },
    },
    {
      name: "a stale webhook callback",
      route: {
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://agent.example/inkbox/phone/media/ws",
        incomingCallWebhookUrl: "https://old.example/calls",
      },
    },
  ])("rejects $name for an explicitly selected local stack", ({ route }) => {
    expect(
      assessIncomingCallRoute(
        "openai_realtime",
        route,
        "wss://agent.example/inkbox/phone/media/ws",
      ).ok,
    ).toBe(false);
  });

  it("requires hosted_agent with no stale callbacks for Inkbox Voice AI", () => {
    expect(
      assessIncomingCallRoute(
        "inkbox_voice_ai",
        {
          incomingCallAction: "hosted_agent",
          clientWebsocketUrl: null,
          incomingCallWebhookUrl: null,
        },
        undefined,
      ).ok,
    ).toBe(true);

    for (const route of [
      {
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://agent.example/inkbox/phone/media/ws",
      },
      {
        incomingCallAction: "hosted_agent",
        clientWebsocketUrl: "wss://old.example/calls",
      },
      {
        incomingCallAction: "hosted_agent",
        incomingCallWebhookUrl: "https://old.example/calls",
      },
      { incomingCallAction: "auto_reject" },
    ]) {
      expect(
        assessIncomingCallRoute("inkbox_voice_ai", route, undefined).ok,
      ).toBe(false);
    }
  });

  it("preserves legacy absent-stack route semantics", () => {
    expect(
      assessIncomingCallRoute(
        undefined,
        {
          incomingCallAction: "auto_accept",
          clientWebsocketUrl: "wss://any-existing-route.example/ws",
        },
        "wss://new.example/inkbox/phone/media/ws",
      ).ok,
    ).toBe(true);
    expect(
      assessIncomingCallRoute(
        undefined,
        { incomingCallAction: "auto_reject" },
        undefined,
      ).ok,
    ).toBe(true);
    expect(
      assessIncomingCallRoute(
        undefined,
        {
          incomingCallAction: "webhook",
          incomingCallWebhookUrl: "https://existing.example/calls",
        },
        undefined,
      ).ok,
    ).toBe(true);
    expect(
      assessIncomingCallRoute(
        undefined,
        { incomingCallAction: "hosted_agent" },
        undefined,
      ).ok,
    ).toBe(false);
  });
});

describe("detectInkboxHealthFindings", () => {
  it("distinguishes disabled features without calling their remote endpoints", async () => {
    sdk.whoami.mockResolvedValue({}); sdk.getIdentity.mockResolvedValue({ id: "identity" });
    const findings = await detectInkboxHealthFindings({ cfg: { channels: { inkbox: { apiKey: "ApiKey_test", identity: "agent" } } } as any }, {});
    expect(findings.find((value) => value.checkId === "inkbox/slack-readiness")?.message).toContain("disabled");
    expect(findings.find((value) => value.checkId === "inkbox/imessage-threading-readiness")?.message).toContain("disabled");
    expect(sdk.slack.listConnections).not.toHaveBeenCalled();
  });
  it("does not confuse missing native SDK capability with verified backend support", async () => {
    sdk.whoami.mockResolvedValue({}); sdk.getIdentity.mockResolvedValue({ id: "identity", imessageEnabled: true });
    const ctx = { cfg: { channels: { inkbox: { apiKey: "ApiKey_test", identity: "agent", imessageThreadedReplies: true } } } as any };
    const missing = (await detectInkboxHealthFindings(ctx, {})).find((value) => value.checkId === "inkbox/imessage-threading-readiness");
    expect(missing?.severity).toBe("error"); expect(missing?.message).toContain("lacks");
    sdk.getIdentity.mockResolvedValue({ id: "identity", imessageEnabled: true, sendIMessage() {}, getIMessage() {}, getIMessageThread() {}, getIMessageConversationThread() {} });
    const capable = (await detectInkboxHealthFindings(ctx, {})).find((value) => value.checkId === "inkbox/imessage-threading-readiness");
    expect(capable?.severity).toBe("info"); expect(capable?.message).toContain("verified against each exact source"); expect(capable?.message).toContain("does not prove device delivery");
  });
  it("requires an identity-owned connected Slack installation and all active subscription events", async () => {
    sdk.whoami.mockResolvedValue({}); sdk.getIdentity.mockResolvedValue({ id: "identity" });
    const ctx = { cfg: { channels: { inkbox: { apiKey: "ApiKey_test", identity: "agent", slackEnabled: true, publicUrl: "https://agent.example" } } } as any };
    sdk.slack.listConnections.mockResolvedValue({ connections: [{ id: "connection", identityId: "foreign", status: "connected" }] });
    const inspect = async () => (await detectInkboxHealthFindings(ctx, {})).find((value) => value.checkId === "inkbox/slack-readiness");
    expect((await inspect())?.severity).toBe("warning");
    sdk.slack.listConnections.mockResolvedValue({ connections: [{ id: "connection", identityId: "identity", status: "connected" }] });
    const { SLACK_SUBSCRIPTION_EVENTS } = await import("../src/slack.js");
    const { inkboxWebhookPath } = await import("../src/call-websocket.js");
    sdk.subscriptionsList.mockResolvedValue([{ url: `https://agent.example${inkboxWebhookPath("default")}`, status: "active", eventTypes: [...SLACK_SUBSCRIPTION_EVENTS] }]);
    expect((await inspect())?.severity).toBe("info");
    sdk.subscriptionsList.mockResolvedValue([{ url: `https://agent.example${inkboxWebhookPath("default")}`, status: "disabled", eventTypes: [...SLACK_SUBSCRIPTION_EVENTS] }]);
    expect((await inspect())?.severity).toBe("warning");
    sdk.slack.listConnections.mockRejectedValue(new Error("secret connection contents must not escape"));
    const failed = await inspect(); expect(failed?.severity).toBe("warning"); expect(failed?.message).not.toContain("secret");
  });
  it("recognizes the actual published Slack SDK surface before probing readiness", async () => {
    const actual = await vi.importActual<typeof import("@inkbox/sdk")>("@inkbox/sdk");
    const client = new actual.Inkbox({ apiKey: "synthetic-key", baseUrl: "https://sdk.test" });
    const list = vi.spyOn(client.slack, "listConnections").mockResolvedValue({ connections: [] } as any);
    sdk.whoami.mockResolvedValue({}); sdk.getIdentity.mockResolvedValue({ id: "identity" });
    sdk.Inkbox.mockImplementationOnce(() => ({ whoami: sdk.whoami, getIdentity: sdk.getIdentity, slack: client.slack, webhooks: { subscriptions: { list: sdk.subscriptionsList } } }) as any);
    const result = (await detectInkboxHealthFindings({ cfg: { channels: { inkbox: { apiKey: "ApiKey_test", identity: "agent", slackEnabled: true } } } as any }, {})).find((value) => value.checkId === "inkbox/slack-readiness");
    expect(result?.severity).toBe("warning"); expect(result?.message).not.toContain("lacks required"); expect(list).toHaveBeenCalledWith("identity");
  });
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
      // The fixture phone has no incoming-call config wired.
      "inkbox/incoming-call-route",
      "inkbox/slack-readiness",
      "inkbox/imessage-threading-readiness",
      "inkbox/durable-queue",
    ]);
    expect(sdk.Inkbox).toHaveBeenCalledWith(inkboxClientOptions("ApiKey_test", undefined));
    expect(sdk.getIdentity).toHaveBeenCalledWith("agent");
  });

  it("reads the identity-scoped incoming-call config when the SDK exposes it", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    const getIncomingCallAction = vi.fn(async () => ({
      agentIdentityId: "identity-1",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://example.com/hooks/inkbox/phone/media/ws",
      incomingCallWebhookUrl: null,
    }));
    sdk.getIdentity.mockResolvedValue({
      mailbox: { id: "mb-1", emailAddress: "agent@inkboxmail.com" },
      // Number-scoped fields intentionally absent — the identity-scoped read
      // must be the source of truth.
      phoneNumber: { id: "phone-1", number: "+15551234567", smsStatus: "ready" },
      getIncomingCallAction,
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://example.com/hooks",
            },
          },
        } as any,
      },
      {},
    );

    expect(getIncomingCallAction).toHaveBeenCalled();
    expect(ids(findings)).not.toContain("inkbox/incoming-call-route");
  });

  it.each(["openai_realtime", "inkbox_tts_stt"] as const)(
    "accepts the canonical account websocket route for %s",
    async (voiceStack) => {
      sdk.whoami.mockResolvedValue({
        authType: "api_key",
        authSubtype: "api_key.agent_scoped.claimed",
        organizationId: "org-1",
      });
      sdk.getIdentity.mockResolvedValue({
        mailbox: null,
        phoneNumber: { id: "phone-1", number: "+15551234567", smsStatus: "ready" },
        getIncomingCallAction: vi.fn(async () => ({
          incomingCallAction: "auto_accept",
          clientWebsocketUrl: "wss://current.example/hooks/inkbox/phone/media/ws",
          incomingCallWebhookUrl: null,
        })),
      });

      const findings = await detectInkboxHealthFindings(
        {
          cfg: {
            channels: {
              inkbox: {
                apiKey: "ApiKey_test",
                identity: "agent",
                signingKey: "whsec_test",
                publicUrl: "https://current.example/hooks",
                voiceStack,
              },
            },
          } as any,
        },
        {},
      );

      expect(ids(findings)).not.toContain("inkbox/incoming-call-route");
    },
  );

  it("reports the selected stack and exact expected/actual route on mismatch", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    sdk.getIdentity.mockResolvedValue({
      mailbox: null,
      phoneNumber: { id: "phone-1", number: "+15551234567", smsStatus: "ready" },
      getIncomingCallAction: vi.fn(async () => ({
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://old.example/inkbox/phone/media/ws",
        incomingCallWebhookUrl: "https://old.example/calls",
      })),
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://current.example/hooks",
              voiceStack: "inkbox_voice_ai",
            },
          },
        } as any,
      },
      {},
    );

    const route = findings.find((finding) =>
      finding.checkId === "inkbox/incoming-call-route",
    );
    expect(route?.severity).toBe("warning");
    expect(route?.message).toContain("voiceStack=inkbox_voice_ai");
    expect(route?.message).toContain('Expected action="hosted_agent"');
    expect(route?.message).toContain('actual action="auto_accept"');
    expect(route?.message).toContain("wss://old.example/inkbox/phone/media/ws");
    expect(route?.message).toContain("https://old.example/calls");
  });

  it("checks the incoming-call route for an iMessage-only identity", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    const notFound = new sdk.InkboxAPIError(404, "no incoming-call config");
    sdk.getIdentity.mockResolvedValue({
      mailbox: { id: "mb-1", emailAddress: "agent@inkboxmail.com" },
      phoneNumber: null,
      imessageEnabled: true,
      getIncomingCallAction: vi.fn(async () => {
        throw notFound;
      }),
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://example.com/hooks",
            },
          },
        } as any,
      },
      {},
    );

    // No dedicated number, but the shared iMessage line can still take calls
    // — the unwired identity-scoped config must surface as a warning.
    const route = findings.find((f) => f.checkId === "inkbox/incoming-call-route");
    expect(route?.severity).toBe("warning");
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

  it("emits no subscription findings when mail + text subs are wired correctly", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    const expectedUrl = "https://example.com/hooks/inkbox/webhook";
    sdk.getIdentity.mockResolvedValue({
      mailbox: { id: "mb-1", emailAddress: "agent@inkboxmail.com" },
      phoneNumber: {
        id: "phone-1",
        number: "+15551234567",
        smsStatus: "ready",
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://example.com/hooks/inkbox/phone/media/ws",
      },
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });
    sdk.subscriptionsList.mockImplementation(async (filter: any) => [
      {
        id: filter.mailboxId ? "sub-mail" : "sub-text",
        organizationId: "org-1",
        mailboxId: filter.mailboxId ?? null,
        phoneNumberId: filter.phoneNumberId ?? null,
        url: expectedUrl,
        eventTypes: filter.mailboxId
          ? ["message.received", "message.sent"]
          : ["text.received", "text.delivered"],
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://example.com/hooks",
            },
          },
        } as any,
      },
      {},
    );

    const subIds = ids(findings).filter((id) => id.startsWith("inkbox/webhook-subscription-") || id === "inkbox/incoming-call-route");
    expect(subIds).toEqual([]);
  });

  it("warns when mail and text subscriptions are missing", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    sdk.getIdentity.mockResolvedValue({
      mailbox: { id: "mb-1", emailAddress: "agent@inkboxmail.com" },
      phoneNumber: {
        id: "phone-1",
        number: "+15551234567",
        smsStatus: "ready",
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://example.com/hooks/inkbox/phone/media/ws",
      },
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });
    sdk.subscriptionsList.mockResolvedValue([]);

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://example.com/hooks",
            },
          },
        } as any,
      },
      {},
    );

    const subFindings = findings.filter((f) =>
      f.checkId === "inkbox/webhook-subscription-mailbox" ||
      f.checkId === "inkbox/webhook-subscription-phone-text",
    );
    expect(subFindings.map((f) => f.checkId).sort()).toEqual([
      "inkbox/webhook-subscription-mailbox",
      "inkbox/webhook-subscription-phone-text",
    ]);
    expect(subFindings.every((f) => f.severity === "warning")).toBe(true);
  });

  it("warns when a subscription is wired but the receive event is missing", async () => {
    sdk.whoami.mockResolvedValue({
      authType: "api_key",
      authSubtype: "api_key.agent_scoped.claimed",
      organizationId: "org-1",
    });
    const expectedUrl = "https://example.com/hooks/inkbox/webhook";
    sdk.getIdentity.mockResolvedValue({
      mailbox: { id: "mb-1", emailAddress: "agent@inkboxmail.com" },
      phoneNumber: {
        id: "phone-1",
        number: "+15551234567",
        smsStatus: "ready",
        incomingCallAction: "auto_accept",
        clientWebsocketUrl: "wss://example.com/hooks/inkbox/phone/media/ws",
      },
      tunnel: { publicHost: "agent.inkboxwire.com" },
    });
    sdk.subscriptionsList.mockImplementation(async (filter: any) => [
      {
        id: filter.mailboxId ? "sub-mail" : "sub-text",
        organizationId: "org-1",
        mailboxId: filter.mailboxId ?? null,
        phoneNumberId: filter.phoneNumberId ?? null,
        url: expectedUrl,
        eventTypes: filter.mailboxId
          ? ["message.sent"]
          : ["text.delivered"],
        status: "active",
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const findings = await detectInkboxHealthFindings(
      {
        cfg: {
          channels: {
            inkbox: {
              apiKey: "ApiKey_test",
              identity: "agent",
              signingKey: "whsec_test",
              publicUrl: "https://example.com/hooks",
            },
          },
        } as any,
      },
      {},
    );

    const subFindings = findings.filter((f) =>
      f.checkId === "inkbox/webhook-subscription-mailbox" ||
      f.checkId === "inkbox/webhook-subscription-phone-text",
    );
    expect(subFindings.map((f) => f.checkId).sort()).toEqual([
      "inkbox/webhook-subscription-mailbox",
      "inkbox/webhook-subscription-phone-text",
    ]);
    expect(subFindings.find((f) => f.checkId === "inkbox/webhook-subscription-mailbox")?.message)
      .toContain("message.received");
    expect(subFindings.find((f) => f.checkId === "inkbox/webhook-subscription-phone-text")?.message)
      .toContain("text.received");
  });
});
