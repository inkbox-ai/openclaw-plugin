import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";

function normalizeRecipients(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
  }
  return undefined;
}

function formatTargetSummary(msg: any, params: any): string {
  if (typeof params.conversationId === "string" && params.conversationId.trim()) {
    return `conversation=${params.conversationId.trim()}`;
  }
  const recipients = Array.isArray(msg?.recipients)
    ? msg.recipients
        .map((entry: any) => entry?.recipientPhoneNumber ?? entry?.recipient_phone_number)
        .filter(Boolean)
    : undefined;
  if (recipients?.length) {
    return `to=${recipients.join(",")}`;
  }
  const toList = normalizeRecipients(params.to) ?? [];
  return `to=${toList.join(",")}`;
}

// Outbound SMS/MMS — sends from the identity's provisioned phone number.
// The new Inkbox text API can address a conversation UUID or 1-8
// recipients; group sends are routed as MMS by Inkbox.
export function registerSendSms(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
): void {
  api.registerTool({
    name: "inkbox_send_sms",
    description:
      "Send a text from the configured Inkbox identity's phone number. Use `conversationId` to reply into an existing 1:1 or group conversation, or `to` for one E.164 recipient or a 2-8 recipient group MMS. Recipients must have opted in unless Inkbox policy allows the send.",
    parameters: Type.Object({
      to: Type.Optional(
        Type.Union([
          Type.String({
            description: "Recipient phone number in E.164 format (e.g. +14155550123).",
          }),
          Type.Array(
            Type.String({
              description: "Recipient phone number in E.164 format.",
            }),
            {
              minItems: 1,
              maxItems: 8,
              description: "One to eight recipients. Two or more sends a group MMS.",
            },
          ),
        ]),
      ),
      conversationId: Type.Optional(
        Type.String({
          description:
            "Existing Inkbox text conversation UUID. Preferred when replying to a listed conversation, especially a group chat. Mutually exclusive with `to`.",
        }),
      ),
      text: Type.String({
        minLength: 1,
        maxLength: 1600,
        description: "Message body (1-1600 chars).",
      }),
      mediaUrls: Type.Optional(
        Type.Array(Type.String({ description: "Publicly fetchable MMS media URL." }), {
          minItems: 1,
          maxItems: 10,
          description: "Optional MMS media attachments.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const conversationId =
          typeof params.conversationId === "string" ? params.conversationId.trim() : "";
        const toList = normalizeRecipients(params.to);
        const hasTo = toList !== undefined && toList.length > 0;
        const hasConversation = Boolean(conversationId);
        if (hasTo === hasConversation) {
          return toolError("Specify exactly one of `to` or `conversationId`.");
        }
        if (toList?.length === 0) {
          return toolError("`to` must include at least one recipient.");
        }
        if (toList && toList.length > 8) {
          return toolError("Inkbox group texts support at most 8 recipients.");
        }
        if (toList) {
          for (const recipient of toList) {
            const block = checkOutboundRecipient(recipient, allowedRecipients);
            if (block) return toolError(block);
          }
        } else if (allowedRecipients?.length) {
          return toolError(
            "`conversationId` sends cannot be checked against the local outbound recipient allowlist. Use explicit `to` recipients or adjust the allowlist.",
          );
        }

        const identity = await runtime.getIdentity();
        const payload: any = {
          text: params.text,
          ...(Array.isArray(params.mediaUrls) && params.mediaUrls.length
            ? { mediaUrls: params.mediaUrls }
            : {}),
          ...(hasConversation
            ? { conversationId }
            : { to: toList!.length === 1 ? toList![0] : toList }),
        };
        const msg = await identity.sendText(payload);
        const target = formatTargetSummary(msg, params);
        const status = msg.deliveryStatus ?? "unknown";
        return toolText(
          `Sent text id=${msg.id} ${target} status=${status} (${params.text.length} chars)`,
        );
      });
    },
  });
}
