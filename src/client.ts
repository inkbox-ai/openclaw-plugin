import { Inkbox } from "@inkbox/sdk";
import type { AgentIdentity } from "@inkbox/sdk";
import {
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
} from "@inkbox/sdk";

// Shape of `plugins.entries.inkbox.config` after configSchema validation.
export interface InkboxPluginConfig {
  apiKey: string;
  identity: string;
  baseUrl?: string;
  // Inbound: HMAC secret used to verify webhooks. Required for inbound delivery.
  signingKey?: string;
  // Inbound: override tunnel name. Defaults to identity handle so the
  // public URL is stable across restarts.
  tunnelName?: string;
  // Inbound: if set, skip the Inkbox tunnel and assume webhooks land at this
  // public URL (e.g. when OpenClaw is hosted on a reachable host). Phase 7.
  publicUrl?: string;
  // Voice: explicit WebSocket URL for outbound call media. Usually omitted;
  // tunnel mode derives it from tunnelName/identity.
  callWebsocketUrl?: string;
  // Voice: wait this many ms for consecutive final transcript segments before
  // sending the combined caller turn to OpenClaw.
  voiceTranscriptCoalesceMs?: number;
  // Voice: run a hidden no-delivery agent turn when the gateway starts so the
  // first caller turn does not pay Codex/OpenClaw cold-start latency.
  voiceAgentPrewarm?: boolean;
  voiceAgentPrewarmTtlMs?: number;
  voiceAgentPrewarmTimeoutMs?: number;
  // Voice: optional raw-media bridge to an OpenClaw realtime voice provider
  // such as OpenAI Realtime. When unavailable, the call falls back to Inkbox
  // managed STT/TTS unless fallbackToInkboxSttTts is false.
  voiceRealtime?: {
    enabled?: boolean;
    provider?: string;
    model?: string;
    voice?: string;
    instructions?: string;
    toolPolicy?: "safe-read-only" | "owner" | "none";
    consultPolicy?: "auto" | "substantive" | "always";
    providers?: Record<string, Record<string, unknown>>;
    fallbackToInkboxSttTts?: boolean;
  };
  // Outbound recipient allowlist. When set, send_email / send_sms /
  // forward_email reject any recipient not on the list. Phone matches in
  // E.164, email matches by exact address. Empty/undefined → no filtering.
  allowedRecipients?: string[];
  // Inbound contact-id allowlist. When set, the webhook dispatcher drops
  // any event whose contact id is not on the list. Events with no contact
  // resolution are also dropped (conservative default).
  allowedInboundContactIds?: string[];
  // Inbound SMS fragment batching. When `batchDelayMs > 0`, consecutive
  // text.received events from the same remote number within the window are
  // accumulated and delivered as a single event with concatenated body.
  sms?: {
    batchDelayMs?: number;
    maxMessages?: number;
    maxChars?: number;
  };
}

export interface InkboxRuntime {
  // Resolves the agent identity bound to the configured key. Cached after first call.
  getIdentity(): Promise<AgentIdentity>;
  // The underlying admin-shaped Inkbox client. With an agent-scoped key most
  // admin endpoints will return 403 — that's fine, it just means tools that
  // would call them aren't supported in agent-scoped mode.
  getClient(): Promise<Inkbox>;
}

export interface PluginLogger {
  warn?(msg: string): void;
  info?(msg: string): void;
  debug?(msg: string): void;
}

export type InkboxConfigSource =
  | Partial<InkboxPluginConfig>
  | (() => Partial<InkboxPluginConfig>);

function readConfig(source: InkboxConfigSource): Partial<InkboxPluginConfig> {
  return typeof source === "function" ? source() : source;
}

function runtimeCacheKey(cfg: Partial<InkboxPluginConfig>): string {
  return JSON.stringify({
    apiKey: cfg.apiKey ?? "",
    identity: cfg.identity ?? "",
    baseUrl: cfg.baseUrl ?? "",
  });
}

// Build a lazy-cached runtime. The Inkbox SDK client and the identity resolution
// happen on first tool call, not at plugin registration. This keeps startup
// cheap when the user never invokes an Inkbox tool in a given session.
export function createInkboxRuntime(
  source: InkboxConfigSource,
  logger?: PluginLogger,
): InkboxRuntime {
  let resolved: {
    key: string;
    promise: Promise<{ inkbox: Inkbox; identity: AgentIdentity }>;
  } | null = null;

  function resolve(): Promise<{ inkbox: Inkbox; identity: AgentIdentity }> {
    const cfg = readConfig(source);
    if (!cfg.apiKey || !cfg.identity) {
      throw new Error(
        "Inkbox plugin is not configured. Set `plugins.entries.inkbox.config.apiKey` and `.identity`, or run `openclaw inkbox setup`.",
      );
    }
    const key = runtimeCacheKey(cfg);
    if (!resolved || resolved.key !== key) {
      const inkbox = new Inkbox({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
      const promise = (async () => {
        // Confirm the key shape before we go any further. Agent-scoped is the
        // expected mode; admin-scoped works for outbound but we surface a warning
        // since several plugin features assume the agent-scoped access pattern.
        try {
          const info = await inkbox.whoami();
          if (info.authType === "api_key") {
            const sub = info.authSubtype;
            const isAgentScoped =
              sub === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED ||
              sub === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED;
            if (!isAgentScoped) {
              logger?.warn?.(
                `Inkbox plugin: API key is not agent-scoped (subtype=${sub}). Outbound tools will work but access-scoped reads (contacts, notes, vault) may behave differently.`,
              );
            }
          } else {
            logger?.warn?.(
              `Inkbox plugin: whoami returned authType=${info.authType} — expected api_key.`,
            );
          }
        } catch (e) {
          // whoami failure isn't fatal — the first real tool call will surface
          // a clearer error. We just couldn't preflight.
          logger?.warn?.(
            `Inkbox plugin: whoami() failed during init: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        const identity = await inkbox.getIdentity(cfg.identity!);
        return { inkbox, identity };
      })();
      resolved = { key, promise };
    }
    return resolved.promise;
  }

  return {
    async getIdentity() {
      return (await resolve()).identity;
    },
    async getClient() {
      return (await resolve()).inkbox;
    },
  };
}
