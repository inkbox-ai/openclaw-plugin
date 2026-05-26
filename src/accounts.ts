import type { InkboxPluginConfig } from "./client.js";

export const INKBOX_CHANNEL_ID = "inkbox" as const;
export const DEFAULT_ACCOUNT_ID = "default";

export type InkboxAccountConfig = Partial<InkboxPluginConfig> & {
  enabled?: boolean;
  name?: string;
  defaultTo?: string;
  vault?: {
    keyEnvVar?: string;
  };
};

export interface ResolvedInkboxAccount {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  config: InkboxAccountConfig;
  name?: string;
  defaultTo?: string;
  apiKey?: string;
  identity?: string;
  baseUrl?: string;
  signingKey?: string;
  publicUrl?: string;
  callWebsocketUrl?: string;
  tunnelName?: string;
}

type ResolveAccountParams = {
  cfg?: unknown;
  accountId?: string | null;
  pluginConfig?: unknown;
  env?: NodeJS.ProcessEnv;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries = value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return entries.length > 0 ? entries : undefined;
}

function readPluginConfig(cfg: unknown): Record<string, unknown> | undefined {
  if (!isRecord(cfg)) {
    return undefined;
  }
  const plugins = cfg.plugins;
  if (!isRecord(plugins)) {
    return undefined;
  }
  const entries = plugins.entries;
  if (!isRecord(entries)) {
    return undefined;
  }
  const inkbox = entries[INKBOX_CHANNEL_ID];
  if (!isRecord(inkbox)) {
    return undefined;
  }
  return isRecord(inkbox.config) ? inkbox.config : undefined;
}

function readChannelSection(cfg: unknown): Record<string, unknown> | undefined {
  if (!isRecord(cfg)) {
    return undefined;
  }
  const channels = cfg.channels;
  if (!isRecord(channels)) {
    return undefined;
  }
  const section = channels[INKBOX_CHANNEL_ID];
  return isRecord(section) ? section : undefined;
}

function readAccountSection(
  channelSection: Record<string, unknown> | undefined,
  accountId: string,
): Record<string, unknown> | undefined {
  const accounts = channelSection?.accounts;
  if (!isRecord(accounts)) {
    return undefined;
  }
  const account = accounts[accountId];
  return isRecord(account) ? account : undefined;
}

function normalizeSms(value: unknown): InkboxAccountConfig["sms"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: NonNullable<InkboxAccountConfig["sms"]> = {};
  for (const key of ["batchDelayMs", "maxMessages", "maxChars"] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeVault(value: unknown): InkboxAccountConfig["vault"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const keyEnvVar = nonEmptyString(value.keyEnvVar);
  return keyEnvVar ? { keyEnvVar } : undefined;
}

function normalizeVoiceRealtime(
  value: unknown,
): InkboxAccountConfig["voiceRealtime"] | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: NonNullable<InkboxAccountConfig["voiceRealtime"]> = {};
  if (typeof value.enabled === "boolean") {
    out.enabled = value.enabled;
  }
  for (const field of ["provider", "model", "voice", "instructions"] as const) {
    const resolved = nonEmptyString(value[field]);
    if (resolved) {
      out[field] = resolved;
    }
  }
  const toolPolicy = nonEmptyString(value.toolPolicy);
  if (
    toolPolicy === "safe-read-only" ||
    toolPolicy === "owner" ||
    toolPolicy === "none"
  ) {
    out.toolPolicy = toolPolicy;
  }
  const consultPolicy = nonEmptyString(value.consultPolicy);
  if (
    consultPolicy === "auto" ||
    consultPolicy === "substantive" ||
    consultPolicy === "always"
  ) {
    out.consultPolicy = consultPolicy;
  }
  if (isRecord(value.providers)) {
    out.providers = value.providers as Record<string, Record<string, unknown>>;
  }
  if (typeof value.fallbackToInkboxSttTts === "boolean") {
    out.fallbackToInkboxSttTts = value.fallbackToInkboxSttTts;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeConfig(value: unknown): InkboxAccountConfig {
  if (!isRecord(value)) {
    return {};
  }
  const out: InkboxAccountConfig = {};
  const stringFields = [
    "apiKey",
    "identity",
    "baseUrl",
    "signingKey",
    "tunnelName",
    "publicUrl",
    "callWebsocketUrl",
    "name",
    "defaultTo",
  ] as const;
  for (const field of stringFields) {
    const resolved = nonEmptyString(value[field]);
    if (resolved) {
      out[field] = resolved;
    }
  }
  if (typeof value.enabled === "boolean") {
    out.enabled = value.enabled;
  }
  if (
    typeof value.voiceTranscriptCoalesceMs === "number" &&
    Number.isFinite(value.voiceTranscriptCoalesceMs) &&
    value.voiceTranscriptCoalesceMs >= 0
  ) {
    out.voiceTranscriptCoalesceMs = value.voiceTranscriptCoalesceMs;
  }
  if (typeof value.voiceAgentPrewarm === "boolean") {
    out.voiceAgentPrewarm = value.voiceAgentPrewarm;
  }
  for (const field of ["voiceAgentPrewarmTtlMs", "voiceAgentPrewarmTimeoutMs"] as const) {
    const raw = value[field];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
      out[field] = raw;
    }
  }
  const allowedRecipients = stringArray(value.allowedRecipients);
  if (allowedRecipients) {
    out.allowedRecipients = allowedRecipients;
  }
  const allowedInboundContactIds = stringArray(value.allowedInboundContactIds);
  if (allowedInboundContactIds) {
    out.allowedInboundContactIds = allowedInboundContactIds;
  }
  const sms = normalizeSms(value.sms);
  if (sms) {
    out.sms = sms;
  }
  const vault = normalizeVault(value.vault);
  if (vault) {
    out.vault = vault;
  }
  const voiceRealtime = normalizeVoiceRealtime(value.voiceRealtime);
  if (voiceRealtime) {
    out.voiceRealtime = voiceRealtime;
  }
  return out;
}

function envConfig(env: NodeJS.ProcessEnv | undefined): InkboxAccountConfig {
  const e = env ?? process.env;
  return normalizeConfig({
    apiKey: e.INKBOX_API_KEY,
    identity: e.INKBOX_IDENTITY ?? e.INKBOX_AGENT_IDENTITY ?? e.INKBOX_AGENT_HANDLE,
    baseUrl: e.INKBOX_BASE_URL,
    signingKey: e.INKBOX_SIGNING_KEY,
    tunnelName: e.INKBOX_TUNNEL_NAME,
    publicUrl: e.INKBOX_PUBLIC_URL,
    callWebsocketUrl: e.INKBOX_CALL_WEBSOCKET_URL,
  });
}

function mergeConfig(...configs: Array<InkboxAccountConfig | undefined>): InkboxAccountConfig {
  const out: InkboxAccountConfig = {};
  for (const cfg of configs) {
    if (!cfg) {
      continue;
    }
    Object.assign(out, cfg);
    if (cfg.sms) {
      out.sms = { ...(out.sms ?? {}), ...cfg.sms };
    }
    if (cfg.vault) {
      out.vault = { ...(out.vault ?? {}), ...cfg.vault };
    }
  }
  return out;
}

function channelBaseConfig(section: Record<string, unknown> | undefined): InkboxAccountConfig {
  if (!section) {
    return {};
  }
  const { accounts: _accounts, defaultAccount: _defaultAccount, ...base } = section;
  return normalizeConfig(base);
}

export function resolveDefaultInkboxAccountId(cfg?: unknown): string {
  const section = readChannelSection(cfg);
  return nonEmptyString(section?.defaultAccount) ?? DEFAULT_ACCOUNT_ID;
}

export function listInkboxAccountIds(cfg?: unknown, env?: NodeJS.ProcessEnv): string[] {
  const ids = new Set<string>();
  const section = readChannelSection(cfg);
  const accounts = section?.accounts;
  if (isRecord(accounts)) {
    for (const key of Object.keys(accounts)) {
      if (key.trim()) {
        ids.add(key);
      }
    }
  }
  const defaultId = resolveDefaultInkboxAccountId(cfg);
  const base = mergeConfig(
    envConfig(env),
    normalizeConfig(readPluginConfig(cfg)),
    channelBaseConfig(section),
  );
  if (
    ids.size === 0 ||
    base.apiKey ||
    base.identity ||
    base.signingKey ||
    base.publicUrl ||
    base.tunnelName
  ) {
    ids.add(defaultId);
  }
  return [...ids];
}

export function resolveInkboxAccount(params: ResolveAccountParams = {}): ResolvedInkboxAccount {
  const accountId = params.accountId?.trim() || resolveDefaultInkboxAccountId(params.cfg);
  const section = readChannelSection(params.cfg);
  const config = mergeConfig(
    envConfig(params.env),
    normalizeConfig(readPluginConfig(params.cfg)),
    normalizeConfig(params.pluginConfig),
    channelBaseConfig(section),
    normalizeConfig(readAccountSection(section, accountId)),
  );
  const configured = Boolean(config.apiKey && config.identity);
  return {
    accountId,
    enabled: config.enabled !== false,
    configured,
    config,
    name: config.name,
    defaultTo: config.defaultTo,
    apiKey: config.apiKey,
    identity: config.identity,
    baseUrl: config.baseUrl,
    signingKey: config.signingKey,
    publicUrl: config.publicUrl,
    callWebsocketUrl: config.callWebsocketUrl,
    tunnelName: config.tunnelName,
  };
}

export function resolveInkboxToolsConfig(params: {
  pluginConfig?: unknown;
  readCurrentConfig?: () => unknown;
}): InkboxAccountConfig {
  let cfg: unknown;
  try {
    cfg = params.readCurrentConfig?.();
  } catch {
    cfg = undefined;
  }
  return resolveInkboxAccount({
    cfg,
    pluginConfig: params.pluginConfig,
  }).config;
}
