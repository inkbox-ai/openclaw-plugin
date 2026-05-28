import {
  defineChannelPluginEntry,
  type ChannelPlugin,
  type OpenClawPluginApi,
  type PluginRuntime,
} from "openclaw/plugin-sdk/channel-core";
import { createInkboxRuntime, type InkboxPluginConfig } from "./src/client.js";
import { inkboxPlugin } from "./src/channel.js";
import { registerInkboxPublicUrlInboundRoutes } from "./src/gateway.js";
import { resolveInkboxAccount, resolveInkboxToolsConfig } from "./src/accounts.js";
import { registerSendEmail } from "./src/tools/send-email.js";
import { registerSendSms } from "./src/tools/send-sms.js";
import { registerForwardEmail } from "./src/tools/forward-email.js";
import { registerEmailReads } from "./src/tools/email-reads.js";
import { registerSmsReads } from "./src/tools/sms-reads.js";
import { registerCallReads } from "./src/tools/call-reads.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerNoteTools } from "./src/tools/notes.js";
import { registerContactRuleTools } from "./src/tools/contact-rules.js";
import { registerIdentityAccessTools } from "./src/tools/access.js";
import { registerVaultTools } from "./src/tools/vault.js";
import { registerWhoami } from "./src/tools/whoami.js";
import { registerPlaceCall } from "./src/tools/place-call.js";
import { createVaultRuntime } from "./src/vault.js";
import { deriveConfiguredCallWebsocketUrl } from "./src/call-websocket.js";
import { registerInkboxHealthChecks } from "./src/health.js";

type OpenClawChannelEntry = {
  id: string;
  name: string;
  description: string;
  configSchema: ChannelPlugin["configSchema"];
  register: (api: OpenClawPluginApi) => void;
  channelPlugin: ChannelPlugin;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

// CLI registrar is lazy-imported via api.registerCli so we don't pay the
// commander/Inkbox SDK cost on every plugin load.

registerInkboxHealthChecks();

function registerInkboxCli(api: any): void {
  api.registerCli?.(
    async ({ program, config }: { program: any; config?: unknown }) => {
      const { registerInkboxCli } = await import("./src/cli.js");
      registerInkboxCli(program, {
        pluginConfig: api.pluginConfig,
        readCurrentConfig: () => api.runtime?.config?.current?.() ?? config,
      });
    },
    {
      descriptors: [
        {
          name: "inkbox",
          description: "Inkbox plugin commands (setup, doctor, whoami)",
          hasSubcommands: true,
        },
      ],
    },
  );
}

function registerInkboxTools(api: any): void {
  const resolveCfg = () =>
    resolveInkboxToolsConfig({
      pluginConfig: api.pluginConfig,
      readCurrentConfig: () => api.runtime?.config?.current?.(),
    }) as Partial<InkboxPluginConfig>;
  const cfg = resolveCfg();
  if (!cfg.apiKey || !cfg.identity) {
    api.logger?.warn?.(
      "Inkbox plugin enabled but apiKey/identity missing; tools will return an error until configured. Set plugins.entries.inkbox.config or channels.inkbox.",
    );
  }

  const runtime = createInkboxRuntime(resolveCfg, api.logger);

  // Required outbound tools — registered without { optional: true } so they
  // light up as soon as the plugin is enabled. Recipient allowlist is
  // threaded through; when undefined, no filtering applies.
  registerSendEmail(api, runtime, cfg.allowedRecipients);
  registerSendSms(api, runtime, cfg.allowedRecipients);

  // Optional outbound tools — require explicit opt-in via tools.allow.
  registerForwardEmail(api, runtime, cfg.allowedRecipients);
  registerPlaceCall(api, runtime, cfg.allowedRecipients, () => {
    let currentCfg: unknown;
    try {
      currentCfg = api.runtime?.config?.current?.();
    } catch {
      currentCfg = undefined;
    }
    const account = resolveInkboxAccount({
      cfg: currentCfg,
      pluginConfig: api.pluginConfig,
    });
    const context = api.runtime?.channel?.runtimeContexts?.get?.({
      channelId: "inkbox",
      accountId: account.accountId,
      capability: "call-websocket",
    }) as { url?: string } | undefined;
    return context?.url ?? deriveConfiguredCallWebsocketUrl(account);
  });

  // Read/lifecycle tools for email, SMS, and calls. Required tools light up
  // by default; optional ones (mark-read, raw text list/get) require opt-in.
  registerEmailReads(api, runtime);
  registerSmsReads(api, runtime);
  registerCallReads(api, runtime);

  // Access-scoped contact + note tools. With an agent-scoped key the SDK
  // filters list/lookup/get to entries this identity has access to.
  registerContactTools(api, runtime);
  registerNoteTools(api, runtime);
  registerContactRuleTools(api, runtime);
  registerIdentityAccessTools(api, runtime);

  // Vault tools. All optional; user must opt in via tools.allow. Vault
  // unlock key is read once on first use from $INKBOX_VAULT_KEY (or a
  // custom env var when vault.keyEnvVar is configured).
  const vault = createVaultRuntime(runtime, {
    keyEnvVar: (cfg as any).vault?.keyEnvVar,
  });
  registerVaultTools(api, runtime, vault);

  // Diagnostic / introspection tools.
  registerWhoami(api, runtime);
}

const entry: OpenClawChannelEntry = defineChannelPluginEntry({
  id: "inkbox",
  name: "Inkbox",
  description: "Adds Inkbox messaging tools (email, SMS, voice) to OpenClaw",
  plugin: inkboxPlugin,
  registerCliMetadata: registerInkboxCli,
  registerFull(api: any) {
    registerInkboxTools(api);
    registerInkboxPublicUrlInboundRoutes(api);
  },
});

export default entry;
