// Contract tests for the plugin's assumptions about the OpenClaw host.
//
// The unit suite runs these against the pinned host from package-lock; the
// contract CI lane and the scheduled canary re-run them (plus a full
// typecheck) against openclaw@latest. They turn silent host-interface drift —
// a moved plugin-sdk symbol, a renamed export, a changed entry shape — into a
// red check instead of a runtime surprise on someone's gateway.
//
// Type-only imports (ChannelPlugin, OpenClawPluginApi, HealthCheck, ...) have
// no runtime presence; drift there is covered by `tsc --noEmit` against the
// latest host in the same CI lane.

import { describe, expect, it } from "vitest";

// Every value symbol the plugin imports from the host, by module — see
// index.ts, src/channel.ts, src/health.ts, and src/inbound/session.ts.
const HOST_SYMBOLS: Record<string, string[]> = {
  "openclaw/plugin-sdk/channel-core": [
    "defineChannelPluginEntry",
    "buildChannelOutboundSessionRoute",
    "buildThreadAwareOutboundSessionRoute",
    "createChatChannelPlugin",
  ],
  "openclaw/plugin-sdk/channel-message": [
    "createMessageReceiptFromOutboundResults",
    "defineChannelMessageAdapter",
  ],
  "openclaw/plugin-sdk/health": ["registerHealthCheck"],
  "openclaw/plugin-sdk/inbound-envelope": [
    "resolveInboundRouteEnvelopeBuilderWithRuntime",
  ],
  "openclaw/plugin-sdk/realtime-voice": [
    "buildRealtimeVoiceAgentConsultChatMessage",
    "buildRealtimeVoiceAgentConsultPolicyInstructions",
    "createRealtimeVoiceBridgeSession",
    "REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME",
    "REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ",
    "resolveConfiguredRealtimeVoiceProvider",
    "resolveRealtimeVoiceAgentConsultToolPolicy",
    "resolveRealtimeVoiceAgentConsultTools",
  ],
};

describe("host plugin-sdk symbols the plugin imports", () => {
  for (const [modulePath, names] of Object.entries(HOST_SYMBOLS)) {
    it(`${modulePath} exports ${names.length} expected symbols`, async () => {
      const mod = await import(modulePath);
      const missing = names.filter((n) => mod[n] === undefined);
      expect(
        missing,
        `${modulePath} is missing ${missing.join(", ")} — OpenClaw host interface drifted`,
      ).toEqual([]);
    });
  }
});

describe("plugin entry builds against the host", () => {
  // The strongest single check: index.ts constructs the channel-plugin entry
  // via defineChannelPluginEntry at module scope, so importing it exercises
  // the real host codepath the gateway uses to load us.
  it("defineChannelPluginEntry accepts our entry and returns the expected shape", async () => {
    const entry = (await import("../../index.js")).default;
    expect(entry).toBeTruthy();
    expect(entry.id).toBe("inkbox");
    expect(typeof entry.register).toBe("function");
    expect(entry.channelPlugin).toBeTruthy();
    expect(entry.configSchema).toBeTruthy();
  });
});
