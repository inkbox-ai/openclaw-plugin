import { Inkbox } from "@inkbox/sdk";
import { ensureGatewayRunning } from "./gateway-service.js";
import { inkboxClientOptions } from "./sdk-options.js";
import {
  type WizardConfig,
  persistOpenClawConfigFile,
} from "./setup-wizard.js";
import { writeIdentityState } from "./state.js";

export interface BootstrapOptions {
  identity: string;
  apiKey: string;
  baseUrl?: string;
  voiceAi?: boolean;
  voiceAiInstructions?: string;
  rotateSigningKey?: boolean;
  startGateway?: boolean;
  currentConfig?: unknown;
  env?: NodeJS.ProcessEnv;
}

export interface BootstrapResult {
  status: "configured" | "requires_human" | "error";
  identity?: string;
  actions?: string[];
  gatewayRunning?: boolean;
  humanActions?: string[];
  error?: string;
}

const handle = (value: string): string => value.trim().replace(/^@/, "").trim();

function clientFor(apiKey: string, baseUrl?: string): any {
  return new Inkbox(inkboxClientOptions(apiKey, baseUrl));
}

async function identityForAgentKey(client: any, expected: string): Promise<any> {
  const identities = (await client.listIdentities()) ?? [];
  if (!identities.some((item: any) => handle(String(item.agentHandle ?? "")) === expected)) {
    throw new Error("The API key is not scoped to the requested identity.");
  }
  return client.getIdentity(expected);
}

async function resolveCredentials(
  apiKey: string,
  expected: string,
  baseUrl: string | undefined,
  env: NodeJS.ProcessEnv,
  actions: string[],
): Promise<{ apiKey: string; identity: any; client: any }> {
  const client = clientFor(apiKey, baseUrl);
  const info = await client.whoami();
  if (String(info?.authType ?? "") !== "api_key") {
    throw new Error("Bootstrap requires an Inkbox API key.");
  }
  const subtype = String(info?.authSubtype ?? "");
  if (subtype === "api_key.agent_scoped.claimed") {
    return { apiKey, identity: await identityForAgentKey(client, expected), client };
  }
  if (subtype === "api_key.agent_scoped.unclaimed") {
    throw new Error("The API key is not attached to a claimed identity yet.");
  }
  if (subtype !== "api_key.admin_scoped") {
    throw new Error("Use an agent-scoped or admin-scoped Inkbox API key.");
  }

  const savedKey = String(env.INKBOX_API_KEY ?? "").trim();
  if (savedKey && handle(String(env.INKBOX_IDENTITY ?? "")) === expected) {
    try {
      const savedClient = clientFor(savedKey, baseUrl);
      if (String((await savedClient.whoami())?.authSubtype ?? "") === "api_key.agent_scoped.claimed") {
        actions.push("reused_saved_agent_key");
        return {
          apiKey: savedKey,
          identity: await identityForAgentKey(savedClient, expected),
          client: savedClient,
        };
      }
    } catch {
      // Mint a replacement scoped key below.
    }
  }

  const identity = await client.getIdentity(expected);
  const created = await client.apiKeys.create({
    label: `OpenClaw gateway - ${expected}`,
    description: "Agent-scoped key created by the OpenClaw Inkbox bootstrap.",
    scopedIdentityId: identity.id,
  });
  const scopedKey = String(created?.apiKey ?? "");
  if (!scopedKey) throw new Error("Inkbox did not return the new agent-scoped API key.");
  actions.push("minted_agent_scoped_key");
  const scopedClient = clientFor(scopedKey, baseUrl);
  return { apiKey: scopedKey, identity: await scopedClient.getIdentity(expected), client: scopedClient };
}

async function defaultVoiceInstructions(identity: any, client: any): Promise<string> {
  const agentHandle = handle(String(identity.agentHandle ?? ""));
  const channels: string[] = [];
  const email = identity.emailAddress ?? identity.mailbox?.emailAddress;
  const phone = identity.phoneNumber?.number;
  const tunnel = identity.tunnel?.publicHost;
  const dedicated = identity.imessageNumber?.number;
  if (email) channels.push(`Email: ${email}.`);
  if (phone) channels.push(`VoIP phone: ${phone}.`);
  if (tunnel) channels.push(`Public address: https://${tunnel}.`);
  if (dedicated) {
    channels.push(`Dedicated iMessage line: ${dedicated}.`);
  } else if (identity.imessageEnabled) {
    try {
      const triage = await client.imessages.getTriageNumber();
      const command = String(triage?.connectCommand ?? `connect @${agentHandle}`);
      if (triage?.number) channels.push(`Shared iMessage: text '${command}' to ${triage.number}.`);
    } catch {
      channels.push("Shared iMessage is enabled; use the current Inkbox connection instructions.");
    }
  }
  const configured = channels.join(" ") || "No direct communication channel is currently configured.";
  return `You are the hosted voice interface for Inkbox agent @${agentHandle}. Help callers connect using only these configured channels. ${configured}`;
}

async function configureVoice(identity: any, client: any, requested?: string): Promise<string> {
  const hosted = await identity.getHostedAgentConfig();
  const instructions = requested ?? hosted?.instructions ?? (await defaultVoiceInstructions(identity, client));
  if (instructions.length > 8000) throw new Error("Voice AI instructions must be 8,000 characters or fewer.");
  if (hosted?.instructions !== instructions) {
    await identity.setHostedAgentConfig({ voice: hosted?.voice, model: hosted?.model, instructions });
  }
  const incoming = await identity.getIncomingCallAction();
  if (
    incoming?.incomingCallAction !== "hosted_agent" ||
    incoming?.clientWebsocketUrl != null ||
    incoming?.incomingCallWebhookUrl != null
  ) {
    await identity.setIncomingCallAction({
      incomingCallAction: "hosted_agent",
      clientWebsocketUrl: null,
      incomingCallWebhookUrl: null,
    });
  }
  return String(hosted?.authorityMode ?? "contact_scoped");
}

async function configureSigning(
  identity: any,
  env: NodeJS.ProcessEnv,
  rotate: boolean,
  sameIdentity: boolean,
  actions: string[],
): Promise<{ key?: string; blocker?: string }> {
  const configured = Boolean((await identity.getSigningKeyStatus())?.configured);
  if (env.INKBOX_SIGNING_KEY?.trim() && sameIdentity && configured && !rotate) {
    actions.push("reused_local_signing_key");
    return { key: env.INKBOX_SIGNING_KEY.trim() };
  }
  if (configured && !rotate) {
    return {
      blocker:
        "A signing key already exists but is unavailable in this OpenClaw profile. Set INKBOX_SIGNING_KEY or rerun with --rotate-signing-key.",
    };
  }
  const created = await identity.createSigningKey();
  const key = String(created?.signingKey ?? "");
  if (!key) throw new Error("Inkbox did not return the new signing key.");
  actions.push(configured ? "rotated_signing_key" : "created_signing_key");
  return { key };
}

export async function bootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const identityHandle = handle(options.identity);
  if (!identityHandle) return { status: "error", error: "identity is required" };
  if (!options.apiKey.trim()) return { status: "error", error: "API key is required" };
  const env = options.env ?? process.env;
  const actions: string[] = [];
  const secrets = [options.apiKey.trim()];
  try {
    const previous = handle(String(env.INKBOX_IDENTITY ?? ""));
    const resolved = await resolveCredentials(
      options.apiKey.trim(),
      identityHandle,
      options.baseUrl,
      env,
      actions,
    );
    secrets.push(resolved.apiKey);
    let authorityMode: "contact_scoped" | "yolo" = "contact_scoped";
    if (options.voiceAi) {
      authorityMode = (await configureVoice(resolved.identity, resolved.client, options.voiceAiInstructions)) === "yolo" ? "yolo" : "contact_scoped";
      actions.push("configured_voice_ai");
    }
    const signing = await configureSigning(
      resolved.identity,
      env,
      options.rotateSigningKey === true,
      !previous || previous === identityHandle,
      actions,
    );
    if (signing.blocker) {
      return { status: "requires_human", identity: identityHandle, actions, humanActions: [signing.blocker] };
    }
    const config: WizardConfig = {
      apiKey: resolved.apiKey,
      identity: identityHandle,
      signingKey: signing.key,
      baseUrl: options.baseUrl,
      tunnelName: identityHandle,
      voiceStack: options.voiceAi ? "inkbox_voice_ai" : undefined,
      voiceAiAuthorityMode: options.voiceAi ? authorityMode : undefined,
    };
    const persisted = await persistOpenClawConfigFile(config, {
      currentConfig: options.currentConfig,
      env,
    });
    if (!persisted.ok) throw new Error(`Could not persist OpenClaw configuration: ${persisted.message}`);
    actions.push("saved_openclaw_configuration");
    await writeIdentityState({
      identityHandle,
      emailAddress: resolved.identity.mailbox?.emailAddress ?? resolved.identity.emailAddress ?? null,
      phoneNumber: resolved.identity.phoneNumber?.number ?? null,
      imessageEnabled: Boolean(resolved.identity.imessageEnabled),
      tunnelPublicHost: resolved.identity.tunnel?.publicHost ?? null,
      savedAt: new Date().toISOString(),
    });
    let gatewayRunning = false;
    if (options.startGateway) {
      const gateway = await ensureGatewayRunning();
      gatewayRunning = gateway.running;
      actions.push(`${gateway.action}ed_gateway`);
      if (!gatewayRunning) {
        return { status: "error", identity: identityHandle, actions, error: "OpenClaw gateway did not become ready. Run `openclaw gateway status`." };
      }
    }
    return { status: "configured", identity: identityHandle, actions, gatewayRunning };
  } catch (error) {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of secrets) message = message.replaceAll(secret, "[redacted]");
    return { status: "error", identity: identityHandle, actions, error: message };
  }
}
