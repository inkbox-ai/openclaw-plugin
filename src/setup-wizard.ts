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
const SELF_SIGNUP_VERIFICATION_NOTE = "OpenClaw Inkbox plugin setup";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isStartText(text: string | null | undefined): boolean {
  return text?.trim().toUpperCase() === "START";
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

  if (params.identity.mailbox?.emailAddress) {
    await params.client.mailboxes.update(params.identity.mailbox.emailAddress, {
      webhookUrl,
    });
    console.log(`Mailbox webhook points at ${webhookUrl}.`);
  }

  if (params.identity.phoneNumber?.id) {
    await params.client.phoneNumbers.update(params.identity.phoneNumber.id, {
      incomingTextWebhookUrl: webhookUrl,
      incomingCallAction: "auto_accept",
      clientWebsocketUrl: callWebsocketUrl,
      incomingCallWebhookUrl: null,
    });
    console.log(`Phone SMS + call delivery points at ${webhookUrl} / ${callWebsocketUrl}.`);
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
    }
  } else {
    console.log("  Phone:   (none - provision later in the Inkbox console)");
  }
  console.log("\nReachability rules:");
  console.log("  Manage who can reach this agent at https://inkbox.ai/console/contact-rules");
  console.log("  Use mailbox and phone contact rules for email senders, domains, and phone numbers.");
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
    console.log(
      `Provisioned ${phone.number}. SMS will be ready in ~10-15 min once 10DLC carrier propagation completes.`,
    );
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
  ownerNumber: string;
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
      return !params.ownerNumber || text.remotePhoneNumber === params.ownerNumber;
    });
    if (found) {
      console.log("Received START opt-in text.");
      return;
    }
    await sleep(SMS_OPT_IN_POLL_MS);
  }
  throw new Error(
    `Did not observe START from ${params.ownerNumber} before the wait timed out. Text START to ${params.identity.phoneNumber.number} from that phone, then re-run setup.`,
  );
}

async function askRequiredOwnerPhoneNumber(prompter: Prompter): Promise<string> {
  for (;;) {
    const ownerNumber = normalizeOptional(
      await prompter.ask("Owner phone number that must text START (E.164, e.g. +15551234567)"),
    );
    if (ownerNumber) {
      return ownerNumber;
    }
    console.log("Owner phone number is required so setup can verify SMS opt-in.");
  }
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
    const ownerNumber = await askRequiredOwnerPhoneNumber(prompter);
    console.log(
      `Text START to ${identity.phoneNumber.number} from ${ownerNumber}. Waiting up to 5 minutes...`,
    );
    try {
      await waitForSmsStart({ identity, ownerNumber });
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

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
