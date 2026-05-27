import type { InkboxRuntime, InkboxPluginConfig, PluginLogger } from "../client.js";
import type { InboundHandlers } from "./dispatch.js";
import { openInkboxTunnel } from "./tunnel.js";
import { registerInboundHttpRoute } from "./http-route.js";
import { SmsBatcher, DEFAULT_SMS_BATCH } from "./batch.js";
export { SmsBatcher, DEFAULT_SMS_BATCH } from "./batch.js";
export type { SmsBatchConfig, BatchedTextEvent } from "./batch.js";

export { RequestIdDedup } from "./dedup.js";
export { handleInkboxWebhook } from "./handler.js";
export { dispatchInbound } from "./dispatch.js";
export { openInkboxTunnel } from "./tunnel.js";
export { registerInboundHttpRoute } from "./http-route.js";
export type { InboundHandlers, InboundCallDecision, DispatchResult } from "./dispatch.js";
export type { WebhookHandlerOptions, WebhookResponse } from "./handler.js";

export interface StartInboundOptions {
  // OpenClaw plugin api. Needed for the registerHttpRoute path when
  // cfg.publicUrl is set. Optional only because the tunnel path doesn't
  // strictly require it — but you'll get the tunnel branch in either case
  // if `api` is omitted.
  api?: any;
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
  const { api, cfg, runtime, handlers, logger } = opts;
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

  // If batching is configured, wrap onText with a batcher. text.received
  // events from the same remote number within the window get collapsed
  // into one synthetic batched event before they reach the handler.
  const batchDelayMs = cfg.sms?.batchDelayMs ?? DEFAULT_SMS_BATCH.batchDelayMs;
  let wrappedHandlers = handlers;
  if (batchDelayMs > 0 && handlers.onText) {
    const userOnText = handlers.onText;
    const batcher = new SmsBatcher(
      {
        batchDelayMs,
        maxMessages: cfg.sms?.maxMessages ?? DEFAULT_SMS_BATCH.maxMessages,
        maxChars: cfg.sms?.maxChars ?? DEFAULT_SMS_BATCH.maxChars,
      },
      async (batched) => {
        await userOnText(batched);
      },
    );
    wrappedHandlers = {
      ...handlers,
      onText: async (event) => {
        // Try to accumulate. If accepted, the batcher will fire userOnText
        // on flush — we MUST NOT also call it here. If not accepted (e.g.
        // delivery-status event), pass through immediately.
        const accepted = batcher.accept(event as any);
        if (!accepted) {
          await userOnText(event);
        }
      },
    };
    logger?.info?.(
      `Inkbox SMS batching on (delay=${batchDelayMs}ms, maxMessages=${cfg.sms?.maxMessages ?? DEFAULT_SMS_BATCH.maxMessages}, maxChars=${cfg.sms?.maxChars ?? DEFAULT_SMS_BATCH.maxChars}).`,
    );
  }

  // Branch on cfg.publicUrl: when set, OpenClaw is already publicly
  // reachable so we register the webhook as an in-process HTTP route. When
  // unset, fall back to the Inkbox tunnel so laptop/local-dev setups don't
  // need a public host.
  if (cfg.publicUrl) {
    if (!api) {
      logger?.warn?.(
        "Inkbox publicUrl override set but no api was passed to startInbound; cannot register HTTP route. Falling back to tunnel.",
      );
    } else {
      registerInboundHttpRoute({
        api,
        signingKey: cfg.signingKey,
        handlers: wrappedHandlers,
        allowedContactIds: cfg.allowedInboundContactIds,
        logger,
      });
      logger?.info?.(
        `Inkbox inbound at ${cfg.publicUrl}/inkbox/webhook; configure mail/text webhook subscriptions to this URL and phone incoming-call delivery separately.`,
      );
      return;
    }
  }

  // Tunnel branch (default). Fire-and-forget; tunnel failures don't block
  // outbound tools.
  runtime
    .getClient()
    .then((inkbox) =>
      openInkboxTunnel({
        inkbox,
        identityHandle: cfg.identity!,
        signingKey: cfg.signingKey!,
        tunnelName: cfg.tunnelName,
        handlers: wrappedHandlers,
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
