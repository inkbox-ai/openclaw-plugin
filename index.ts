import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createInkboxRuntime, type InkboxPluginConfig } from "./src/client.js";
import { registerSendEmail } from "./src/tools/send-email.js";
import { registerSendSms } from "./src/tools/send-sms.js";
import { registerForwardEmail } from "./src/tools/forward-email.js";

export default definePluginEntry({
  id: "inkbox",
  name: "Inkbox",
  description: "Adds Inkbox messaging tools (email, SMS, voice) to OpenClaw",
  register(api: any) {
    // Pull plugin-scoped config injected by OpenClaw. We pass it through to
    // the lazy runtime — actual validation happens on first tool call.
    const cfg = (api.pluginConfig ?? {}) as Partial<InkboxPluginConfig>;
    if (!cfg.apiKey || !cfg.identity) {
      api.logger?.warn?.(
        "Inkbox plugin enabled but apiKey/identity missing — tools will return an error until configured. Run `openclaw inkbox setup` (Phase 3) or set the values directly in plugins.entries.inkbox.config.",
      );
    }

    const runtime = createInkboxRuntime(cfg, api.logger);

    // Required outbound tools — registered without { optional: true } so they
    // light up as soon as the plugin is enabled.
    registerSendEmail(api, runtime);
    registerSendSms(api, runtime);

    // Optional outbound tools — require explicit opt-in via tools.allow.
    registerForwardEmail(api, runtime);

    // TODO Phase 2: registerHttpRoute for inbound + registerPlaceCall.
    // TODO Phase 3: registerCli for `openclaw inkbox setup`.
    // TODO Phase 4: read tools (lists, threads, conversations, contacts, notes).
    // TODO Phase 5: vault + credentials + TOTP.
  },
});
