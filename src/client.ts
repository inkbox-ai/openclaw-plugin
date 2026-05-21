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

// Build a lazy-cached runtime. The Inkbox SDK client and the identity resolution
// happen on first tool call, not at plugin registration. This keeps startup
// cheap when the user never invokes an Inkbox tool in a given session.
export function createInkboxRuntime(
  cfg: Partial<InkboxPluginConfig>,
  logger?: PluginLogger,
): InkboxRuntime {
  let resolved: Promise<{ inkbox: Inkbox; identity: AgentIdentity }> | null = null;

  function resolve(): Promise<{ inkbox: Inkbox; identity: AgentIdentity }> {
    if (!cfg.apiKey || !cfg.identity) {
      throw new Error(
        "Inkbox plugin is not configured. Set `plugins.entries.inkbox.config.apiKey` and `.identity`, or run `openclaw inkbox setup`.",
      );
    }
    if (!resolved) {
      const inkbox = new Inkbox({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
      resolved = (async () => {
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
    }
    return resolved;
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
