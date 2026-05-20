import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createInkboxRuntime, type InkboxPluginConfig } from "./src/client.js";
import { registerSendEmail } from "./src/tools/send-email.js";
import { registerSendSms } from "./src/tools/send-sms.js";
import { registerForwardEmail } from "./src/tools/forward-email.js";
import { registerEmailReads } from "./src/tools/email-reads.js";
import { registerSmsReads } from "./src/tools/sms-reads.js";
import { registerCallReads } from "./src/tools/call-reads.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerNoteTools } from "./src/tools/notes.js";
import { startInbound } from "./src/inbound/index.js";

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

    // Read/lifecycle tools for email, SMS, and calls. Required tools light up
    // by default; optional ones (mark-read, raw text list/get) require opt-in.
    registerEmailReads(api, runtime);
    registerSmsReads(api, runtime);
    registerCallReads(api, runtime);

    // Access-scoped contact + note tools. With an agent-scoped key the SDK
    // filters list/lookup/get to entries this identity has access to.
    registerContactTools(api, runtime);
    registerNoteTools(api, runtime);

    // Inbound delivery. Skipped when signingKey is missing; failures are
    // non-fatal (outbound still works). Phase 2c will replace these stub
    // handlers with real session ingress via defineChannelPluginEntry.
    startInbound({
      cfg,
      runtime,
      logger: api.logger,
      handlers: {
        onMail(event) {
          api.logger?.info?.(
            `Inkbox mail event: ${event.event_type}`,
          );
        },
        onText(event) {
          api.logger?.info?.(
            `Inkbox text event: ${event.event_type}`,
          );
        },
        onCall() {
          // Phase 2c will return { action: "answer", clientWebsocketUrl }
          // once the realtime audio bridge is wired.
          api.logger?.info?.("Inkbox inbound call — rejecting (no audio bridge yet)");
          return { action: "reject" };
        },
      },
    });

    // TODO Phase 2c: promote to defineChannelPluginEntry + wire session ingress.
    // TODO Phase 2 (after channel promotion): registerPlaceCall.
    // TODO Phase 3: registerCli for `openclaw inkbox setup`.
    // TODO Phase 4: read tools (lists, threads, conversations, contacts, notes).
    // TODO Phase 5: vault + credentials + TOTP.
  },
});
