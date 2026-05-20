import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

// Read-side surface for SMS. Most agent flows want the conversation view
// (one row per remote number) rather than the raw message list; that's why
// list_text_conversations / get_text_conversation are required while
// list_texts / get_text are optional.
export function registerSmsReads(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_text_conversations",
    description:
      "List SMS conversation summaries for the configured Inkbox identity's phone number. One row per remote number, with latest message + unread count. Use as the entry point for SMS triage.",
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
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const convos = await identity.listTextConversations({
          limit: params.limit ?? 25,
          offset: params.offset ?? 0,
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
      "Fetch messages in a specific SMS conversation, keyed by the remote E.164 number.",
    parameters: Type.Object({
      remotePhoneNumber: Type.String({
        description: "Remote E.164 phone number identifying the conversation.",
      }),
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
        const identity = await runtime.getIdentity();
        const msgs = await identity.getTextConversation(
          params.remotePhoneNumber,
          { limit: params.limit ?? 50, offset: params.offset ?? 0 },
        );
        return toolText(
          formatWithHeader(
            `Returned ${msgs.length} text(s) with ${params.remotePhoneNumber}.`,
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
        "Mark every message in a conversation as read, identified by the remote E.164 number.",
      parameters: Type.Object({
        remotePhoneNumber: Type.String({
          description: "Remote E.164 phone number identifying the conversation.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const result = await identity.markTextConversationRead(
            params.remotePhoneNumber,
          );
          return toolText(
            `Marked ${result.updatedCount} message(s) as read in conversation with ${params.remotePhoneNumber}.`,
          );
        });
      },
    },
    { optional: true },
  );
}
