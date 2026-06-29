import { verifyWebhook } from "@inkbox/sdk";
import { RequestIdDedup } from "./dedup.js";
import { dispatchInbound, type InboundHandlers } from "./dispatch.js";
import type { PluginLogger } from "../client.js";

export interface WebhookHandlerOptions {
  signingKey: string;
  handlers: InboundHandlers;
  dedup?: RequestIdDedup;
  logger?: PluginLogger;
  // Optional contact-id allowlist; passed through to dispatchInbound.
  allowedContactIds?: string[];
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
// Verification order: required-headers check → HMAC verify → dedup → JSON
// parse → dispatch. Do not let unauthenticated traffic poison dedup state.
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

  if (opts.dedup && !opts.dedup.begin(requestId)) {
    return { status: 200, body: "dup" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    opts.dedup?.rollback(requestId);
    return { status: 400, body: "invalid json" };
  }

  let result: Awaited<ReturnType<typeof dispatchInbound>>;
  try {
    result = await dispatchInbound(parsed, opts.handlers, opts.allowedContactIds);
  } catch (error) {
    opts.dedup?.rollback(requestId);
    throw error;
  }
  opts.dedup?.commit(requestId);

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
