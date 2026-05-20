import { Type } from "typebox";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Inkbox } from "@inkbox/sdk";
import type { AgentIdentity } from "@inkbox/sdk";

// Shape of `plugins.entries.inkbox.config` after configSchema validation.
interface InkboxPluginConfig {
  apiKey: string;
  identity: string;
  baseUrl?: string;
  signingKey?: string;
}

export default definePluginEntry({
  id: "inkbox",
  name: "Inkbox",
  description: "Adds Inkbox messaging tools (email, SMS, voice) to OpenClaw",
  register(api) {
    // Pull plugin-scoped config injected by OpenClaw from the user's settings.
    const cfg = (api.pluginConfig ?? {}) as Partial<InkboxPluginConfig>;
    if (!cfg.apiKey || !cfg.identity) {
      // Fail-open at registration; tools will surface a clearer error on call.
      // This lets `openclaw plugins inspect inkbox` still discover the plugin.
      api.logger?.warn?.(
        "Inkbox plugin enabled but apiKey/identity missing — tools will return an error until configured.",
      );
    }

    // Lazy + cached client. Avoids constructing the SDK at startup if the
    // user never invokes a tool this session.
    let clientPromise: Promise<{ inkbox: Inkbox; identity: AgentIdentity }> | null = null;
    const getClient = () => {
      if (!cfg.apiKey || !cfg.identity) {
        throw new Error(
          "Inkbox plugin is not configured. Set `plugins.entries.inkbox.config.apiKey` and `.identity`.",
        );
      }
      if (!clientPromise) {
        const inkbox = new Inkbox({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl });
        clientPromise = inkbox.getIdentity(cfg.identity).then((identity) => ({ inkbox, identity }));
      }
      return clientPromise;
    };

    // Outbound email tool.
    api.registerTool({
      name: "inkbox_send_email",
      description:
        "Send an email from the configured Inkbox identity. Use for outbound messages addressed to one or more email recipients.",
      parameters: Type.Object({
        to: Type.Array(Type.String({ description: "Recipient email address" }), {
          minItems: 1,
          description: "Primary recipients (at least one required).",
        }),
        subject: Type.String({ description: "Email subject line" }),
        bodyText: Type.Optional(Type.String({ description: "Plain-text body" })),
        bodyHtml: Type.Optional(Type.String({ description: "HTML body" })),
        cc: Type.Optional(Type.Array(Type.String(), { description: "CC recipients" })),
        bcc: Type.Optional(Type.Array(Type.String(), { description: "BCC recipients" })),
        inReplyToMessageId: Type.Optional(
          Type.String({ description: "RFC 5322 Message-ID to thread a reply" }),
        ),
      }),
      async execute(_id, params) {
        const { identity } = await getClient();
        const msg = await identity.sendEmail({
          to: params.to,
          subject: params.subject,
          bodyText: params.bodyText,
          bodyHtml: params.bodyHtml,
          cc: params.cc,
          bcc: params.bcc,
          inReplyToMessageId: params.inReplyToMessageId,
        });
        return {
          content: [
            {
              type: "text",
              text: `Sent email id=${msg.id} to=${params.to.join(",")} subject="${params.subject}"`,
            },
          ],
        };
      },
    });

    // Outbound SMS tool.
    api.registerTool({
      name: "inkbox_send_sms",
      description:
        "Send an SMS from the configured Inkbox identity's phone number. Use for short outbound text messages.",
      parameters: Type.Object({
        to: Type.String({
          description: "Recipient phone number in E.164 format (e.g. +14155550123).",
        }),
        text: Type.String({
          minLength: 1,
          maxLength: 1600,
          description: "Message body (1–1600 chars).",
        }),
      }),
      async execute(_id, params) {
        const { identity } = await getClient();
        const msg = await identity.sendText({ to: params.to, text: params.text });
        return {
          content: [
            {
              type: "text",
              text: `Sent SMS id=${msg.id} to=${params.to} (${params.text.length} chars)`,
            },
          ],
        };
      },
    });

    // TODO(next): registerHttpRoute for inbound email/SMS webhooks.
    // TODO(next): registerCli for `openclaw inkbox setup` wizard.
    // TODO(next): channel plugin shape so inbound events become sessions.
  },
});
