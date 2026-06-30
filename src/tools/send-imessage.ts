import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";
import { IMESSAGE_MAX_TEXT_CHARS, imessageTextTooLongMessage } from "../message-limits.js";

// Outbound iMessage — recipient-first channel: a person must have connected
// to this identity through the Inkbox iMessage router and messaged it before
// outbound sends work, so there is no cold outreach. Server-side gates
// (recipient hasn't messaged yet, released connection, quota) surface as
// API errors rather than being pre-checked here.
export function registerSendIMessage(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
): void {
  api.registerTool({
    name: "inkbox_send_imessage",
    description:
      "Send an iMessage from the configured Inkbox identity. Recipient-first channel: a person must have connected via the Inkbox iMessage router and messaged this agent before outbound sends work, so prefer `conversationId` from an inbound message or `inkbox_list_imessage_conversations`.",
    parameters: Type.Object({
      to: Type.Optional(
        Type.String({
          description:
            "Recipient phone number in E.164 format. Only works after that person has messaged this agent. Mutually exclusive with `conversationId`.",
        }),
      ),
      conversationId: Type.Optional(
        Type.String({
          description:
            "Existing Inkbox iMessage conversation UUID. Preferred for replies. Mutually exclusive with `to`.",
        }),
      ),
      text: Type.Optional(
        Type.String({
          maxLength: IMESSAGE_MAX_TEXT_CHARS,
          description: "Message body, max 18995 chars. Provide `text`, `mediaUrls`, or both.",
        }),
      ),
      mediaUrls: Type.Optional(
        Type.Array(Type.String({ description: "Publicly fetchable media URL." }), {
          minItems: 1,
          maxItems: 1,
          description: "Optional media attachment (at most one per message).",
        }),
      ),
      sendStyle: Type.Optional(
        Type.Union(
          [
            "celebration",
            "shooting_star",
            "fireworks",
            "lasers",
            "love",
            "confetti",
            "balloons",
            "spotlight",
            "echo",
            "invisible",
            "gentle",
            "loud",
            "slam",
          ].map((style) => Type.Literal(style)),
          { description: "Optional expressive iMessage send style." },
        ),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const text = typeof params.text === "string" ? params.text : "";
        const mediaUrls = Array.isArray(params.mediaUrls) ? params.mediaUrls : undefined;
        if (!text && !mediaUrls?.length) {
          return toolError("Provide `text`, `mediaUrls`, or both.");
        }
        if (text.length > IMESSAGE_MAX_TEXT_CHARS) {
          return toolError(imessageTextTooLongMessage(text));
        }
        const conversationId =
          typeof params.conversationId === "string" ? params.conversationId.trim() : "";
        const to = typeof params.to === "string" ? params.to.trim() : "";
        if (Boolean(conversationId) === Boolean(to)) {
          return toolError("Specify exactly one of `to` or `conversationId`.");
        }
        if (to) {
          const block = checkOutboundRecipient(to, allowedRecipients);
          if (block) return toolError(block);
        } else if (allowedRecipients?.length) {
          return toolError(
            "`conversationId` sends cannot be checked against the local outbound recipient allowlist. Use an explicit `to` recipient or adjust the allowlist.",
          );
        }

        const identity = await runtime.getIdentity();
        const msg = await identity.sendIMessage({
          ...(conversationId ? { conversationId } : { to }),
          ...(text ? { text } : {}),
          ...(mediaUrls?.length ? { mediaUrls } : {}),
          ...(params.sendStyle ? { sendStyle: params.sendStyle } : {}),
        });
        const target = conversationId ? `conversation=${conversationId}` : `to=${to}`;
        return toolText(
          `Sent iMessage id=${msg.id} ${target} conversation_id=${msg.conversationId} status=${msg.status ?? "unknown"}`,
        );
      });
    },
  });
}
