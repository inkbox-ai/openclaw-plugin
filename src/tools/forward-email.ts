import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";

// Forward a previously received message out from the identity's mailbox.
// Inline (default) re-attaches original parts; wrapped attaches the original
// as a single .eml-style note. Optional only — not every workflow needs it.
export function registerForwardEmail(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_forward_email",
      description:
        "Forward a previously received email from the configured Inkbox identity's mailbox to one or more new recipients. Use 'inline' mode to re-attach original parts, or 'wrapped' to attach the original as a single .eml-style note.",
      parameters: Type.Object({
        messageId: Type.String({
          description: "UUID of the message to forward.",
        }),
        to: Type.Optional(
          Type.Array(Type.String(), {
            description: "Primary recipients of the forward.",
          }),
        ),
        cc: Type.Optional(Type.Array(Type.String())),
        bcc: Type.Optional(Type.Array(Type.String())),
        mode: Type.Optional(
          Type.Union([Type.Literal("inline"), Type.Literal("wrapped")], {
            description:
              "Inline (default) re-attaches original parts. Wrapped attaches the original as a single .eml-style note.",
          }),
        ),
        subject: Type.Optional(
          Type.String({
            description:
              "Override subject. Defaults to 'Fwd: <original subject>'.",
          }),
        ),
        bodyText: Type.Optional(
          Type.String({
            description:
              "Optional caller note prepended above the original body (inline) or as a top-level note (wrapped).",
          }),
        ),
        bodyHtml: Type.Optional(
          Type.String({ description: "Optional HTML caller note." }),
        ),
        includeOriginalAttachments: Type.Optional(
          Type.Boolean({
            description:
              "Inline mode only. When true (default), original attachments are re-attached. Ignored in wrapped mode.",
          }),
        ),
        replyTo: Type.Optional(
          Type.String({ description: "Optional Reply-To address." }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const msg = await identity.forwardEmail(params.messageId, {
            to: params.to,
            cc: params.cc,
            bcc: params.bcc,
            mode: params.mode,
            subject: params.subject,
            bodyText: params.bodyText,
            bodyHtml: params.bodyHtml,
            includeOriginalAttachments: params.includeOriginalAttachments,
            replyTo: params.replyTo,
          });
          // Build a recipient summary; at least one of to/cc/bcc is required
          // by the API, so this is always non-empty.
          const recipients = [
            ...(params.to ?? []),
            ...(params.cc ?? []),
            ...(params.bcc ?? []),
          ].join(",");
          return toolText(
            `Forwarded message id=${params.messageId} as=${msg.id} to=${recipients} mode=${params.mode ?? "inline"}`,
          );
        });
      },
    },
    { optional: true },
  );
}
