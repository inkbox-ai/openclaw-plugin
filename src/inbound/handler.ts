import { RequestIdDedup } from "./dedup.js";
import { dispatchInbound, type InboundHandlers } from "./dispatch.js";
import { matchProvider } from "../webhook-providers/index.js";
import type { PluginLogger } from "../client.js";

export interface WebhookHandlerOptions {
  signingKey: string;
  handlers: InboundHandlers;
  dedup?: RequestIdDedup;
  logger?: PluginLogger;
  // Optional contact-id allowlist; passed through to dispatchInbound.
  allowedContactIds?: string[];
  // Opt-in gate for UNVERIFIED/UNKNOWN external delivery (and Inkbox-signed
  // payloads with no known event shape). Verified registered third-party
  // providers are delivered regardless — configuring their secret is the
  // opt-in. Defaults to false.
  externalEvents?: boolean;
}

export interface WebhookResponse {
  status: number;
  body?: string;
  headers?: Record<string, string>;
}

// Resolve the signing secret for a matched webhook provider. The provider
// (matched by header) tells us WHICH scheme to verify with; this maps that
// provider to ITS secret. Inkbox uses the configured signing key; any other
// source reads INKBOX_WEBHOOK_SECRET_<NAME> from the environment (empty when
// unset, which fails verification closed).
function providerSecret(providerName: string, signingKey: string): string {
  if (providerName === "inkbox") {
    return signingKey;
  }
  return process.env[`INKBOX_WEBHOOK_SECRET_${providerName.toUpperCase()}`] ?? "";
}

function parseJsonObject(bodyText: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return undefined;
  }
  // Every downstream reader assumes an object — reject bare scalars/arrays.
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

// Pure handler — accepts raw body + lowercase-keyed headers from any HTTP
// entry point (tunnel Fetch handler, registerHttpRoute Node handler, raw
// http server, test fixture) and returns the response to send.
//
// The request is classified BEFORE authentication: the source is identified
// by its signature header (each source has its own), verified with that
// source's scheme + secret, and only then routed — never on the body's
// claimed event_type alone. A forged payload therefore cannot impersonate an
// Inkbox event: routing keys off who actually signed the request.
export async function handleInkboxWebhook(
  bodyText: string,
  headers: Record<string, string>,
  opts: WebhookHandlerOptions,
): Promise<WebhookResponse> {
  const provider = matchProvider(headers);
  // Whether UNVERIFIED/UNKNOWN external payloads may wake the agent. Verified
  // registered third-party providers are NOT gated on this — configuring the
  // provider's secret is that source's opt-in.
  const externalOn =
    opts.externalEvents === true && typeof opts.handlers.onExternal === "function";

  if (provider && provider.name !== "inkbox") {
    // A registered third-party source claimed the request. Verify with its
    // scheme; an invalid (or unverifiable) signature is rejected outright.
    const ok = provider.verify({
      body: bodyText,
      headers,
      secret: providerSecret(provider.name, opts.signingKey),
    });
    if (!ok) {
      opts.logger?.warn?.(`Inkbox webhook ${provider.name} signature verification failed`);
      return { status: 401, body: "invalid signature" };
    }
    if (!opts.handlers.onExternal) {
      // Verified, but no external-delivery path is wired at all.
      return { status: 200, body: "ignored" };
    }
    const parsed = parseJsonObject(bodyText);
    if (!parsed) {
      return { status: 400, body: "invalid json" };
    }
    await opts.handlers.onExternal(parsed, { verified: true });
    return { status: 200, body: "ok" };
  }

  if (!provider) {
    // No registered source claimed the request. When the operator opted into
    // external events, deliver it UNVERIFIED (the directive downstream tells
    // the agent not to trust it); otherwise keep the strict legacy rejection.
    if (externalOn) {
      const parsed = parseJsonObject(bodyText);
      if (!parsed) {
        return { status: 400, body: "invalid json" };
      }
      await opts.handlers.onExternal!(parsed, { verified: false });
      return { status: 200, body: "ok" };
    }
    opts.logger?.warn?.(
      "Inkbox webhook missing required headers — no recognised signature header present",
    );
    return { status: 400, body: "missing inkbox webhook headers" };
  }

  // Inkbox-signed path.
  const requestId = headers["x-inkbox-request-id"];
  const signature = headers["x-inkbox-signature"];
  const timestamp = headers["x-inkbox-timestamp"];

  if (!requestId || !signature || !timestamp) {
    opts.logger?.warn?.(
      `Inkbox webhook missing required headers — request-id=${!!requestId} signature=${!!signature} timestamp=${!!timestamp}`,
    );
    return { status: 400, body: "missing inkbox webhook headers" };
  }

  // The provider does the timing-safe compare over
  // "{requestId}.{timestamp}.{body}" with HMAC-SHA256.
  const valid = provider.verify({
    body: bodyText,
    headers,
    secret: providerSecret(provider.name, opts.signingKey),
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

  // Inkbox-signed payloads with no known event shape are external — gated on
  // the externalEvents opt-in, so strip onExternal when the flag is off.
  const dispatchHandlers = externalOn
    ? opts.handlers
    : { ...opts.handlers, onExternal: undefined };
  let result: Awaited<ReturnType<typeof dispatchInbound>>;
  try {
    result = await dispatchInbound(parsed, dispatchHandlers, opts.allowedContactIds, {
      requestId,
    });
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
  // An Inkbox-signed payload with no known event shape: delivered to
  // onExternal by dispatchInbound when opted in, dropped without waking the
  // agent otherwise.
  if (result.kind === "external" && !externalOn) {
    return { status: 200, body: "ignored" };
  }
  // Mail and text are fire-and-forget.
  return { status: 200, body: "ok" };
}
