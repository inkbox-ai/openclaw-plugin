import { createHash } from "node:crypto";
import { activeNativeSource, assertNativeSource } from "../native-source.js";
import { verifyNativeIMessageTarget } from "../imessage-threading.js";
import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolError } from "../errors.js";
import { sentToolText, silentSendCompletionParameter } from "./send-completion.js";
import { checkOutboundRecipient } from "../allowlist.js";
import { IMESSAGE_MAX_TEXT_CHARS, imessageTextTooLongMessage } from "../message-limits.js";
import { saveOutboundContext } from "../delivery-failure.js";

// Outbound iMessage — recipient-first channel: a person must have connected
// to this identity through the Inkbox iMessage router and messaged it before
// outbound sends work, so there is no cold outreach. Server-side gates
// (recipient hasn't messaged yet, released connection, quota) surface as
// API errors rather than being pre-checked here.
const MAX_GROUP_RECIPIENTS = 8;

// `to` accepts one recipient or a list; normalize both to a trimmed array.
function normalizeRecipients(value: unknown): string[] {
  if (typeof value === "string") {
    const entry = value.trim();
    return entry ? [entry] : [];
  }
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  return [];
}

// Only a dedicated outbound line may open a conversation; everything else is
// recipient-first, so a group send would fail at the API without this check.
function identityCanStartImessageConversations(identity: any): boolean {
  const number = identity?.imessageNumber ?? identity?.imessage_number;
  if (!number) return false;
  const canStart = number.canStartConversations ?? number.can_start_conversations;
  if (typeof canStart === "boolean") return canStart;
  const numberType = number.type?.value ?? number.type;
  return String(numberType ?? "").trim().toLowerCase() === "dedicated_outbound";
}

export function registerSendIMessage(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
  threadedRepliesEnabled: () => boolean = () => true,
): void {
  api.registerTool((context: { sessionKey?: string }) => {
    const source = activeNativeSource(context.sessionKey);
    return {
    name: "inkbox_send_imessage",
    description:
      "Send an iMessage from the configured Inkbox identity. Recipient-first channel: a person must have connected via the Inkbox iMessage router and messaged this agent before outbound sends work, so prefer `conversationId` from an inbound message or `inkbox_list_imessage_conversations`.",
    parameters: Type.Object({
      completeSilently: silentSendCompletionParameter,
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
        const validateSource = (identityId = source?.identityId) => {
          if (!source) return;
          if (source.replyToMessageId && !threadedRepliesEnabled()) throw new Error("Native iMessage replies are disabled; this source-owned send cannot be downgraded or continued.");
          assertNativeSource(source, identityId!);
        };
        validateSource();
        if ("replyToMessageId" in params || "plainReplyFallback" in params) return toolError("Reply targeting and fallback are owned by the current source, not model arguments.");
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
        const bound = Boolean(source?.replyToMessageId && !to && (!conversationId || conversationId === source.conversationId));
        if ((conversationId && to) || (!bound && !conversationId && !to)) {
          return toolError("Specify exactly one of `to` or `conversationId`.");
        }
        if (to) {
          const block = checkOutboundRecipient(to, allowedRecipients);
          if (block) return toolError(block);
        } else if (!bound && allowedRecipients?.length) {
          return toolError(
            "`conversationId` sends cannot be checked against the local outbound recipient allowlist. Use an explicit `to` recipient or adjust the allowlist.",
          );
        }

        const identity = await runtime.getIdentity();
        validateSource(identity.id);
        if (bound && source?.replyToMessageId) {
          const block = checkOutboundRecipient(source.author, allowedRecipients);
          if (block) return toolError(block);
          await verifyNativeIMessageTarget(identity, source.conversationId, source.replyToMessageId);
          validateSource(identity.id);
          await source.beforeSend(_id);
          validateSource(identity.id);
        } else if (source) {
          await source.validate();
          validateSource(identity.id);
        }
        const msg = await identity.sendIMessage({
          ...(bound && source?.replyToMessageId ? { conversationId: source.conversationId, replyToMessageId: source.replyToMessageId, plainReplyFallback: true,
            idempotencyKey: `openclaw:tool:${createHash("sha256").update(JSON.stringify([source.identityId, source.conversationId, source.replyToMessageId, _id, text, mediaUrls])).digest("hex")}` } : conversationId ? { conversationId } : { to }),
          ...(text ? { text } : {}),
          ...(mediaUrls?.length ? { mediaUrls } : {}),
          ...(params.sendStyle ? { sendStyle: params.sendStyle } : {}),
        });
        saveOutboundContext({
          messageId: msg.id,
          channel: "imessage",
          chatId: conversationId || to || msg.conversationId || msg.id,
          recipient: to || undefined,
          body: text || "[media attachment]",
          conversationId: conversationId || msg.conversationId,
        });
        // Only source-bound sends belong to this source's output history.
        // Independent destinations stay separate and never suppress its answer.
        if (bound && source?.replyToMessageId) {
          try { await source.recordIMessageAccepted?.(msg); } catch { /* Accepted send; optional history failure is not permission to resend. */ }
        }
        if (bound && source?.replyToMessageId) await source.afterSend(_id, msg.id, text);
        const target = conversationId ? `conversation=${conversationId}` : `to=${to}`;
        return sentToolText(
          `Sent iMessage id=${msg.id} ${target} conversation_id=${msg.conversationId} status=${msg.status ?? "unknown"}`,
          params.completeSilently,
        );
      });
    },
    };
  }, { names: ["inkbox_send_imessage"] });
}
