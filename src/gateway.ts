import { createInkboxRuntime } from "./client.js";
import {
  INKBOX_CHANNEL_ID,
  listInkboxAccountIds,
  resolveInkboxAccount,
  type ResolvedInkboxAccount,
} from "./accounts.js";
import {
  inkboxCallWebsocketPath,
  inkboxWebhookPath,
  publicUrl,
  websocketUrl,
} from "./call-websocket.js";
import { openInkboxTunnel } from "./inbound/tunnel.js";
import { registerInboundHttpRoute } from "./inbound/http-route.js";
import {
  configureInkboxIdentityDelivery,
  createInkboxSessionBridge,
} from "./inbound/session.js";

type ChannelGatewayContext = {
  cfg: unknown;
  accountId: string;
  account: ResolvedInkboxAccount;
  abortSignal: AbortSignal;
  log?: {
    info?(msg: string): void;
    warn?(msg: string): void;
    error?(msg: string): void;
    debug?(msg: string): void;
  };
  setStatus(next: Record<string, unknown>): void;
  channelRuntime?: any;
};

const registeredPublicRoutes = new Set<string>();

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function routeKey(accountId: string, path: string): string {
  return `${accountId}:${path}`;
}

export function registerInkboxPublicUrlInboundRoutes(api: any): void {
  if (typeof api?.registerHttpRoute !== "function") {
    return;
  }
  let cfg: unknown;
  try {
    cfg = api.runtime?.config?.current?.();
  } catch {
    cfg = undefined;
  }
  for (const accountId of listInkboxAccountIds(cfg)) {
    const account = resolveInkboxAccount({
      cfg,
      accountId,
      pluginConfig: api.pluginConfig,
    });
    if (!account.configured || !account.config.signingKey || !account.config.publicUrl) {
      continue;
    }
    const path = inkboxWebhookPath(account.accountId);
    const key = routeKey(account.accountId, path);
    if (registeredPublicRoutes.has(key)) {
      continue;
    }
    registeredPublicRoutes.add(key);
    const runtime = createInkboxRuntime(account.config, api.logger);
    const bridge = createInkboxSessionBridge({
      cfg,
      account,
      runtime,
      channelRuntime: api.runtime?.channel,
      logger: api.logger,
    });
    registerInboundHttpRoute({
      api,
      path,
      signingKey: account.config.signingKey,
      handlers: bridge.handlers,
      allowedContactIds: account.config.allowedInboundContactIds,
      logger: api.logger,
    });
  }
}

export async function startInkboxGatewayAccount(ctx: ChannelGatewayContext): Promise<void> {
  const account = ctx.account;
  if (!account.configured) {
    throw new Error(`Inkbox is not configured for account "${account.accountId}".`);
  }
  if (!account.config.signingKey) {
    throw new Error(
      `Inkbox inbound delivery for account "${account.accountId}" requires signingKey.`,
    );
  }

  const runtime = createInkboxRuntime(account.config, ctx.log);
  let callWebsocketUrl: string | undefined;
  const bridge = createInkboxSessionBridge({
    cfg: ctx.cfg,
    account,
    runtime,
    channelRuntime: ctx.channelRuntime,
    logger: ctx.log,
    getCallWebsocketUrl: () => callWebsocketUrl,
  });

  ctx.setStatus({
    accountId: account.accountId,
    name: account.name,
    configured: true,
    enabled: account.enabled,
    running: true,
    mode: account.publicUrl ? "public-url" : "inkbox-tunnel",
  });

  if (account.publicUrl) {
    const webhookUrl = publicUrl(account.publicUrl, inkboxWebhookPath(account.accountId));
    await configureInkboxIdentityDelivery({
      runtime,
      webhookUrl,
      callWebhookUrl: webhookUrl,
      logger: ctx.log,
    });
    ctx.setStatus({
      accountId: account.accountId,
      running: true,
      connected: true,
      webhookUrl,
      mode: "public-url",
    });
    await waitForAbort(ctx.abortSignal);
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
    });
    return;
  }

  const inkbox = await runtime.getClient();
  const listener = await openInkboxTunnel({
    inkbox,
    identityHandle: account.identity!,
    signingKey: account.config.signingKey,
    tunnelName: account.tunnelName,
    handlers: bridge.handlers,
    wsHandler: bridge.wsHandler,
    allowedContactIds: account.config.allowedInboundContactIds,
    logger: ctx.log,
    serve: false,
  });
  const webhookUrl = publicUrl(listener.publicUrl, inkboxWebhookPath(account.accountId));
  callWebsocketUrl = websocketUrl(listener.publicUrl, inkboxCallWebsocketPath(account.accountId));
  const callWsContext = ctx.channelRuntime?.runtimeContexts?.register?.({
    channelId: INKBOX_CHANNEL_ID,
    accountId: account.accountId,
    capability: "call-websocket",
    context: {
      url: callWebsocketUrl,
    },
    abortSignal: ctx.abortSignal,
  });
  await configureInkboxIdentityDelivery({
    runtime,
    webhookUrl,
    callWebsocketUrl,
    logger: ctx.log,
  });
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    webhookUrl,
    mode: "inkbox-tunnel",
  });

  const closeOnAbort = () => {
    void listener.close();
  };
  ctx.abortSignal.addEventListener("abort", closeOnAbort, { once: true });
  try {
    await listener.wait();
  } finally {
    callWsContext?.dispose?.();
    ctx.abortSignal.removeEventListener("abort", closeOnAbort);
    await listener.close().catch(() => {});
    ctx.setStatus({
      accountId: account.accountId,
      running: false,
      connected: false,
      mode: "inkbox-tunnel",
    });
  }
}

export const INKBOX_STATUS_CHANNEL = INKBOX_CHANNEL_ID;
