import { verifyWebhook } from "@inkbox/sdk";
import { RequestIdDedup } from "./dedup.js";
import { dispatchInbound, type InboundHandlers } from "./dispatch.js";
import type { PluginLogger } from "../client.js";

export interface WebhookHandlerOptions {
  signingKey: string;
  handlers: InboundHandlers;
  dedup?: RequestIdDedup;
  logger?: PluginLogger;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

// Pure handler — accepts raw body + lowercase-keyed headers from any HTTP
// entry point (tunnel Fetch handler, registerHttpRoute Node handler, raw
// http server, test fixture) and returns the response to send.
//
// Verification order: required-headers check → dedup → HMAC verify → JSON
// parse → dispatch. We dedup before crypto so replays short-circuit cheaply.
export async function handleInkboxWebhook(
  bodyText: string,
  headers: Record<string, string>,
  opts: WebhookHandlerOptions,
): Promise<WebhookResponse> {
  const requestId = headers["x-inkbox-request-id"];
  const signature = headers["x-inkbox-signature"];
  const timestamp = headers["x-inkbox-timestamp"];

  if (!requestId || !signature || !timestamp) {
    opts.logger?.warn?.(
      `Inkbox webhook missing required headers — request-id=${!!requestId} signature=${!!signature} timestamp=${!!timestamp}`,
    );
    return { status: 400, body: "missing inkbox webhook headers" };
  }

  // Dedup before HMAC so retries are O(1).
  if (opts.dedup?.has(requestId)) {
    return { status: 200, body: "dup" };
  }

  // verifyWebhook does the timing-safe compare over
  // "{requestId}.{timestamp}.{body}" with HMAC-SHA256.
  const valid = verifyWebhook({
    payload: bodyText,
    headers,
    secret: opts.signingKey,
  });
  if (!valid) {
    opts.logger?.warn?.("Inkbox webhook signature verification failed");
    return { status: 403, body: "invalid signature" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: "invalid json" };
  }

  const result = await dispatchInbound(parsed, opts.handlers);
  // Remember only after a successful dispatch; if dispatch throws, we'd
  // rather Inkbox retry than silently swallow the event.
  opts.dedup?.remember(requestId);

  // For inbound calls, the response body IS the routing decision.
  if (result.kind === "call") {
    return {
      status: 200,
      body: JSON.stringify(result.callDecision),
      headers: { "content-type": "application/json" },
    };
  }
  // Mail and text are fire-and-forget.
  return { status: 200, body: "ok" };
}
