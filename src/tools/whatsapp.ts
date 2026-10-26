import { Type } from "typebox";
import { getMessageRequestKey } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import { mapInkboxError, runTool, toolError, toolText } from "../errors.js";
import { formatJson } from "../format.js";
import { checkOutboundRecipient } from "../allowlist.js";
import { activeNativeSource, assertNativeSource } from "../native-source.js";
import {
  acceptedWhatsApp,
  assertWhatsAppText,
  whatsappFile,
  whatsappReady,
  whatsappSendRejection,
  whatsappSendKey,
} from "../whatsapp.js";
import {
  silentSendCompletionParameter,
  sentToolText,
} from "./send-completion.js";

export function registerWhatsAppTools(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
) {
  api.registerTool(
    (context: { sessionKey?: string }) => {
      const source = activeNativeSource(context.sessionKey);
      return {
        name: "inkbox_send_whatsapp",
        description:
          "Send one-to-one WhatsApp using one E.164 recipient or an existing conversation and optional owned media ID. Approved access required. Preserve idempotencyKey after uncertainty. Ordinary final replies are sent automatically; do not send them twice.",
        parameters: Type.Object(
          {
            to: Type.Optional(Type.String()),
            conversationId: Type.Optional(Type.String()),
            text: Type.Optional(Type.String({ maxLength: 4000 })),
            mediaIds: Type.Optional(Type.Array(Type.String(), { maxItems: 1 })),
            idempotencyKey: Type.Optional(Type.String()),
            completeSilently: silentSendCompletionParameter,
          },
          { additionalProperties: false },
        ),
        async execute(callId: string, params: any) {
          return runTool(async () => {
            const identity = await runtime.getIdentity();
            const conversationId =
              params.conversationId ??
              (!params.to && source?.whatsapp ? source.conversationId : undefined);
            if (!!params.to === !!conversationId)
              throw new Error("Specify exactly one of to or conversationId.");
            if (!params.text?.trim() && !params.mediaIds?.length)
              throw new Error("Provide text or one owned media ID.");
            if ((params.mediaIds?.length ?? 0) > 1)
              throw new Error("WhatsApp supports one attachment.");
            assertWhatsAppText(params.text ?? "");
            if (source) {
              assertNativeSource(source, identity.id);
              await source.validate();
            }
            const directRecipient = typeof params.to === "string" ? params.to.replace(/[\s().-]/g, "") : "";
            const bound = Boolean(
              source?.whatsapp && (
                (!params.to && conversationId === source.conversationId) ||
                (/^\+[1-9]\d{6,14}$/.test(directRecipient) && directRecipient === source.author)
              ),
            );
            const targetConversationId = bound ? source!.conversationId : conversationId;
            let recipient = params.to;
            if (targetConversationId) {
              const conversation =
                await identity.getWhatsAppConversation(targetConversationId);
              if (
                conversation.agentIdentityId !== identity.id ||
                conversation.isGroup ||
                conversation.participants.length !== 1
              )
                throw new Error(
                  "A direct conversation owned by this identity is required.",
                );
              recipient =
                conversation.remoteNumber ?? conversation.participants[0];
            }
            const block = checkOutboundRecipient(recipient, allowedRecipients);
            if (block) throw new Error(block);
            await whatsappReady(identity);
            const idempotencyKey = params.idempotencyKey ?? whatsappSendKey([
              identity.id, source?.whatsapp ? source.sourceMessageId : callId,
              targetConversationId ?? params.to, params.text, params.mediaIds,
            ]);
            if (bound) {
              try { await source!.beforeSend(callId, { idempotencyKey, text: params.text, ...(params.mediaIds ? { mediaIds: params.mediaIds } : {}) }); }
              catch (error) {
                const result = mapInkboxError(error), priorKey = getMessageRequestKey(error);
                result.content[0]!.text += "\nNo new WhatsApp request was attempted.";
                const policy = error instanceof Error && "whatsappRejection" in error ? error.whatsappRejection : undefined;
                if (priorKey) result.content[0]!.text += policy
                  ? ` Original request was rejected/not accepted: ${JSON.stringify(policy)}. Follow retry_condition and reuse the original key ${priorKey} with unchanged text and owned media IDs.`
                  : ` Earlier send key: ${priorKey}. Inspect it with inkbox_lookup_whatsapp_send; do not repeat it.`;
                result.details = { ...result.details, sendAttempted: false, ...(priorKey ? { idempotencyKey: priorKey } : {}) };
                return result;
              }
            }
            if (source) {
              assertNativeSource(source, identity.id);
              await source.validate();
              assertNativeSource(source, identity.id);
            }
            let message;
            try {
              message = await identity.sendWhatsApp({
                ...(params.to && !bound ? { to: params.to } : { conversationId: targetConversationId }),
                ...(params.text !== undefined ? { text: params.text } : {}),
                ...(params.mediaIds ? { mediaIds: params.mediaIds } : {}), idempotencyKey,
              });
            } catch (error) {
              const key = getMessageRequestKey(error) ?? idempotencyKey;
              const policy = whatsappSendRejection(error);
              if (policy) {
                if (bound && source!.rejectSend) {
                  try { await source!.rejectSend(callId, idempotencyKey, policy); }
                  catch { /* The durable intent stays fenced if its rejection cannot be saved. */ }
                }
                return toolError(`WhatsApp request rejected/not accepted: ${JSON.stringify(policy)}. Follow retry_condition, then reuse the original key ${key} and owned media IDs; do not create a new request.`,
                  { ...policy, idempotencyKey: key, requestAccepted: false, ...(params.mediaIds ? { mediaIds: params.mediaIds } : {}) });
              }
              const result = mapInkboxError(error);
              result.content[0]!.text += `\nOriginal idempotency key: ${key}. Use inkbox_lookup_whatsapp_send to inspect this send. Do not create a new key or another copy.`;
              result.details = { ...result.details, idempotencyKey: key };
              return result;
            }
            if (bound) {
              try {
                await source!.afterSend(callId, message.id, params.text);
              } catch {
                /* Accepted send remains accepted even if optional tracking fails. */
              }
            }
            return sentToolText(
              formatJson(acceptedWhatsApp(message, idempotencyKey)),
              params.completeSilently,
              { inkboxMessageId: message.id },
            );
          });
        },
      };
    },
    { names: ["inkbox_send_whatsapp"] },
  );
  const page = {
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
    offset: Type.Optional(Type.Integer({ minimum: 0 })),
  };
  const read = (
    name: string,
    description: string,
    fields: Record<string, any>,
    execute: (identity: any, params: any) => Promise<unknown>,
  ) =>
    api.registerTool({
      name,
      description,
      parameters: Type.Object(fields, { additionalProperties: false }),
      async execute(_id: string, params: any) {
        return runTool(async () =>
          toolText(
            formatJson(await execute(await runtime.getIdentity(), params)),
          ),
        );
      },
    });
  read(
    "inkbox_get_whatsapp_status",
    "Read fresh WhatsApp approval and availability; never enables access.",
    {},
    async (i) => {
      const status = await i.getWhatsAppStatus();
      if (!status) return status;
      try {
        const current = await i.getWhatsAppLimits();
        return { ...status, limits: current.limits, usage: current.usage, cycleStart: current.cycleStart };
      } catch {
        return status; // Retained history/status remains usable if policy lookup is unavailable.
      }
    },
  );
  read(
    "inkbox_list_whatsapp_conversations",
    "List direct WhatsApp conversations with local unread counts; retained history remains readable when sending is disabled.",
    page,
    (i, p) => i.listWhatsAppConversations(p),
  );
  read(
    "inkbox_get_whatsapp_conversation",
    "Read WhatsApp conversation metadata. Use list messages separately for history.",
    { conversationId: Type.String() },
    (i, p) => i.getWhatsAppConversation(p.conversationId),
  );
  read(
    "inkbox_list_whatsapp_messages",
    "List stored WhatsApp messages, newest first, with separate send/delivery state.",
    {
      ...page,
      conversationId: Type.Optional(Type.String()),
      isRead: Type.Optional(Type.Boolean()),
    },
    (i, p) => i.listWhatsAppMessages(p),
  );
  read(
    "inkbox_get_whatsapp_message",
    "Read the original WhatsApp message and status freshness. Uncertain sending and unknown delivery are not permission to resend.",
    { messageId: Type.String() },
    (i, p) => i.getWhatsAppMessage(p.messageId),
  );
  read(
    "inkbox_get_whatsapp_media",
    "Reauthorize owned WhatsApp media and retrieve fresh temporary URL/availability; never forward API credentials to that URL.",
    { mediaId: Type.String() },
    (i, p) => i.getWhatsAppMedia(p.mediaId),
  );
  read(
    "inkbox_mark_whatsapp_read",
    "Mark local history read through one exact message boundary. Sends no remote read receipt.",
    { conversationId: Type.String(), throughMessageId: Type.String() },
    (i, p) => i.markWhatsAppRead(p.conversationId, p.throughMessageId),
  );
  api.registerTool((context: { sessionKey?: string }) => {
    const source = activeNativeSource(context.sessionKey);
    return {
      name: "inkbox_upload_whatsapp_media",
      description: "Upload one local regular file within current organization limits (20 MiB protocol ceiling). Retain its owned media ID for send retries.",
      parameters: Type.Object({ filePath: Type.String(), contentType: Type.Optional(Type.String()) }, { additionalProperties: false }),
      async execute(_id: string, params: any) { return runTool(async () => {
        const identity = await runtime.getIdentity();
        if (source) { assertNativeSource(source, identity.id); await source.validate(); }
        const file = await whatsappFile(params.filePath);
        await whatsappReady(identity);
        if (source) { assertNativeSource(source, identity.id); await source.validate(); assertNativeSource(source, identity.id); }
        return toolText(formatJson(await identity.uploadWhatsAppMedia({ ...file, contentType: params.contentType })));
      }); },
    };
  }, { names: ["inkbox_upload_whatsapp_media"] });
  read(
    "inkbox_lookup_whatsapp_send",
    "Read-only lookup of the original message ID by logical-send key. A missing result does not authorize another key or send.",
    { idempotency_key: Type.String() },
    async (i, p) =>
      (await runtime.getClient()).messageSends.lookup({
        senderKind: "whatsapp_identity",
        senderId: i.id,
        operation: "whatsapp.send",
        idempotencyKey: p.idempotency_key,
      }),
  );
}
