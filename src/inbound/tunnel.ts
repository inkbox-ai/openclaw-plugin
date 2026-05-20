import type { Inkbox } from "@inkbox/sdk";
import { handleInkboxWebhook } from "./handler.js";
import { RequestIdDedup } from "./dedup.js";
import type { InboundHandlers } from "./dispatch.js";
import type { PluginLogger } from "../client.js";

export interface OpenTunnelOptions {
  inkbox: Inkbox;
  identityHandle: string;
  signingKey: string;
  // Optional override; defaults to identityHandle so the public URL is
  // stable across restarts.
  tunnelName?: string;
  handlers: InboundHandlers;
  logger?: PluginLogger;
  allowedContactIds?: string[];
}

// Open an Inkbox tunnel that terminates at our in-process Fetch handler.
// Returns the listener — caller is responsible for awaiting `.wait()` or
// keeping the reference alive for as long as inbound delivery is wanted.
// Loaded via dynamic import because the tunnel data-plane runtime lives on
// a separate package subpath (POSIX-only, not browser-safe) — keeping it
// out of the main require graph means tool-only sessions don't pay the cost.
export async function openInkboxTunnel(opts: OpenTunnelOptions) {
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
    });
    return new Response(result.body ?? "", {
      status: result.status,
      headers: result.headers ?? { "content-type": "text/plain" },
    });
  };

  const listener = await connect(opts.inkbox, {
    name: opts.tunnelName ?? opts.identityHandle,
    handler,
  });
  opts.logger?.info?.(`Inkbox tunnel open at ${listener.publicUrl}`);
  return listener;
}
