import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolError, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

function resolveConversationKey(params: any): { key?: string; error?: string; label?: string } {
  const conversationId =
    typeof params.conversationId === "string" ? params.conversationId.trim() : "";
  const remotePhoneNumber =
    typeof params.remotePhoneNumber === "string" ? params.remotePhoneNumber.trim() : "";
  const keyCount = Number(Boolean(conversationId)) + Number(Boolean(remotePhoneNumber));
  if (keyCount !== 1) {
    return {
      error: "Specify exactly one of `conversationId` or `remotePhoneNumber`.",
    };
  }
  if (conversationId) {
    return { key: conversationId, label: `conversation ${conversationId}` };
  }
  return { key: remotePhoneNumber, label: `conversation with ${remotePhoneNumber}` };
}

// Read-side surface for SMS/MMS. The server's canonical thread key is now
// conversationId, with remotePhoneNumber retained for 1:1 compatibility.
export function registerSmsReads(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_text_conversations",
    description:
      "List text conversation summaries for the configured Inkbox identity's phone number. Includes group chats by default; each row carries `id`/`conversationId`-style UUID data, participants, latest message, unread count, and legacy `remotePhoneNumber` for 1:1 threads.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          default: 25,
          description: "Maximum number of conversations to return.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, default: 0, description: "Pagination offset." }),
      ),
      includeGroups: Type.Optional(
        Type.Boolean({
          default: true,
          description:
            "Include group conversations. Defaults to true so group SMS triage works.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const convos = await identity.listTextConversations({
          limit: params.limit ?? 25,
          offset: params.offset ?? 0,
          includeGroups: params.includeGroups ?? true,
        });
        return toolText(
          formatWithHeader(
            `Returned ${convos.length} text conversation(s).`,
            convos,
          ),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_text_conversation",
    description:
      "Fetch messages in a specific text conversation. Use `conversationId` for group chats or any canonical conversation row; `remotePhoneNumber` is the legacy 1:1 fallback.",
    parameters: Type.Object({
      conversationId: Type.Optional(
        Type.String({
          description: "Inkbox text conversation UUID from `inkbox_list_text_conversations`.",
        }),
      ),
      remotePhoneNumber: Type.Optional(
        Type.String({
          description: "Legacy 1:1 remote E.164 phone number identifying the conversation.",
        }),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 500,
          default: 50,
          description: "Maximum number of messages to return.",
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const resolved = resolveConversationKey(params);
        if (resolved.error || !resolved.key) {
          return toolError(resolved.error ?? "Missing conversation key.");
        }
        const identity = await runtime.getIdentity();
        const msgs = await identity.getTextConversation(
          resolved.key,
          { limit: params.limit ?? 50, offset: params.offset ?? 0 },
        );
        return toolText(
          formatWithHeader(
            `Returned ${msgs.length} text(s) in ${resolved.label}.`,
            msgs,
          ),
        );
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_list_texts",
      description:
        "List individual SMS messages. Prefer inkbox_list_text_conversations for triage; this one is for low-level access to all texts regardless of conversation.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 200, default: 25 }),
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
        isRead: Type.Optional(
          Type.Boolean({ description: "Filter by read state." }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const texts = await identity.listTexts({
            limit: params.limit ?? 25,
            offset: params.offset ?? 0,
            isRead: params.isRead,
          });
          return toolText(
            formatWithHeader(`Returned ${texts.length} text(s).`, texts),
          );
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_get_text",
      description: "Fetch a single SMS by text message UUID. Includes MMS media URLs if present.",
      parameters: Type.Object({
        textId: Type.String({ description: "UUID of the text message." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const text = await identity.getText(params.textId);
          return toolText(formatJson(text));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_mark_text_read",
      description: "Mark a single SMS as read.",
      parameters: Type.Object({
        textId: Type.String({ description: "UUID of the text message." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          await identity.markTextRead(params.textId);
          return toolText(`Marked text ${params.textId} as read.`);
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_mark_text_conversation_read",
      description:
        "Mark every message in a text conversation as read. Use `conversationId` for group chats; `remotePhoneNumber` is the legacy 1:1 fallback.",
      parameters: Type.Object({
        conversationId: Type.Optional(
          Type.String({
            description: "Inkbox text conversation UUID from `inkbox_list_text_conversations`.",
          }),
        ),
        remotePhoneNumber: Type.Optional(
          Type.String({
            description: "Legacy 1:1 remote E.164 phone number identifying the conversation.",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const resolved = resolveConversationKey(params);
          if (resolved.error || !resolved.key) {
            return toolError(resolved.error ?? "Missing conversation key.");
          }
          const identity = await runtime.getIdentity();
          const result = await identity.markTextConversationRead(
            resolved.key,
          );
          return toolText(
            `Marked ${result.updatedCount} message(s) as read in ${resolved.label}.`,
          );
        });
      },
    },
    { optional: true },
  );
}
