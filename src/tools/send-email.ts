import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";

// Outbound email — the primary write path for the email channel.
export function registerSendEmail(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_send_email",
    description:
      "Send an email from the configured Inkbox identity. Use for outbound messages addressed to one or more email recipients. Supports CC/BCC and reply threading via inReplyToMessageId.",
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
        Type.String({
          description:
            "RFC 5322 Message-ID of the message being replied to. Pass this when threading a reply so the recipient's client groups the conversation.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const msg = await identity.sendEmail({
          to: params.to,
          subject: params.subject,
          bodyText: params.bodyText,
          bodyHtml: params.bodyHtml,
          cc: params.cc,
          bcc: params.bcc,
          inReplyToMessageId: params.inReplyToMessageId,
        });
        return toolText(
          `Sent email id=${msg.id} to=${params.to.join(",")} subject="${params.subject}"`,
        );
      });
    },
  });
}
