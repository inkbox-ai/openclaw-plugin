import type { Inkbox } from "@inkbox/sdk";
import { handleInkboxWebhook } from "./handler.js";
import { RequestIdDedup } from "./dedup.js";
import type { InboundHandlers } from "./dispatch.js";
import type { PluginLogger } from "../client.js";
import type { InkboxWsHandler } from "@inkbox/sdk/tunnels/connect";

export interface OpenTunnelOptions {
  inkbox: Inkbox;
  identityHandle: string;
  signingKey: string;
  // Optional override; defaults to identityHandle so the public URL is
  // stable across restarts.
  tunnelName?: string;
  handlers: InboundHandlers;
  wsHandler?: InkboxWsHandler;
  logger?: PluginLogger;
  allowedContactIds?: string[];
  // Opt-in for unverified/unknown external-webhook delivery; see
  // WebhookHandlerOptions.externalEvents.
  externalEvents?: boolean;
  serve?: boolean;
}

// The tunnel server idle-caps parked intake streams on a timer, and the SDK
// warns once per slot via bare console.warn each time — a healthy gateway
// emits these continuously, burying real logs. Drop exactly that line and
// pass everything else (401 owner-token, disconnects, ...) through.
const IDLE_CAP_WARNING_PARTS = [
  "/_system/intake slot=",
  "status=408",
  "reason=intake-idle-cap",
];

// Tags our wrapper so repeat installs can recognize it and no-op.
const WARN_FILTER_INSTALLED = Symbol.for("inkbox.tunnelWarnFilter");

export function isExpectedIdleCapWarning(first: unknown): boolean {
  return (
    typeof first === "string" &&
    IDLE_CAP_WARNING_PARTS.every((part) => first.includes(part))
  );
}

// Wrap console.warn once, keeping a reference to the original so every
// non-matching call passes through unchanged (fail-open). Idempotent.
export function installTunnelWarnFilter(): void {
  const current = console.warn as typeof console.warn & {
    [WARN_FILTER_INSTALLED]?: true;
  };
  if (current[WARN_FILTER_INSTALLED]) return;
  const wrapper = ((...args: unknown[]) => {
    if (isExpectedIdleCapWarning(args[0])) return;
    current(...args);
  }) as typeof console.warn & { [WARN_FILTER_INSTALLED]?: true };
  wrapper[WARN_FILTER_INSTALLED] = true;
  console.warn = wrapper;
}

// Open an Inkbox tunnel that terminates at our in-process Fetch handler.
// Returns the listener. By default this starts `.serveForever()` in the
// background; pass `serve: false` when the caller wants to drive it manually.
// Loaded via dynamic import because the tunnel data-plane runtime lives on
// a separate package subpath (POSIX-only, not browser-safe) — keeping it
// out of the main require graph means tool-only sessions don't pay the cost.
export async function openInkboxTunnel(opts: OpenTunnelOptions) {
  installTunnelWarnFilter();
  const { connect } = await import("@inkbox/sdk/tunnels/connect");
  const dedup = new RequestIdDedup(10000);

  const handler = async (req: Request): Promise<Response> => {
    const body = await req.text();
    // Normalize headers to lowercase keys so handleInkboxWebhook can index
    // by canonical name regardless of how the HTTP layer cased them.
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const result = await handleInkboxWebhook(body, headers, {
      signingKey: opts.signingKey,
      handlers: opts.handlers,
      dedup,
      logger: opts.logger,
      allowedContactIds: opts.allowedContactIds,
      externalEvents: opts.externalEvents,
    });
    return new Response(result.body ?? "", {
      status: result.status,
      headers: result.headers ?? { "content-type": "text/plain" },
    });
  };

  const listener = await connect(opts.inkbox, {
    name: opts.tunnelName ?? opts.identityHandle,
    handler,
    wsHandler: opts.wsHandler,
    installSignalHandlers: false,
  });
  opts.logger?.info?.(`Inkbox tunnel open at ${listener.publicUrl}`);
  if (opts.serve !== false) {
    listener.wait().catch((err: unknown) => {
      opts.logger?.warn?.(
        `Inkbox tunnel stopped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  return listener;
}
