import { beforeEach, describe, expect, it, vi } from "vitest";

const world = vi.hoisted(() => ({
  client: undefined as any,
  persist: vi.fn(async () => ({ ok: true })),
  writeState: vi.fn(async () => undefined),
  gateway: vi.fn(async () => ({ running: true, action: "install" as const })),
}));

vi.mock("@inkbox/sdk", () => ({
  Inkbox: function Inkbox() {
    return world.client;
  },
}));
vi.mock("../src/setup-wizard.js", () => ({ persistOpenClawConfigFile: world.persist }));
vi.mock("../src/state.js", () => ({ writeIdentityState: world.writeState }));
vi.mock("../src/gateway-service.js", () => ({ ensureGatewayRunning: world.gateway }));

import { bootstrap } from "../src/bootstrap.js";

function fakeWorld(signingConfigured = false) {
  const identity = {
    id: "identity-1",
    agentHandle: "helper",
    mailbox: { emailAddress: "helper@example.com" },
    phoneNumber: { number: "+15551234567" },
    tunnel: { publicHost: "helper.example.com" },
    imessageEnabled: false,
    getHostedAgentConfig: vi.fn(async () => ({ voice: "cedar", model: "voice", instructions: undefined, authorityMode: "contact_scoped" })),
    setHostedAgentConfig: vi.fn(async () => ({})),
    getIncomingCallAction: vi.fn(async () => ({ incomingCallAction: "auto_accept", clientWebsocketUrl: "wss://old" })),
    setIncomingCallAction: vi.fn(async () => ({})),
    getSigningKeyStatus: vi.fn(async () => ({ configured: signingConfigured })),
    createSigningKey: vi.fn(async () => ({ signingKey: "signing-secret" })),
  };
  world.client = {
    whoami: vi.fn(async () => ({ authType: "api_key", authSubtype: "api_key.agent_scoped.claimed" })),
    listIdentities: vi.fn(async () => [{ agentHandle: "helper" }]),
    getIdentity: vi.fn(async () => identity),
    imessages: { getTriageNumber: vi.fn() },
  };
  return identity;
}

beforeEach(() => {
  vi.clearAllMocks();
  world.persist.mockResolvedValue({ ok: true });
  world.gateway.mockResolvedValue({ running: true, action: "install" });
});

describe("bootstrap", () => {
  it("persists the exact identity, Voice AI, signing key, state, and gateway", async () => {
    const identity = fakeWorld();
    const result = await bootstrap({
      identity: "@helper",
      apiKey: "agent-secret",
      voiceAi: true,
      rotateSigningKey: true,
      startGateway: true,
      env: {},
    });
    expect(result.status).toBe("configured");
    expect(result.gatewayRunning).toBe(true);
    expect(world.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "agent-secret",
        identity: "helper",
        signingKey: "signing-secret",
        voiceStack: "inkbox_voice_ai",
        voiceAgentPrewarm: false,
      }),
      expect.any(Object),
    );
    expect(world.writeState).toHaveBeenCalledWith(expect.objectContaining({ identityHandle: "helper" }));
    expect(identity.setIncomingCallAction).toHaveBeenCalled();
  });

  it("requires explicit rotation when a remote signing key is unavailable", async () => {
    const identity = fakeWorld(true);
    const result = await bootstrap({ identity: "helper", apiKey: "agent-secret", env: {} });
    expect(result.status).toBe("requires_human");
    expect(result.humanActions?.[0]).toContain("--rotate-signing-key");
    expect(identity.createSigningKey).not.toHaveBeenCalled();
    expect(world.persist).not.toHaveBeenCalled();
  });
});
