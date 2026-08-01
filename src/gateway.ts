import { createInkboxRuntime } from "./client.js";
import {
  INKBOX_CHANNEL_ID,
  listInkboxAccountIds,
  resolveInkboxAccount,
  type ResolvedInkboxAccount,
} from "./accounts.js";
import {
  deriveConfiguredCallWebsocketUrl,
  inkboxCallWebsocketPath,
  inkboxWebhookPath,
  publicUrl,
  websocketUrl,
} from "./call-websocket.js";
import { openInkboxTunnel } from "./inbound/tunnel.js";
import { registerInboundHttpRoute } from "./inbound/http-route.js";
import { createInkboxWebSocketUpgradeHandler } from "./inbound/websocket-upgrade.js";
import { wrapInboundHandlersWithBatching } from "./inbound/batch.js";
import {
  configureInkboxIdentityDelivery,
  createInkboxSessionBridge,
  prewarmInkboxAgent,
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

function scheduleInkboxAgentPrewarm(
  ctx: ChannelGatewayContext,
  runtime: ReturnType<typeof createInkboxRuntime>,
  reason: string,
): void {
  void prewarmInkboxAgent({
    cfg: ctx.cfg,
    account: ctx.account,
    runtime,
    channelRuntime: ctx.channelRuntime,
    logger: ctx.log,
    reason,
  });
}

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
    const usesLocalVoiceStack =
      account.config.voiceStack === "openai_realtime" ||
      account.config.voiceStack === "inkbox_tts_stt";
    const callPath = inkboxCallWebsocketPath(account.accountId);
    const callKey = routeKey(account.accountId, callPath);
    const ownsCallRoute = usesLocalVoiceStack && !account.callWebsocketUrl;
    if (
      registeredPublicRoutes.has(key) &&
      (!ownsCallRoute || registeredPublicRoutes.has(callKey))
    ) {
      continue;
    }
    const runtime = createInkboxRuntime(account.config, api.logger);
    const bridge = createInkboxSessionBridge({
      cfg,
      account,
      runtime,
      channelRuntime: api.runtime?.channel,
      logger: api.logger,
    });
    const handlers = wrapInboundHandlersWithBatching(
      bridge.handlers,
      account.config,
      api.logger,
    );
    if (!registeredPublicRoutes.has(key)) {
      registerInboundHttpRoute({
        api,
        path,
        signingKey: account.config.signingKey,
        handlers,
        allowedContactIds: account.config.allowedInboundContactIds,
        externalEvents: account.config.externalEvents,
        logger: api.logger,
      });
      registeredPublicRoutes.add(key);
    }

    if (ownsCallRoute) {
      if (!registeredPublicRoutes.has(callKey)) {
        const publicWebsocketUrl = websocketUrl(account.publicUrl!, callPath);
        api.registerHttpRoute({
          path: callPath,
          auth: "plugin",
          match: "exact",
          handler: (_req: unknown, res: any) => {
            res.statusCode = 426;
            res.setHeader("connection", "Upgrade");
            res.setHeader("upgrade", "websocket");
            res.end("WebSocket upgrade required");
            return true;
          },
          handleUpgrade: createInkboxWebSocketUpgradeHandler({
            handler: bridge.wsHandler,
            publicWebsocketUrl,
            logger: api.logger,
          }),
        });
        registeredPublicRoutes.add(callKey);
      }
    }
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
  const handlers = wrapInboundHandlersWithBatching(bridge.handlers, account.config, ctx.log);

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
    const usesLocalVoiceStack =
      account.config.voiceStack === "openai_realtime" ||
      account.config.voiceStack === "inkbox_tts_stt";
    if (usesLocalVoiceStack) {
      callWebsocketUrl = deriveConfiguredCallWebsocketUrl(account);
    }
    const callWsContext = callWebsocketUrl
      ? ctx.channelRuntime?.runtimeContexts?.register?.({
          channelId: INKBOX_CHANNEL_ID,
          accountId: account.accountId,
          capability: "call-websocket",
          context: { url: callWebsocketUrl },
          abortSignal: ctx.abortSignal,
        })
      : undefined;
    try {
      await configureInkboxIdentityDelivery({
        runtime,
        webhookUrl,
        ...(callWebsocketUrl
          ? { callWebsocketUrl }
          : account.config.voiceStack === "inkbox_voice_ai"
            ? {}
            : { callWebhookUrl: webhookUrl }),
        voiceStack: account.config.voiceStack,
        logger: ctx.log,
      });
      await bridge.catchUpA2A();
      await bridge.catchUpHostedCalls();
      ctx.setStatus({
        accountId: account.accountId,
        running: true,
        connected: true,
        webhookUrl,
        mode: "public-url",
      });
      scheduleInkboxAgentPrewarm(ctx, runtime, "public-url-gateway-start");
      await waitForAbort(ctx.abortSignal);
    } finally {
      callWsContext?.dispose?.();
      ctx.setStatus({
        accountId: account.accountId,
        running: false,
        connected: false,
      });
    }
    return;
  }

  const inkbox = await runtime.getClient();
  const listener = await openInkboxTunnel({
    inkbox,
    identityHandle: account.identity!,
    signingKey: account.config.signingKey,
    tunnelName: account.tunnelName,
    handlers,
    wsHandler: bridge.wsHandler,
    allowedContactIds: account.config.allowedInboundContactIds,
    externalEvents: account.config.externalEvents,
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
    ...(account.config.voiceStack === "inkbox_voice_ai"
      ? {}
      : { callWebsocketUrl }),
    voiceStack: account.config.voiceStack,
    logger: ctx.log,
  });
  await bridge.catchUpA2A();
  await bridge.catchUpHostedCalls();
  ctx.setStatus({
    accountId: account.accountId,
    running: true,
    connected: true,
    webhookUrl,
    mode: "inkbox-tunnel",
  });
  scheduleInkboxAgentPrewarm(ctx, runtime, "tunnel-gateway-start");

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
