import { describe, expect, it, vi } from "vitest";
import type { InkboxRuntime } from "../../src/client.js";
import { registerWhoami } from "../../src/tools/whoami.js";

interface RegisteredTool {
  name: string;
  description: string;
  parameters: unknown;
  execute: (id: string, params: any) => Promise<any>;
}

function createApi(): { api: any; tools: Map<string, RegisteredTool> } {
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool: (def: RegisteredTool) => {
      tools.set(def.name, def);
    },
  };
  return { api, tools };
}

function parseJsonBlock(text: string): any {
  return JSON.parse(text.replace(/^```json\n/, "").replace(/\n```$/, ""));
}

describe("registerWhoami", () => {
  it("includes identity readiness fields formerly covered by rate status", async () => {
    const { api, tools } = createApi();
    const runtime: InkboxRuntime = {
      getClient: () =>
        Promise.resolve({
          whoami: () =>
            Promise.resolve({
              authType: "api_key",
              authSubtype: "api_key.agent_scoped.claimed",
              label: "agent-key",
              organizationId: "org-1",
            }),
        } as any),
      getIdentity: () =>
        Promise.resolve({
          agentHandle: "agent",
          id: "identity-1",
          displayName: "Agent",
          mailbox: {
            emailAddress: "agent@inkboxmail.com",
            sendingDomain: "inkboxmail.com",
            filterMode: "allow_all",
          },
          phoneNumber: {
            id: "phone-1",
            number: "+15551234567",
            type: "local",
            smsStatus: "pending",
            smsErrorCode: "carrier_pending",
            incomingCallAction: "webhook",
            filterMode: "allow_all",
          },
          tunnel: { publicHost: "agent.inkboxwire.com" },
        } as any),
    };
    registerWhoami(api, runtime);

    const out = await tools.get("inkbox_whoami")!.execute("turn-1", {});
    const payload = parseJsonBlock(out.content[0].text);

    expect(payload.identity.id).toBe("identity-1");
    expect(payload.identity.sendingDomain).toBe("inkboxmail.com");
    // Legacy SDK identity without the identity-scoped read — the
    // number-scoped field is the fallback source.
    expect(payload.identity.incomingCallAction).toBe("webhook");
    expect(payload.identity.tunnelPublicHost).toBe("agent.inkboxwire.com");
    expect(payload.identity.smsErrorCode).toBe("carrier_pending");
    // The lines block labels the dedicated line for an iMessage-less identity.
    expect(payload.lines.dedicated_phone_line).toBe("+15551234567");
    expect(payload.lines.shared_imessage_line).toBe("disabled");
  });

  it("labels both lines and reads the identity-scoped incoming-call config", async () => {
    const { api, tools } = createApi();
    const getIncomingCallAction = vi.fn(async () => ({
      agentIdentityId: "identity-2",
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: "wss://agent.inkboxwire.com/inkbox/phone/media/ws",
      incomingCallWebhookUrl: null,
    }));
    const runtime: InkboxRuntime = {
      getClient: () =>
        Promise.resolve({
          whoami: () =>
            Promise.resolve({
              authType: "api_key",
              authSubtype: "api_key.agent_scoped.claimed",
              label: "agent-key",
              organizationId: "org-1",
            }),
        } as any),
      getIdentity: () =>
        Promise.resolve({
          agentHandle: "agent",
          id: "identity-2",
          displayName: "Agent",
          mailbox: null,
          phoneNumber: null,
          imessageEnabled: true,
          getIncomingCallAction,
          tunnel: { publicHost: "agent.inkboxwire.com" },
        } as any),
    };
    registerWhoami(api, runtime);

    const out = await tools.get("inkbox_whoami")!.execute("turn-1", {});
    const payload = parseJsonBlock(out.content[0].text);

    expect(getIncomingCallAction).toHaveBeenCalled();
    expect(payload.identity.incomingCallAction).toBe("auto_accept");
    // No dedicated number, shared line enabled — and the shared line's note
    // never surfaces an actual number.
    expect(payload.lines.dedicated_phone_line).toBe("(none provisioned)");
    expect(payload.lines.dedicated_phone_line_note).toContain("origination=dedicated_number");
    expect(payload.lines.shared_imessage_line).toBe("enabled");
    expect(payload.lines.shared_imessage_line_note).toContain(
      "origination=shared_imessage_number",
    );
    expect(payload.lines.shared_imessage_line_note).toContain("not shown");
  });
});
