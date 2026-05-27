import { handleInkboxWebhook } from "./handler.js";
import { RequestIdDedup } from "./dedup.js";
import type { InboundHandlers } from "./dispatch.js";
import type { PluginLogger } from "../client.js";

export interface RegisterHttpRouteOptions {
  api: any;
  path?: string;
  signingKey: string;
  handlers: InboundHandlers;
  allowedContactIds?: string[];
  logger?: PluginLogger;
}

// Alternative inbound path for users whose OpenClaw is already on a publicly
// reachable URL. Skips the Inkbox tunnel entirely. Mail/text webhook
// subscriptions and phone incoming-call delivery must point at
// `<publicUrl><path>` (default path `/inkbox/webhook`). The same pure handler
// is used as for the tunnel path, so HMAC verify + dedup + dispatch behave
// identically.
export function registerInboundHttpRoute(opts: RegisterHttpRouteOptions): void {
  const dedup = new RequestIdDedup(10000);
  const path = opts.path ?? "/inkbox/webhook";

  if (typeof opts.api.registerHttpRoute !== "function") {
    opts.logger?.warn?.(
      "Inkbox publicUrl override requested, but api.registerHttpRoute is not available on this OpenClaw build. Falling back to no inbound delivery.",
    );
    return;
  }

  opts.api.registerHttpRoute({
    path,
    // Plugin-managed auth: we verify HMAC inside the handler. OpenClaw's
    // built-in gateway auth would reject the unsigned webhook payloads.
    auth: "plugin",
    handler: async (req: any, res: any) => {
      try {
        // OpenClaw routes use Node-style req/res. Read the raw body bytes
        // — verifyWebhook needs the exact body as transmitted, not a
        // re-stringified JSON object.
        const body: string = await readBody(req);
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers ?? {})) {
          if (typeof v === "string") headers[k.toLowerCase()] = v;
          else if (Array.isArray(v) && typeof v[0] === "string")
            headers[k.toLowerCase()] = v[0];
        }
        const result = await handleInkboxWebhook(body, headers, {
          signingKey: opts.signingKey,
          handlers: opts.handlers,
          dedup,
          logger: opts.logger,
          allowedContactIds: opts.allowedContactIds,
        });
        res.statusCode = result.status;
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            res.setHeader(k, v);
          }
        }
        res.end(result.body ?? "");
        return true;
      } catch (err) {
        opts.logger?.warn?.(
          `Inkbox http route error: ${err instanceof Error ? err.message : String(err)}`,
        );
        res.statusCode = 500;
        res.end("internal error");
        return true;
      }
    },
  });

  opts.logger?.info?.(`Inkbox inbound HTTP route registered at ${path}`);
}

// Read a Node request body as a UTF-8 string.
function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", (e: Error) => reject(e));
  });
}
