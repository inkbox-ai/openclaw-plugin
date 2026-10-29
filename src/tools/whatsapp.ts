import { Type } from "typebox";
import { getMessageRequestKey } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import { mapInkboxError, runTool, toolError, toolText } from "../errors.js";
import { formatJson } from "../format.js";
import { checkOutboundRecipients } from "../allowlist.js";
import { activeNativeSource, assertNativeSource } from "../native-source.js";
import {
  acceptedWhatsApp,
  validateWhatsAppSend,
  whatsappFile,
  whatsappReady,
  whatsappSendRejection,
  whatsappSendKey,
  whatsappRecipients,
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
          "Send WhatsApp using one recipient, 2–8 recipients for a group, or an existing direct/group conversation with optional quoted reply and owned media. Active-source replies inherit their quote target; explicit destinations remain authoritative. Approved access required. Preserve idempotencyKey after uncertainty. Ordinary final replies are sent automatically; do not send them twice.",
        parameters: Type.Object(
          {
            to: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1, maxItems: 8 })])),
            replyToMessageId: Type.Optional(Type.String({ minLength: 1 })),
            groupName: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
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
            const conversationId = params.conversationId !== undefined ? params.conversationId :
              (params.to === undefined && source?.whatsapp ? source.conversationId : undefined);
            validateWhatsAppSend({ ...params, conversationId });
            const identity = await runtime.getIdentity();
            const explicitRecipients = params.to === undefined ? undefined : whatsappRecipients(params.to);
            if (source) {
              assertNativeSource(source, identity.id);
              await source.validate();
            }
            const directRecipient = explicitRecipients?.length === 1 ? explicitRecipients[0] : "";
            const bound = Boolean(
              source?.whatsapp && (
                (!params.to && conversationId === source.conversationId) ||
                (!source.isGroup && /^\+[1-9]\d{6,14}$/.test(directRecipient) && directRecipient === source.author)
              ),
            );
            const targetConversationId = bound ? source!.conversationId : conversationId;
            let recipients = explicitRecipients ?? [];
            // A caller-supplied recovery key never acquires a new quote target.
            const replyToMessageId = params.replyToMessageId ?? (bound
              ? params.idempotencyKey
                ? await source!.whatsappReplyTarget?.(params.idempotencyKey)
                : source!.replyToMessageId
              : undefined);
            const request = {
              ...(explicitRecipients && !bound ? { to: explicitRecipients.length === 1 ? explicitRecipients[0]! : explicitRecipients } : { conversationId: targetConversationId }),
              ...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
              ...(params.groupName !== undefined ? { groupName: params.groupName } : {}),
              ...(params.text !== undefined ? { text: params.text } : {}),
              ...(params.mediaIds !== undefined ? { mediaIds: params.mediaIds } : {}),
            };
            validateWhatsAppSend(request);
            if (!params.idempotencyKey && (typeof callId !== "string" || !callId.trim())) throw new Error("A stable host tool call ID or explicit idempotencyKey is required.");
            const tracked = source?.whatsapp === true;
            const destination = bound ? undefined : targetConversationId ? { conversationId: targetConversationId } : { to: explicitRecipients };
            if (targetConversationId) {
              const conversation =
                await identity.getWhatsAppConversation(targetConversationId);
              if (
                conversation.agentIdentityId !== identity.id ||
                !Array.isArray(conversation.participants) || !conversation.participants.length ||
                conversation.participants.some((number: string) => !/^\+[1-9]\d{6,14}$/.test(number)) ||
                (conversation.unresolvedParticipantCount ?? 0) > 0
              )
                throw new Error(
                  "A resolved conversation owned by this identity is required.",
                );
              recipients = conversation.participants;
            }
            const block = checkOutboundRecipients(recipients, allowedRecipients);
            if (block) throw new Error(block);
            await whatsappReady(identity);
            const keyParts: unknown[] = [identity.id, [context.sessionKey, source?.whatsapp ? source.sourceMessageId : undefined, callId],
              targetConversationId ?? explicitRecipients, params.text, params.mediaIds];
            if (replyToMessageId || params.groupName) keyParts.push({ replyToMessageId, groupName: params.groupName });
            const idempotencyKey = params.idempotencyKey ?? whatsappSendKey(keyParts);
            if (tracked) {
              try { await source!.beforeSend(callId, { idempotencyKey, text: params.text, ...(params.mediaIds ? { mediaIds: params.mediaIds } : {}), ...(replyToMessageId ? { replyToMessageId } : {}), ...(params.groupName ? { groupName: params.groupName } : {}), ...(destination ? { destination } : {}) }); }
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
              message = await identity.sendWhatsApp({ ...request, idempotencyKey });
            } catch (error) {
              const key = getMessageRequestKey(error) ?? idempotencyKey;
              const policy = whatsappSendRejection(error);
              if (policy) {
                if (tracked && source!.rejectSend) {
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
            if (tracked) {
              try {
                await source!.afterSend(callId, message.id, params.text, message.status === "uncertain", message.conversationId);
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
        return { ...status, limits: current.limits, usage: current.usage };
      } catch {
        return status; // Retained history/status remains usable if policy lookup is unavailable.
      }
    },
  );
  read(
    "inkbox_list_whatsapp_conversations",
    "List direct and group WhatsApp conversations with local unread counts; retained history remains readable when sending is disabled.",
    { ...page, includeGroups: Type.Optional(Type.Boolean()) },
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
      includeGroups: Type.Optional(Type.Boolean()), threadId: Type.Optional(Type.String()),
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
  read("inkbox_get_whatsapp_thread", "Read a chronological quoted-reply thread with bounded pagination.",
    { messageId: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cursor: Type.Optional(Type.String()) },
    (i, p) => i.getWhatsAppThread(p.messageId, { limit: p.limit, cursor: p.cursor }));
  read("inkbox_get_whatsapp_conversation_thread", "Read one owned conversation's quoted-reply thread.",
    { conversationId: Type.String(), threadId: Type.String(), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })), cursor: Type.Optional(Type.String()) },
    (i, p) => i.getWhatsAppConversationThread(p.conversationId, p.threadId, { limit: p.limit, cursor: p.cursor }));
  read("inkbox_get_whatsapp_reaction", "Read the original reaction receipt; queued or uncertain is not applied.",
    { reactionId: Type.String() }, (i, p) => i.getWhatsAppReaction(p.reactionId));
  for (const remove of [false, true]) api.registerTool((context: { sessionKey?: string }) => {
    const source = activeNativeSource(context.sessionKey);
    return {
      name: remove ? "inkbox_remove_whatsapp_reaction" : "inkbox_send_whatsapp_reaction",
      description: remove ? "Remove this exact WhatsApp reaction revision. Preserve the original idempotency key after uncertainty."
        : "React to one whole WhatsApp message with a named reaction or custom emoji. Preserve the original idempotency key; queued is not applied.",
      parameters: Type.Object(remove ? { reactionId: Type.String(), idempotencyKey: Type.String({ minLength: 1 }) } : {
        messageId: Type.String(), reaction: Type.Optional(Type.Union(["love", "like", "dislike", "laugh", "emphasize", "question", "eyes"].map((name) => Type.Literal(name)))),
        customEmoji: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })), idempotencyKey: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }),
      async execute(_id: string, params: any) { return runTool(async () => {
        const identity = await runtime.getIdentity();
        if (source) { assertNativeSource(source, identity.id); await source.validate(); }
        if (!remove && Boolean(params.reaction) === Boolean(params.customEmoji)) throw new Error("Specify reaction or customEmoji.");
        const receipt = remove ? await identity.getWhatsAppReaction(params.reactionId) : undefined;
        const message = await identity.getWhatsAppMessage(receipt?.targetMessageId ?? params.messageId);
        if (message.agentIdentityId !== identity.id) throw new Error("The WhatsApp reaction target is not owned by this identity.");
        const conversation = await identity.getWhatsAppConversation(message.conversationId);
        if (conversation.agentIdentityId !== identity.id || !Array.isArray(conversation.participants) || !conversation.participants.length || conversation.participants.some((number: string) => !/^\+[1-9]\d{6,14}$/.test(number)) || (conversation.unresolvedParticipantCount ?? 0) > 0) throw new Error("The WhatsApp conversation is unavailable.");
        const block = checkOutboundRecipients(conversation.participants, allowedRecipients); if (block) throw new Error(block);
        await whatsappReady(identity);
        if (source) { assertNativeSource(source, identity.id); await source.validate(); assertNativeSource(source, identity.id); }
        try {
          const result = remove ? await identity.removeWhatsAppReaction(params.reactionId, params.idempotencyKey)
            : await identity.sendWhatsAppReaction({ messageId: params.messageId, ...(params.reaction ? { reaction: params.reaction } : { customEmoji: params.customEmoji }), idempotencyKey: params.idempotencyKey });
          return toolText(formatJson(result));
        } catch (error) {
          const result = mapInkboxError(error);
          result.content[0]!.text += `\nOriginal reaction idempotency key: ${params.idempotencyKey}. Reuse this exact operation and key; do not create another request. Queued or uncertain is not applied.`;
          result.details = { ...result.details, idempotencyKey: params.idempotencyKey };
          return result;
        }
      }); },
    };
  }, { names: [remove ? "inkbox_remove_whatsapp_reaction" : "inkbox_send_whatsapp_reaction"] });
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
