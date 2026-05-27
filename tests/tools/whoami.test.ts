import { describe, expect, it } from "vitest";
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
    expect(payload.identity.incomingCallAction).toBe("webhook");
    expect(payload.identity.tunnelPublicHost).toBe("agent.inkboxwire.com");
    expect(payload.identity.smsErrorCode).toBe("carrier_pending");
  });
});
