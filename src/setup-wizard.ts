import {
  InkboxAPIError,
  Inkbox,
  type AgentIdentity,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED,
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED,
  AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED,
} from "@inkbox/sdk";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import JSON5 from "json5";
import type { Prompter } from "./prompt.js";
import { writeIdentityState, readIdentityState } from "./state.js";
import { DEFAULT_ACCOUNT_ID, resolveInkboxAccount } from "./accounts.js";
import {
  inkboxCallWebsocketPath,
  inkboxWebhookPath,
  publicUrl,
  websocketUrl,
} from "./call-websocket.js";
import {
  IMESSAGE_EVENT_TYPES,
  MAIL_EVENT_TYPES,
  TEXT_EVENT_TYPES,
  reconcileWebhookSubscription,
} from "./inbound/subscriptions.js";

export interface WizardConfig {
  apiKey: string;
  identity: string;
  signingKey?: string;
  baseUrl?: string;
  tunnelName?: string;
  voiceRealtime?: WizardVoiceRealtimeConfig;
}

export interface WizardVoiceRealtimeConfig {
  enabled: boolean;
  provider: string;
  model?: string;
  voice?: string;
  instructions?: string;
  toolPolicy: "safe-read-only" | "owner" | "none";
  consultPolicy: "auto" | "substantive" | "always";
  providers?: Record<string, Record<string, unknown>>;
  fallbackToInkboxSttTts: boolean;
}

export interface WizardPersistResult {
  ok: boolean;
  message?: string;
}

export type WizardConfigPersister = (
  config: WizardConfig,
  context: { currentConfig?: unknown; env: NodeJS.ProcessEnv },
) => Promise<WizardPersistResult>;

export interface WizardOptions {
  prompter: Prompter;
  currentConfig?: unknown;
  persistConfig?: WizardConfigPersister;
  validateOpenAiRealtimeApiKey?: OpenAiRealtimeValidator;
  // Lets tests inject env without poking process.env.
  env?: NodeJS.ProcessEnv;
}

export interface WizardResult {
  ok: boolean;
  message?: string;
  config?: WizardConfig;
  persisted?: boolean;
}

const SMS_OPT_IN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const SMS_OPT_IN_POLL_MS = 3000;
const IMESSAGE_CONNECT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const IMESSAGE_CONNECT_POLL_MS = 3000;
const SELF_SIGNUP_VERIFICATION_NOTE = "OpenClaw Inkbox plugin setup";
const OPENAI_REALTIME_MODEL = "gpt-realtime-2";
const OPENAI_REALTIME_VOICE = "cedar";
const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
const requireOptional = createRequire(import.meta.url);

export type OpenAiRealtimeValidationResult =
  | { ok: true; message?: string }
  | { ok: false; message: string };

export type OpenAiRealtimeValidator = (
  apiKey: string,
  model: string,
) => Promise<OpenAiRealtimeValidationResult>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStartText(text: string | null | undefined): boolean {
  return text?.trim().toUpperCase() === "START";
}

export function smsToQrPayload(number: string, body: string): string {
  return `SMSTO:${number}:${body}`;
}

function smsDraftLink(number: string, body: string): string {
  return `sms:${number}?&body=${encodeURIComponent(body)}`;
}

export function showQr(data: string): boolean {
  if (!process.stdout.isTTY) {
    return false;
  }
  try {
    const qr = requireOptional("qrcode-terminal") as {
      generate: (
        input: string,
        options: { small: boolean },
        callback: (output: string) => void,
      ) => void;
    };
    qr.generate(data, { small: true }, (output) => console.log(output));
    return true;
  } catch {
    return false;
  }
}

function normalizeOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readPath(root: unknown, path: string[]): unknown {
  let cur = root;
  for (const part of path) {
    if (!isRecord(cur)) {
      return undefined;
    }
    cur = cur[part];
  }
  return cur;
}

function addUniqueString(value: unknown, entry: string): string[] {
  const existing = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  return existing.includes(entry) ? existing : [...existing, entry];
}

function resolveHome(env: NodeJS.ProcessEnv): string {
  return env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir();
}

function resolveUserPath(input: string, env: NodeJS.ProcessEnv): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return resolveHome(env);
  }
  if (trimmed.startsWith("~/")) {
    return join(resolveHome(env), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? trimmed : resolve(trimmed);
}

function resolveOpenClawConfigPath(env: NodeJS.ProcessEnv): string {
  const explicitConfig = env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicitConfig) {
    return resolveUserPath(explicitConfig, env);
  }
  const stateDir = env.OPENCLAW_STATE_DIR?.trim()
    ? resolveUserPath(env.OPENCLAW_STATE_DIR, env)
    : join(resolveHome(env), ".openclaw");
  return join(stateDir, "openclaw.json");
}

function toolAllowOperation(currentConfig: unknown): { path: string; value: string[] } {
  const allow = readPath(currentConfig, ["tools", "allow"]);
  if (Array.isArray(allow)) {
    return { path: "tools.allow", value: addUniqueString(allow, "inkbox") };
  }
  const alsoAllow = readPath(currentConfig, ["tools", "alsoAllow"]);
  if (Array.isArray(alsoAllow)) {
    return { path: "tools.alsoAllow", value: addUniqueString(alsoAllow, "inkbox") };
  }
  const profile = readPath(currentConfig, ["tools", "profile"]);
  if (typeof profile === "string" && profile.trim()) {
    return { path: "tools.alsoAllow", value: ["inkbox"] };
  }
  return { path: "tools.allow", value: ["inkbox"] };
}

export function buildOpenClawConfigBatch(
  config: WizardConfig,
  currentConfig?: unknown,
): Array<{ path: string; value: unknown }> {
  const batch: Array<{ path: string; value: unknown }> = [
    { path: "channels.inkbox.enabled", value: true },
    { path: "channels.inkbox.apiKey", value: config.apiKey },
    { path: "channels.inkbox.identity", value: config.identity },
  ];
  if (config.signingKey) {
    batch.push({ path: "channels.inkbox.signingKey", value: config.signingKey });
  }
  if (config.baseUrl) {
    batch.push({ path: "channels.inkbox.baseUrl", value: config.baseUrl });
  }
  if (config.tunnelName) {
    batch.push({ path: "channels.inkbox.tunnelName", value: config.tunnelName });
  }
  if (config.voiceRealtime) {
    batch.push({ path: "channels.inkbox.voiceRealtime", value: config.voiceRealtime });
  }
  batch.push(toolAllowOperation(currentConfig));
  return batch;
}

function setConfigPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  let cur: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const existing = cur[part];
    if (!isRecord(existing)) {
      cur[part] = {};
    }
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

async function readOpenClawConfig(path: string): Promise<Record<string, unknown>> {
  if (!existsSync(path)) {
    return {};
  }
  const raw = await readFile(path, "utf8");
  if (!raw.trim()) {
    return {};
  }
  const parsed = JSON5.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error(`OpenClaw config at ${path} must contain a JSON object.`);
  }
  return parsed;
}

export async function persistOpenClawConfigFile(
  config: WizardConfig,
  context: { currentConfig?: unknown; env: NodeJS.ProcessEnv },
): Promise<WizardPersistResult> {
  const configPath = resolveOpenClawConfigPath(context.env);
  try {
    const next = await readOpenClawConfig(configPath);
    const batch = buildOpenClawConfigBatch(config, context.currentConfig ?? next);
    for (const entry of batch) {
      setConfigPath(next, entry.path, entry.value);
    }
    await mkdir(dirname(configPath), { recursive: true });
    const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await chmod(tempPath, 0o600).catch(() => {});
    await rename(tempPath, configPath);
    await chmod(configPath, 0o600).catch(() => {});
    return { ok: true, message: `Updated ${configPath}` };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function summarizeIdentity(identity: {
  agentHandle: string;
  displayName?: string | null;
  emailAddress?: string | null;
  mailbox?: { emailAddress?: string | null } | null;
  phoneNumber?: { number?: string | null; type?: string | null; smsStatus?: string | null } | null;
}): string {
  const parts = [identity.agentHandle];
  if (identity.displayName) parts.push(`display=${identity.displayName}`);
  const email = identity.mailbox?.emailAddress ?? identity.emailAddress;
  if (email) parts.push(`email=${email}`);
  if (identity.phoneNumber?.number) {
    const smsStatus = identity.phoneNumber.smsStatus ? ` sms=${identity.phoneNumber.smsStatus}` : "";
    parts.push(`phone=${identity.phoneNumber.number}${smsStatus}`);
  }
  return parts.join("  ");
}

function messageFromError(error: unknown): string {
  if (error instanceof InkboxAPIError) {
    const detail =
      typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail ?? {});
    return `HTTP ${error.statusCode} ${detail}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function maskSecret(secret: string): string {
  const trimmed = secret.trim();
  if (trimmed.length <= 8) {
    return "*".repeat(trimmed.length);
  }
  return `${trimmed.slice(0, 6)}${"*".repeat(Math.max(8, trimmed.length - 10))}${trimmed.slice(-4)}`;
}

function defaultVoiceRealtimeConfig(
  enabled: boolean,
  apiKey?: string,
): WizardVoiceRealtimeConfig {
  return {
    enabled,
    provider: "openai",
    model: OPENAI_REALTIME_MODEL,
    voice: OPENAI_REALTIME_VOICE,
    toolPolicy: "owner",
    consultPolicy: "substantive",
    fallbackToInkboxSttTts: true,
    ...(apiKey
      ? {
          providers: {
            openai: {
              apiKey,
              model: OPENAI_REALTIME_MODEL,
              voice: OPENAI_REALTIME_VOICE,
            },
          },
        }
      : {}),
  };
}

function parseOpenAiRealtimeValidationMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const error = payload.error;
  if (isRecord(error)) {
    const message = typeof error.message === "string" ? error.message : undefined;
    const code = typeof error.code === "string" ? error.code : undefined;
    const type = typeof error.type === "string" ? error.type : undefined;
    return [code ?? type, message].filter(Boolean).join(": ") || undefined;
  }
  const message = payload.message;
  return typeof message === "string" ? message : undefined;
}

export async function validateOpenAiRealtimeApiKey(
  apiKey: string,
  model = OPENAI_REALTIME_MODEL,
): Promise<OpenAiRealtimeValidationResult> {
  let response: Response;
  try {
    response = await fetch(OPENAI_REALTIME_CLIENT_SECRETS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: 60 },
        session: { type: "realtime", model },
      }),
    });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    return {
      ok: false,
      message:
        parseOpenAiRealtimeValidationMessage(payload) ??
        `HTTP ${response.status} ${response.statusText}`,
    };
  }
  return { ok: true };
}

type DetectedOpenAiApiKey = {
  apiKey: string;
  source: string;
};

function stringFromPath(root: unknown, path: string[]): string | undefined {
  const value = readPath(root, path);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getExistingVoiceRealtimeConfig(existingAccount: {
  config?: { voiceRealtime?: unknown };
}): unknown {
  return existingAccount.config?.voiceRealtime;
}

function resolveOpenClawStateDir(env: NodeJS.ProcessEnv): string {
  const explicitStateDir = env.OPENCLAW_STATE_DIR?.trim();
  return explicitStateDir
    ? resolveUserPath(explicitStateDir, env)
    : join(resolveHome(env), ".openclaw");
}

function resolveOpenClawAgentId(currentConfig: unknown, env: NodeJS.ProcessEnv): string {
  const envAgentId = env.OPENCLAW_AGENT_ID?.trim();
  if (envAgentId) {
    return envAgentId;
  }
  const configAgentId =
    stringFromPath(currentConfig, ["agents", "defaults", "id"]) ??
    stringFromPath(currentConfig, ["agents", "default", "id"]);
  return configAgentId ?? "main";
}

function resolveAuthProfilesPath(currentConfig: unknown, env: NodeJS.ProcessEnv): string {
  const explicitPath = env.OPENCLAW_AUTH_PROFILES_PATH?.trim();
  if (explicitPath) {
    return resolveUserPath(explicitPath, env);
  }
  const agentId = resolveOpenClawAgentId(currentConfig, env);
  return join(resolveOpenClawStateDir(env), "agents", agentId, "agent", "auth-profiles.json");
}

function configuredOpenAiProfileIds(currentConfig: unknown): string[] {
  const ids: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value.trim() && !ids.includes(value.trim())) {
      ids.push(value.trim());
    }
  };

  const ordered = readPath(currentConfig, ["auth", "order", "openai"]);
  if (Array.isArray(ordered)) {
    ordered.forEach(add);
  }

  const configProfiles = readPath(currentConfig, ["auth", "profiles"]);
  if (isRecord(configProfiles)) {
    for (const [profileId, profile] of Object.entries(configProfiles)) {
      if (!isRecord(profile)) {
        continue;
      }
      const provider = typeof profile.provider === "string" ? profile.provider : "";
      const mode = typeof profile.mode === "string" ? profile.mode : "";
      if (provider === "openai" && mode === "api_key") {
        add(profileId);
      }
    }
  }

  add("openai:default");
  return ids;
}

function resolveProfileApiKey(profile: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (!isRecord(profile)) {
    return undefined;
  }
  if (profile.provider !== "openai" || profile.type !== "api_key") {
    return undefined;
  }
  if (typeof profile.key === "string" && profile.key.trim()) {
    return profile.key.trim();
  }
  const keyRef = profile.keyRef;
  if (isRecord(keyRef) && keyRef.source === "env" && typeof keyRef.id === "string") {
    const value = env[keyRef.id]?.trim();
    return value || undefined;
  }
  return undefined;
}

async function detectOpenAiApiKeyFromAuthProfiles(
  currentConfig: unknown,
  env: NodeJS.ProcessEnv,
): Promise<DetectedOpenAiApiKey | undefined> {
  const profilesPath = resolveAuthProfilesPath(currentConfig, env);
  if (!existsSync(profilesPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(profilesPath, "utf8"));
  } catch {
    return undefined;
  }

  const profiles = readPath(parsed, ["profiles"]);
  if (!isRecord(profiles)) {
    return undefined;
  }

  for (const profileId of configuredOpenAiProfileIds(currentConfig)) {
    const apiKey = resolveProfileApiKey(profiles[profileId], env);
    if (apiKey) {
      return {
        apiKey,
        source: `OpenClaw auth profile ${profileId}`,
      };
    }
  }

  for (const [profileId, profile] of Object.entries(profiles)) {
    const apiKey = resolveProfileApiKey(profile, env);
    if (apiKey) {
      return {
        apiKey,
        source: `OpenClaw auth profile ${profileId}`,
      };
    }
  }

  return undefined;
}

async function detectOpenAiApiKey(params: {
  currentConfig: unknown;
  existingAccount: { config?: { voiceRealtime?: unknown } };
  env: NodeJS.ProcessEnv;
}): Promise<DetectedOpenAiApiKey | undefined> {
  const explicitRealtimeKey =
    stringFromPath(params.currentConfig, [
      "channels",
      "inkbox",
      "voiceRealtime",
      "providers",
      "openai",
      "apiKey",
    ]) ??
    stringFromPath(getExistingVoiceRealtimeConfig(params.existingAccount), [
      "providers",
      "openai",
      "apiKey",
    ]);
  if (explicitRealtimeKey) {
    return {
      apiKey: explicitRealtimeKey,
      source: "channels.inkbox.voiceRealtime.providers.openai.apiKey",
    };
  }

  const fromRealtimeEnv = params.env.INKBOX_REALTIME_API_KEY?.trim();
  if (fromRealtimeEnv) {
    return {
      apiKey: fromRealtimeEnv,
      source: "INKBOX_REALTIME_API_KEY",
    };
  }

  const fromAuthProfile = await detectOpenAiApiKeyFromAuthProfiles(params.currentConfig, params.env);
  if (fromAuthProfile) {
    return fromAuthProfile;
  }

  const fromEnv = params.env.OPENAI_API_KEY?.trim();
  if (fromEnv) {
    return { apiKey: fromEnv, source: "OPENAI_API_KEY" };
  }

  return undefined;
}

async function promptForOpenAiRealtimeConfig(params: {
  currentConfig: unknown;
  existingAccount: { config?: { voiceRealtime?: unknown } };
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
  validate: OpenAiRealtimeValidator;
}): Promise<WizardVoiceRealtimeConfig | undefined> {
  let detected = await detectOpenAiApiKey({
    currentConfig: params.currentConfig,
    existingAccount: params.existingAccount,
    env: params.env,
  });

  console.log("\nOpenAI Realtime calls:");
  console.log(
    "  Phone calls can use raw Inkbox call media through OpenAI Realtime instead of Inkbox STT/TTS.",
  );
  let defaultOptIn = Boolean(detected);
  let promptForKey = false;
  if (detected) {
    console.log(`  Found an OpenAI API key in ${detected.source}.`);
  } else {
    console.log("  No OpenAI API key was found for this OpenClaw agent.");
    console.log(
      "  If you enable Realtime calls, the next step will ask for an OpenAI API key and validate Realtime access.",
    );
  }

  for (;;) {
    const useRealtime = await params.prompter.confirm(
      "Use OpenAI Realtime API for phone calls?",
      Boolean(detected),
    );
    if (!useRealtime) {
      console.log("OpenAI Realtime calls disabled. Calls will use Inkbox STT/TTS.");
      return defaultVoiceRealtimeConfig(false);
    }

    const apiKey =
      promptForKey || !detected?.apiKey
        ? normalizeOptional(
            await params.prompter.ask("Paste your OpenAI API key for Realtime calls"),
          )
        : detected.apiKey;
    if (!apiKey) {
      console.log("No OpenAI API key entered. Realtime disabled; calls will use Inkbox STT/TTS.");
      return defaultVoiceRealtimeConfig(false);
    }

    console.log(`Testing OpenAI Realtime access with ${OPENAI_REALTIME_MODEL}...`);
    const validation = await params.validate(apiKey, OPENAI_REALTIME_MODEL);
    if (validation.ok) {
      console.log("OpenAI Realtime validation passed. Calls will use OpenAI Realtime.");
      return defaultVoiceRealtimeConfig(true, apiKey);
    }

    console.log("OpenAI Realtime validation failed.");
    console.log(`  ${validation.message.replaceAll(apiKey, maskSecret(apiKey))}`);
    console.log("  Realtime remains disabled. Try another key, or answer no to use Inkbox STT/TTS.");
    defaultOptIn = true;
    promptForKey = true;
    detected = undefined;
  }
}

function hostFromPublicHost(publicHost: string | null | undefined): string | undefined {
  const trimmed = publicHost?.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).host;
  } catch {
    return undefined;
  }
}

function deriveTunnelName(identity: AgentIdentity, identityHandle: string): string | undefined {
  const explicitName =
    typeof (identity.tunnel as any)?.name === "string"
      ? (identity.tunnel as any).name.trim()
      : "";
  if (explicitName) {
    return explicitName;
  }
  const host = hostFromPublicHost(identity.tunnel?.publicHost);
  const suffix = ".inkboxwire.com";
  if (host?.endsWith(suffix)) {
    const name = host.slice(0, -suffix.length);
    return name || undefined;
  }
  return identityHandle;
}

function identityTunnelBaseUrl(identity: AgentIdentity, identityHandle: string): string | undefined {
  const host = hostFromPublicHost(identity.tunnel?.publicHost);
  if (host) {
    return `https://${host}`;
  }
  const tunnelName = deriveTunnelName(identity, identityHandle);
  return tunnelName ? `https://${tunnelName}.inkboxwire.com` : undefined;
}

async function configureIdentityGatewayDelivery(params: {
  client: Inkbox;
  identity: AgentIdentity;
  identityHandle: string;
}): Promise<{ webhookUrl?: string; callWebsocketUrl?: string; tunnelName?: string }> {
  const baseUrl = identityTunnelBaseUrl(params.identity, params.identityHandle);
  if (!baseUrl) {
    console.log(
      "Skipping automatic inbound delivery setup because this identity has no Inkbox tunnel.",
    );
    return {};
  }

  const webhookUrl = publicUrl(baseUrl, inkboxWebhookPath(DEFAULT_ACCOUNT_ID));
  const callWebsocketUrl = websocketUrl(
    baseUrl,
    inkboxCallWebsocketPath(DEFAULT_ACCOUNT_ID),
  );

  const mailboxId = params.identity.mailbox?.id;
  if (mailboxId) {
    const mailSub = await reconcileWebhookSubscription(params.client, {
      mailboxId,
      url: webhookUrl,
      eventTypes: MAIL_EVENT_TYPES,
    });
    if (mailSub) {
      console.log(`Mailbox events subscribed at ${webhookUrl}.`);
    } else {
      console.log(
        `Mailbox subscription was not created — see the warning above. Inbound email will not arrive at ${webhookUrl} until that is resolved.`,
      );
    }
  } else if (params.identity.mailbox?.emailAddress) {
    console.log(
      `Mailbox ${params.identity.mailbox.emailAddress} has no id yet; skipping mail subscription.`,
    );
  }

  if (params.identity.phoneNumber?.id) {
    const textSub = await reconcileWebhookSubscription(params.client, {
      phoneNumberId: params.identity.phoneNumber.id,
      url: webhookUrl,
      eventTypes: TEXT_EVENT_TYPES,
    });
    await params.client.phoneNumbers.update(params.identity.phoneNumber.id, {
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: callWebsocketUrl,
      incomingCallWebhookUrl: null,
    });
    if (textSub) {
      console.log(
        `Phone text events subscribed at ${webhookUrl}; incoming calls bridge to ${callWebsocketUrl}.`,
      );
    } else {
      console.log(
        `Phone text subscription was not created — see the warning above. Incoming calls still bridge to ${callWebsocketUrl}.`,
      );
    }
  }

  // iMessage events are owned by the agent identity, not a phone number —
  // the channel rides shared Inkbox-managed lines. Only valid while the
  // identity is iMessage-enabled.
  if (params.identity.imessageEnabled && params.identity.id) {
    const imessageSub = await reconcileWebhookSubscription(params.client, {
      agentIdentityId: params.identity.id,
      url: webhookUrl,
      eventTypes: IMESSAGE_EVENT_TYPES,
    });
    if (imessageSub) {
      console.log(`iMessage events subscribed at ${webhookUrl}.`);
    } else {
      console.log(
        `iMessage subscription was not created — see the warning above. Inbound iMessage will not arrive at ${webhookUrl} until that is resolved.`,
      );
    }
  }

  const tunnelName = deriveTunnelName(params.identity, params.identityHandle);
  return {
    webhookUrl,
    callWebsocketUrl,
    ...(tunnelName && tunnelName !== params.identityHandle ? { tunnelName } : {}),
  };
}

function printInkboxAuthorizationInfo(): void {
  console.log("\nInkbox authorization lives server-side via contact rules:");
  console.log("  https://console.inkbox.ai -> Mailboxes / Phone Numbers -> Contact Rules");
  console.log(
    "Anyone Inkbox lets through reaches the agent; this wizard does not create a second local inbound allowlist.",
  );
}

function printAgentSummary(identity: AgentIdentity): void {
  console.log("\nInkbox configured\n");
  console.log(`  Handle:  ${identity.agentHandle}`);
  const email = identity.mailbox?.emailAddress ?? identity.emailAddress;
  console.log(`  Mailbox: ${email ?? "(none - set up later in the Inkbox console)"}`);
  if (identity.phoneNumber) {
    const smsStatus = identity.phoneNumber.smsStatus ? `; SMS: ${identity.phoneNumber.smsStatus}` : "";
    console.log(`  Phone:   ${identity.phoneNumber.number} (${identity.phoneNumber.type}${smsStatus})`);
    if (identity.phoneNumber.type === "local") {
      console.log("\nSMS opt-in:");
      console.log(`  Text START to ${identity.phoneNumber.number} from each phone this agent should text.`);
      console.log("\n  Or just scan this with your phone camera to draft that text in one tap:");
      const qrPayload = smsToQrPayload(identity.phoneNumber.number, "START");
      const fallbackLink = smsDraftLink(identity.phoneNumber.number, "START");
      if (!showQr(qrPayload)) {
        console.log(`    (install qrcode-terminal to show a scannable QR here: ${fallbackLink})`);
      }
    }
  } else {
    console.log("  Phone:   (none - provision later in the Inkbox console)");
  }
  if (identity.imessageEnabled) {
    console.log("  iMessage: enabled (people connect via the Inkbox iMessage router)");
  }
  console.log("\nReachability rules:");
  console.log("  Manage who can reach this agent at https://inkbox.ai/console/contact-rules");
  console.log("  Use mailbox and phone contact rules for email senders, domains, and phone numbers.");
}

function printProvisionedPhoneStatus(phone: { number?: string | null; smsStatus?: string | null }): void {
  const smsStatus = phone.smsStatus?.trim().toLowerCase();
  if (smsStatus === "ready") {
    console.log(`Provisioned ${phone.number}. SMS is ready.`);
    return;
  }
  const statusLabel = smsStatus ? ` Current SMS status: ${smsStatus}.` : "";
  console.log(
    `Provisioned ${phone.number}. SMS will be ready in ~10-15 min once 10DLC carrier propagation completes.${statusLabel}`,
  );
}

async function maybeProvisionPhoneNumber(
  identity: AgentIdentity,
  prompter: Prompter,
): Promise<{ identity: AgentIdentity; didProvisionPhone: boolean }> {
  if (identity.phoneNumber) {
    return { identity, didProvisionPhone: false };
  }
  const wantPhone = await prompter.confirm(
    "This identity has no phone number. Provision a local number for SMS + voice now?",
    true,
  );
  if (!wantPhone) {
    return { identity, didProvisionPhone: false };
  }
  try {
    const phone = await identity.provisionPhoneNumber({ type: "local" });
    printProvisionedPhoneStatus(phone);
    return { identity: await identity.refresh(), didProvisionPhone: true };
  } catch (error) {
    console.log(`Phone provisioning failed: ${messageFromError(error)}`);
    console.log("You can provision a number later in the Inkbox console.");
    return { identity, didProvisionPhone: false };
  }
}

async function discoverAgentIdentityHandle(
  client: Inkbox,
  env: NodeJS.ProcessEnv,
  prompter: Prompter,
): Promise<string> {
  const fromEnv = env.INKBOX_IDENTITY?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const identities = await client.listIdentities();
    if (identities.length === 1) {
      return identities[0].agentHandle;
    }
    if (identities.length > 1) {
      console.log("This key can see multiple identities:");
      identities.forEach((i, idx) => console.log(`  ${idx + 1}. ${i.agentHandle}`));
      const pick = await prompter.ask("Pick identity (1..N)", "1");
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= identities.length) {
        return identities[idx - 1].agentHandle;
      }
    }
  } catch {
    // Some key states may not allow listIdentities; fall back to prompt.
  }
  return prompter.ask("Identity handle this key is bound to (lowercase, 3-63 chars)");
}

async function waitForSmsStart(params: {
  identity: AgentIdentity;
}): Promise<void> {
  if (params.identity.phoneNumber?.type !== "local") {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < SMS_OPT_IN_WAIT_TIMEOUT_MS) {
    const texts = await params.identity.listTexts({ limit: 25 });
    const found = texts.some((text) => {
      if (text.direction !== "inbound" || !isStartText(text.text)) {
        return false;
      }
      return true;
    });
    if (found) {
      console.log("Received START opt-in text.");
      return;
    }
    await sleep(SMS_OPT_IN_POLL_MS);
  }
  throw new Error(
    `Did not observe START before the wait timed out. Text START to ${params.identity.phoneNumber.number}, then re-run setup.`,
  );
}

// Offer to enable iMessage for the agent and walk through connecting an
// iPhone. Enablement lives on the Inkbox identity, not local config — there
// is no number to provision; people connect through the Inkbox iMessage
// router. Returns the (possibly refreshed) identity.
async function configureIMessage(params: {
  client: Inkbox;
  identity: AgentIdentity;
  identityHandle: string;
  prompter: Prompter;
}): Promise<AgentIdentity> {
  let identity = params.identity;
  // Detect the SDK's iMessage surface before prompting so setups running
  // against an older @inkbox/sdk skip the step instead of crashing.
  const imessages = (params.client as any).imessages;
  if (
    typeof imessages?.getTriageNumber !== "function" ||
    typeof (identity as any).update !== "function"
  ) {
    console.log("iMessage requires @inkbox/sdk >= 0.4.7; skipping iMessage setup.");
    return identity;
  }

  console.log("\niMessage:");
  if (identity.imessageEnabled) {
    console.log("  iMessage is already enabled for this agent.");
  } else {
    const enable = await params.prompter.confirm(
      "Enable iMessage for this agent? People connect by texting the Inkbox iMessage router — no number to provision.",
      true,
    );
    if (!enable) {
      console.log("  Skipped. Re-run `openclaw inkbox setup` anytime to enable iMessage.");
      return identity;
    }
    try {
      await identity.update({ imessageEnabled: true });
      // Re-fetch so the local object reflects the new flag (the SDK gates
      // its iMessage helpers on it).
      identity = await params.client.getIdentity(params.identityHandle);
    } catch (error) {
      console.log(`  Could not enable iMessage: ${messageFromError(error)}`);
      console.log("  You can enable it later from the Inkbox Console and re-run setup.");
      return identity;
    }
    console.log("  iMessage enabled for this agent.");
  }

  // Surface phones already connected through the router so re-runs don't
  // read like a first-time setup, and default the walkthrough off when a
  // connection already exists (connecting another phone is the rare case).
  let connected: Awaited<ReturnType<AgentIdentity["listIMessageAssignments"]>> = [];
  try {
    connected = await identity.listIMessageAssignments({ limit: 5 });
  } catch {
    connected = [];
  }
  if (connected.length) {
    console.log(
      `  Already connected: ${connected.map((entry) => entry.remoteNumber).join(", ")}`,
    );
  }
  const wantConnect = await params.prompter.confirm(
    connected.length
      ? "Connect another iPhone to this agent now?"
      : "Connect your iPhone to this agent now?",
    connected.length === 0,
  );
  if (!wantConnect) {
    console.log("  You can connect anytime — re-run `openclaw inkbox setup` for the walkthrough.");
    return identity;
  }
  await waitForIMessageFirstMessage({
    client: params.client,
    identity,
    identityHandle: params.identityHandle,
  });
  return identity;
}

// Walk the user through the iMessage connect flow, wait for their first
// inbound iMessage, then greet them back in that conversation. Timing out is
// non-fatal — the connection can be finished later by re-running setup.
async function waitForIMessageFirstMessage(params: {
  client: Inkbox;
  identity: AgentIdentity;
  identityHandle: string;
}): Promise<void> {
  let triage: { number: string; connectCommand: string; smsLink?: string };
  try {
    triage = await (params.client as any).imessages.getTriageNumber();
  } catch (error) {
    console.log(`Could not fetch the iMessage router number: ${messageFromError(error)}`);
    console.log("Re-run `openclaw inkbox setup` later to finish connecting.");
    return;
  }
  const connectCommand =
    triage.connectCommand && !triage.connectCommand.includes("your-handle")
      ? triage.connectCommand
      : `connect @${params.identityHandle}`;

  console.log("\nFrom your iPhone, in the Messages app:");
  console.log(`  1. Text "${connectCommand}" to ${triage.number}`);
  console.log("  2. Inkbox texts you back from the number now assigned to this agent.");
  console.log('  3. Send any first message (e.g. "hi") in that NEW thread.');
  console.log("The agent can only message you after you message it first.");
  console.log("\nOr just scan this with your iPhone camera to do step 1 in one tap:");
  const fallbackLink =
    triage.smsLink && !triage.smsLink.includes("your-handle")
      ? triage.smsLink
      : smsDraftLink(triage.number, connectCommand);
  const qrPayload = smsToQrPayload(triage.number, connectCommand);
  if (!showQr(qrPayload)) {
    console.log(`  (install qrcode-terminal to show a scannable QR here: ${fallbackLink})`);
  }
  console.log("\nWaiting up to 5 minutes for your first iMessage...");

  const startedAt = Date.now();
  let match: Awaited<ReturnType<AgentIdentity["listIMessages"]>>[number] | undefined;
  while (Date.now() - startedAt < IMESSAGE_CONNECT_WAIT_TIMEOUT_MS) {
    let messages: Awaited<ReturnType<AgentIdentity["listIMessages"]>> = [];
    try {
      messages = await params.identity.listIMessages({ limit: 10 });
    } catch {
      messages = [];
    }
    match = messages.find((message) => {
      if (message.direction !== "inbound") {
        return false;
      }
      // Ignore traffic from a connection that predates this run; accept
      // rows without a parseable timestamp rather than stalling the poll.
      const createdAt =
        message.createdAt instanceof Date ? message.createdAt.getTime() : undefined;
      return createdAt === undefined || createdAt >= startedAt;
    });
    if (match) {
      break;
    }
    await sleep(IMESSAGE_CONNECT_POLL_MS);
  }
  if (!match) {
    console.log(
      "Did not see a first iMessage before the wait timed out. Connect and message the agent, then re-run setup if you want the welcome walkthrough.",
    );
    return;
  }

  console.log(`Got it. First iMessage received from ${match.remoteNumber || "your phone"}.`);
  const welcome =
    `You're connected! This is your iMessage channel to your OpenClaw agent ` +
    `@${params.identityHandle}. Anything you send here goes straight to the agent, ` +
    `and its replies will show up right in this thread.`;
  try {
    await params.identity.sendIMessage({
      conversationId: match.conversationId,
      text: welcome,
    });
    console.log("Sent a welcome message back on that thread.");
  } catch (error) {
    console.log(`Could not send the welcome message: ${messageFromError(error)}`);
  }
  try {
    // Clear the unread flag the walkthrough message left behind.
    await params.identity.markIMessageConversationRead(match.conversationId);
  } catch {
    // Best-effort; unread state is cosmetic here.
  }
  console.log(
    "If the gateway is already running, restart it so it picks up this new iMessage connection.",
  );
}

async function askRequiredVerificationCode(prompter: Prompter): Promise<string> {
  for (;;) {
    const code = normalizeOptional(await prompter.ask("Verification code from email"));
    if (code) {
      return code;
    }
    console.log("Verification code is required to complete Inkbox setup.");
  }
}

async function runSelfSignup(params: {
  env: NodeJS.ProcessEnv;
  prompter: Prompter;
}): Promise<{ apiKey: string; identityHandle: string }> {
  const humanEmail = await params.prompter.ask("Your email address for Inkbox verification");
  const agentHandle = normalizeOptional(
    await params.prompter.ask("Requested agent handle (optional)"),
  );
  const displayName = normalizeOptional(
    await params.prompter.ask("Agent display name (optional)"),
  );
  try {
    const signup = await Inkbox.signup(
      {
        humanEmail,
        noteToHuman: SELF_SIGNUP_VERIFICATION_NOTE,
        ...(agentHandle ? { agentHandle } : {}),
        ...(displayName ? { displayName } : {}),
      },
      { baseUrl: params.env.INKBOX_BASE_URL },
    );
    console.log(`Created Inkbox agent ${signup.agentHandle} (${signup.emailAddress}).`);
    console.log(signup.message);
    const code = await askRequiredVerificationCode(params.prompter);
    await Inkbox.verifySignup(
      signup.apiKey,
      { verificationCode: code },
      { baseUrl: params.env.INKBOX_BASE_URL },
    );
    console.log("Signup verified.");
    return { apiKey: signup.apiKey, identityHandle: signup.agentHandle };
  } catch (error) {
    if (error instanceof InkboxAPIError && (error.statusCode === 409 || error.statusCode === 422)) {
      throw new Error(
        `Self-signup failed (${error.statusCode}). The handle/email may be unavailable or invalid: ${typeof error.detail === "string" ? error.detail : JSON.stringify(error.detail)}`,
      );
    }
    throw error;
  }
}

// Three-branch wizard:
//   A. No apiKey yet  → self-signup or prompt for an existing key
//   B. apiKey + admin → pick an existing identity or create one, then mint
//                       an agent-scoped key bound to it; rest of flow runs on
//                       the agent-scoped key
//   C. apiKey + agent → confirm identity, offer phone provision if missing,
//                       (re)generate signing key, persist state
export async function runSetupWizard(opts: WizardOptions): Promise<WizardResult> {
  const env = opts.env ?? process.env;
  const prompter = opts.prompter;
  const validateOpenAiRealtime =
    opts.validateOpenAiRealtimeApiKey ?? validateOpenAiRealtimeApiKey;

  console.log("Inkbox plugin setup\n");

  const existingAccount = resolveInkboxAccount({
    cfg: opts.currentConfig,
    env,
  });
  const existingApiKey = existingAccount.apiKey?.trim();
  const existingIdentity = existingAccount.identity?.trim();
  const existingSigningKey = existingAccount.signingKey?.trim();
  const existingBaseUrl = existingAccount.baseUrl?.trim();
  let reconfigureExisting = false;
  if (existingApiKey && existingIdentity) {
    const reconfigure = await prompter.confirm(
      `Inkbox is already configured for identity ${existingIdentity}. Reconfigure?`,
      false,
    );
    if (!reconfigure) {
      return {
        ok: true,
        message: "existing config kept",
        persisted: Boolean(existingAccount.configured),
        config: {
          apiKey: existingApiKey,
          identity: existingIdentity,
          ...(existingSigningKey ? { signingKey: existingSigningKey } : {}),
          ...(existingBaseUrl ? { baseUrl: existingBaseUrl } : {}),
          ...(existingAccount.config.voiceRealtime
            ? { voiceRealtime: existingAccount.config.voiceRealtime as WizardVoiceRealtimeConfig }
            : {}),
        },
      };
    }
    reconfigureExisting = true;
  }

  // Step 1 — read or prompt for API key. If the operator chose to
  // reconfigure, run the full setup flow again instead of silently reusing
  // the profile's old key/identity/signing key.
  let apiKey = reconfigureExisting ? undefined : existingApiKey;
  let signupIdentityHandle: string | undefined;
  if (!apiKey) {
    console.log(
      existingApiKey ? "Switching to a different Inkbox API key." : "No INKBOX_API_KEY in env.",
    );
    const hasApiKey = await prompter.confirm("Do you already have an Inkbox API key?", true);
    if (!hasApiKey) {
      const signup = await runSelfSignup({ env, prompter });
      apiKey = signup.apiKey;
      signupIdentityHandle = signup.identityHandle;
    } else {
      apiKey = await prompter.ask("Paste your Inkbox API key (starts with ApiKey_)");
    }
    if (!apiKey || !apiKey.startsWith("ApiKey_")) {
      return { ok: false, message: "Invalid API key format. Expected an ApiKey_... string." };
    }
  }

  const baseUrl = reconfigureExisting ? env.INKBOX_BASE_URL : (existingBaseUrl ?? env.INKBOX_BASE_URL);
  const client = new Inkbox({ apiKey, baseUrl });

  // Step 2 — whoami to discover scope.
  let info;
  try {
    info = await client.whoami();
  } catch (err) {
    return {
      ok: false,
      message: `whoami failed: ${err instanceof Error ? err.message : String(err)}. Is the API key correct?`,
    };
  }
  if (info.authType !== "api_key") {
    return {
      ok: false,
      message: `Unsupported auth type for the wizard: ${info.authType}. Use an API key.`,
    };
  }
  const subtype = info.authSubtype;
  console.log(`Authenticated. org=${info.organizationId} subtype=${subtype}\n`);

  // Step 3 — branch on subtype.
  let identityHandle: string;
  let agentApiKey: string = apiKey;
  let identity: AgentIdentity | undefined;
  let didProvisionPhone = false;

  if (subtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED) {
    // Branch B — admin scoped.
    console.log("Admin-scoped key detected. The wizard will create or select an identity, then mint an agent-scoped key for the plugin to use.\n");
    const identities = await client.listIdentities();
    const identityDetails: Array<AgentIdentity | undefined> = [];
    if (identities.length > 0) {
      console.log(`Found ${identities.length} identity(s). Fetching mailbox and phone details...`);
      for (const candidate of identities) {
        try {
          identityDetails.push(await client.getIdentity(candidate.agentHandle));
        } catch (error) {
          console.log(`  ${candidate.agentHandle}: details unavailable (${messageFromError(error)})`);
          identityDetails.push(undefined);
        }
      }
      console.log("Existing identities:");
      identities.forEach((i, idx) =>
        console.log(`  ${idx + 1}. ${summarizeIdentity(identityDetails[idx] ?? i)}`),
      );
      console.log("  N. Create a new identity");
      const pick = await prompter.ask("Pick (1..N)", "N");
      const idx = parseInt(pick, 10);
      if (!Number.isNaN(idx) && idx >= 1 && idx <= identities.length) {
        identityHandle = identities[idx - 1].agentHandle;
        identity = identityDetails[idx - 1] ?? (await client.getIdentity(identityHandle));
      } else {
        identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
        const displayName = normalizeOptional(await prompter.ask("Display name (optional)"));
        const createPhone = await prompter.confirm(
          "Provision a local phone number for SMS + voice for this identity?",
          true,
        );
        identity = await client.createIdentity(identityHandle, {
          ...(displayName ? { displayName } : {}),
          ...(createPhone ? { phoneNumber: { type: "local", incomingCallAction: "auto_reject" } } : {}),
        });
        didProvisionPhone = createPhone && Boolean(identity.phoneNumber);
        console.log(`Created identity ${identityHandle}.`);
      }
    } else {
      identityHandle = await prompter.ask("New identity handle (lowercase, 3-63 chars, alphanum+dash)");
      const displayName = normalizeOptional(await prompter.ask("Display name (optional)"));
      const createPhone = await prompter.confirm(
        "Provision a local phone number for SMS + voice for this identity?",
        true,
      );
      identity = await client.createIdentity(identityHandle, {
        ...(displayName ? { displayName } : {}),
        ...(createPhone ? { phoneNumber: { type: "local", incomingCallAction: "auto_reject" } } : {}),
      });
      didProvisionPhone = createPhone && Boolean(identity.phoneNumber);
      console.log(`Created identity ${identityHandle}.`);
    }
    // Mint an agent-scoped key bound to this identity. The plugin should use
    // this going forward, not the admin key the user pasted.
    const identityRecord = identity ?? (await client.getIdentity(identityHandle));
    const newKey = await (client as any).apiKeys.create({
      scopedIdentityId: identityRecord.id,
      label: `openclaw-plugin-${identityHandle}`,
    });
    agentApiKey = newKey.apiKey ?? newKey.api_key;
    console.log("Minted an agent-scoped key for this identity.\n");
  } else if (
    subtype === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED ||
    subtype === AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED
  ) {
    // Branch C — agent scoped (preferred).
    identityHandle =
      signupIdentityHandle ?? (await discoverAgentIdentityHandle(client, env, prompter));
  } else {
    return {
      ok: false,
      message: `Unsupported auth subtype: ${subtype}. Mint an agent-scoped or admin-scoped key.`,
    };
  }

  // Re-construct a client with the (possibly new) agent-scoped key so the
  // identity resolves under the right access.
  const agentClient = subtype === AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED
    ? new Inkbox({ apiKey: agentApiKey, baseUrl })
    : client;
  identity = await agentClient.getIdentity(identityHandle);

  // Step 4 — optional phone provision.
  if (!identity.phoneNumber) {
    const provisioned = await maybeProvisionPhoneNumber(identity, prompter);
    identity = provisioned.identity;
    didProvisionPhone = didProvisionPhone || provisioned.didProvisionPhone;
  }

  if (didProvisionPhone && identity.phoneNumber) {
    console.log(`Text START to ${identity.phoneNumber.number}. Waiting up to 5 minutes...`);
    try {
      await waitForSmsStart({ identity });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const voiceRealtime = identity.phoneNumber
    ? await promptForOpenAiRealtimeConfig({
        currentConfig: opts.currentConfig,
        existingAccount,
        env,
        prompter,
        validate: validateOpenAiRealtime,
      })
    : undefined;

  // Step 4b — offer iMessage. Runs before delivery setup (step 6) so the
  // identity-owned imessage.* subscription is created when enabled.
  identity = await configureIMessage({
    client: agentClient,
    identity,
    identityHandle,
    prompter,
  });

  printInkboxAuthorizationInfo();

  // Step 5 — signing key for inbound webhooks.
  let signingKey = normalizeOptional((reconfigureExisting ? undefined : existingSigningKey) ?? "");
  if (signingKey) {
    const keepExisting = await prompter.confirm("Use existing webhook signing key?", true);
    if (!keepExisting) signingKey = undefined;
  }
  if (!signingKey) {
    const pasteExisting = await prompter.confirm(
      "Do you already have a webhook signing key to keep using?",
      false,
    );
    if (pasteExisting) {
      signingKey = normalizeOptional(await prompter.ask("Paste webhook signing key"));
    }
  }
  if (!signingKey) {
    const wantSigningKey = await prompter.confirm(
      "Generate/rotate the org webhook signing key now? This is required for inbound email/SMS/calls and replaces the previous org-level signing secret.",
      true,
    );
    if (wantSigningKey) {
      const sk = await agentClient.createSigningKey();
      signingKey = (sk as any).signingKey ?? (sk as any).key;
      if (!signingKey) {
        console.log("⚠️  Signing key call succeeded but the response shape was unexpected — fall back to creating one in the Console.");
      } else {
        console.log("Generated webhook signing key.\n");
      }
    }
  }
  if (!signingKey) {
    return {
      ok: false,
      message:
        "Webhook signing key is required for inbound email/SMS/calls. Re-run setup and paste or generate a signing key.",
    };
  }

  // Step 6 — point the identity's mailbox and phone at this OpenClaw gateway.
  // This is intentionally done for existing identities too; a pre-existing
  // phone number must be routed exactly like a newly provisioned number.
  let tunnelName: string | undefined;
  try {
    const delivery = await configureIdentityGatewayDelivery({
      client: agentClient,
      identity,
      identityHandle,
    });
    tunnelName = delivery.tunnelName;
  } catch (error) {
    return {
      ok: false,
      message: `Inkbox delivery setup failed: ${messageFromError(error)}`,
    };
  }

  // Step 7 — persist non-secret state for future doctor/CLI runs.
  identity = await identity.refresh();
  await writeIdentityState({
    identityHandle,
    emailAddress: identity.mailbox?.emailAddress ?? null,
    phoneNumber: identity.phoneNumber?.number ?? null,
    imessageEnabled: Boolean(identity.imessageEnabled),
    tunnelPublicHost: identity.tunnel?.publicHost ?? null,
    savedAt: new Date().toISOString(),
  });
  printAgentSummary(identity);

  // Step 8 — persist the channel config in the active OpenClaw profile when
  // the CLI provided a config persister. Tests and direct library callers can
  // omit it and still receive the snippet.
  const snippet: WizardConfig = {
    apiKey: agentApiKey,
    identity: identityHandle,
    ...(signingKey ? { signingKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(tunnelName ? { tunnelName } : {}),
    ...(voiceRealtime ? { voiceRealtime } : {}),
  };
  if (opts.persistConfig) {
    const persisted = await opts.persistConfig(snippet, {
      currentConfig: opts.currentConfig,
      env,
    });
    if (!persisted.ok) {
      console.log("\n❌ Inkbox setup completed, but OpenClaw config was not updated.");
      console.log(persisted.message ?? "Unknown config write error.");
      console.log("\nManual fallback for channels.inkbox:\n");
      console.log(JSON.stringify(snippet, null, 2));
      return {
        ok: false,
        message: "OpenClaw config write failed.",
        config: snippet,
        persisted: false,
      };
    }
    console.log("\n✅ Setup complete. Saved Inkbox settings to the active OpenClaw config.");
    console.log("Run `openclaw inkbox doctor` to verify the connection.\n");
    return { ok: true, config: snippet, persisted: true };
  }

  console.log("\n✅ Setup complete. Add this to your OpenClaw config under channels.inkbox:\n");
  console.log(JSON.stringify(snippet, null, 2));
  console.log("\nThen run `openclaw inkbox doctor` to verify the connection.\n");

  return { ok: true, config: snippet, persisted: false };
}

// Light wrapper used by the CLI command — instantiates a readline prompter,
// runs the wizard, and ensures the prompter is closed even on error.
export async function runSetupWizardCli(options: {
  currentConfig?: unknown;
  env?: NodeJS.ProcessEnv;
  persistConfig?: WizardConfigPersister;
} = {}): Promise<void> {
  const { createReadlinePrompter } = await import("./prompt.js");
  const prompter = createReadlinePrompter();
  try {
    const result = await runSetupWizard({
      prompter,
      currentConfig: options.currentConfig,
      env: options.env,
      persistConfig: options.persistConfig ?? persistOpenClawConfigFile,
    });
    if (!result.ok) {
      console.error(`\n❌ Setup did not complete: ${result.message}`);
      process.exitCode = 1;
    }
  } finally {
    await prompter.close();
  }
}

// Re-export readIdentityState for convenience (doctor and other CLI commands
// will want it).
export { readIdentityState };
