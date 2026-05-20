import type { InkboxRuntime, InkboxPluginConfig, PluginLogger } from "../client.js";
import type { InboundHandlers } from "./dispatch.js";
import { openInkboxTunnel } from "./tunnel.js";

export { RequestIdDedup } from "./dedup.js";
export { handleInkboxWebhook } from "./handler.js";
export { dispatchInbound } from "./dispatch.js";
export { openInkboxTunnel } from "./tunnel.js";
export type { InboundHandlers, InboundCallDecision, DispatchResult } from "./dispatch.js";
export type { WebhookHandlerOptions, WebhookResponse } from "./handler.js";

export interface StartInboundOptions {
  cfg: Partial<InkboxPluginConfig> & { tunnelName?: string };
  runtime: InkboxRuntime;
  handlers: InboundHandlers;
  logger?: PluginLogger;
}

// Kick off the inbound delivery path in the background. Tool calls don't
// depend on this completing — if the tunnel fails to open, outbound tools
// still work, the user just won't receive inbound events.
//
// Caller decides which handlers to wire. Phase 2c will wire real session
// ingress; for now the entry point logs and rejects calls.
export function startInbound(opts: StartInboundOptions): void {
  const { cfg, runtime, handlers, logger } = opts;
  if (!cfg.signingKey) {
    logger?.info?.(
      "Inkbox inbound delivery skipped — no signingKey configured. Set plugins.entries.inkbox.config.signingKey to enable.",
    );
    return;
  }
  if (!cfg.identity) {
    logger?.warn?.("Inkbox inbound delivery skipped — no identity in config.");
    return;
  }

  // Fire-and-forget. Error path warns and falls back to outbound-only mode.
  runtime
    .getClient()
    .then((inkbox) =>
      openInkboxTunnel({
        inkbox,
        identityHandle: cfg.identity!,
        signingKey: cfg.signingKey!,
        tunnelName: cfg.tunnelName,
        handlers,
        logger,
        allowedContactIds: cfg.allowedInboundContactIds,
      }),
    )
    .catch((err) => {
      logger?.warn?.(
        `Inkbox tunnel failed to open: ${err instanceof Error ? err.message : String(err)}. Outbound tools still work; inbound events won't be delivered until the tunnel comes up.`,
      );
    });
}
