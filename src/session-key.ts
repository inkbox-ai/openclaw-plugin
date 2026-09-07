import { buildAgentSessionKey, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";

/** Preserve stored canonical routes; scope legacy task/progress keys to their agent. */
export function canonicalInkboxSessionOverride(agentId: string, sessionKey: string): string {
  const normalized = sessionKey.trim().toLowerCase();
  if (normalized === "global" || normalized === "unknown" || parseAgentSessionKey(normalized)) {
    return normalized;
  }
  return buildAgentSessionKey({
    agentId,
    channel: "inkbox",
    peer: { kind: "direct", id: normalized },
    dmScope: "per-channel-peer",
  });
}
