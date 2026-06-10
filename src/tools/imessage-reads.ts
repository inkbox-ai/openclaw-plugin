import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatWithHeader, formatJson } from "../format.js";

// Read/lifecycle surface for iMessage. Conversations are the canonical
// thread key — iMessage rides shared Inkbox-managed numbers, so there is no
// local-number addressing and no group support.
export function registerIMessageReads(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_imessage_conversations",
    description:
      "List iMessage conversation summaries for the configured Inkbox identity. Returns conversation IDs for replies, latest-message previews, unread counts, and `assignmentStatus` (released = that person disconnected from the agent; replies fail until they reconnect through the Inkbox iMessage router).",
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
        const convos = await identity.listIMessageConversations({
          limit: params.limit ?? 25,
          offset: params.offset ?? 0,
        });
        return toolText(
          formatWithHeader(`Returned ${convos.length} iMessage conversation(s).`, convos),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_imessage_conversation",
    description:
      "Fetch messages in one iMessage conversation, newest first. Messages include any live tapback reactions.",
    parameters: Type.Object({
      conversationId: Type.String({
        description: "Inkbox iMessage conversation UUID from `inkbox_list_imessage_conversations`.",
      }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum number of messages to return.",
        }),
      ),
      offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const msgs = await identity.listIMessages({
          conversationId: params.conversationId,
          limit: params.limit ?? 50,
          offset: params.offset ?? 0,
        });
        return toolText(
          formatWithHeader(
            `Returned ${msgs.length} iMessage(s) in conversation ${params.conversationId}.`,
            msgs,
          ),
        );
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_imessage_triage_number",
      description:
        "Return the Inkbox iMessage router number and the connect command a person texts to it (from an iPhone) to reach this agent over iMessage. Share these when someone asks how to iMessage the agent.",
      parameters: Type.Object({}),
      async execute(_id: string, _params: any) {
        return runTool(async () => {
          const [client, identity] = await Promise.all([
            runtime.getClient(),
            runtime.getIdentity(),
          ]);
          const triage = await client.imessages.getTriageNumber();
          // The server may return a placeholder command; pin it to this
          // identity's handle so the agent can hand it out verbatim.
          const connectCommand =
            triage.connectCommand && !triage.connectCommand.includes("your-handle")
              ? triage.connectCommand
              : `connect @${identity.agentHandle}`;
          return toolText(
            formatJson({ number: triage.number, connectCommand }),
          );
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_list_imessage_assignments",
      description:
        "List the people actively connected to this agent over iMessage (one row per recipient, newest first). Released connections are not returned. Use to answer who the agent can currently iMessage.",
      parameters: Type.Object({
        limit: Type.Optional(
          Type.Integer({ minimum: 1, maximum: 200, default: 25 }),
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0, default: 0 })),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const assignments = await identity.listIMessageAssignments({
            limit: params.limit ?? 25,
            offset: params.offset ?? 0,
          });
          return toolText(
            formatWithHeader(
              `Returned ${assignments.length} active iMessage connection(s).`,
              assignments,
            ),
          );
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_send_imessage_reaction",
      description: "Send a tapback reaction to an iMessage the agent received.",
      parameters: Type.Object({
        messageId: Type.String({ description: "UUID of the iMessage being reacted to." }),
        reaction: Type.Union(
          [
            Type.Literal("love"),
            Type.Literal("like"),
            Type.Literal("dislike"),
            Type.Literal("laugh"),
            Type.Literal("emphasize"),
            Type.Literal("question"),
          ],
          { description: "Tapback kind." },
        ),
        partIndex: Type.Optional(
          Type.Integer({
            minimum: 0,
            default: 0,
            description: "Part of a multi-part message to react to.",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const reaction = await identity.sendIMessageReaction({
            messageId: params.messageId,
            reaction: params.reaction,
            partIndex: params.partIndex ?? 0,
          });
          return toolText(
            `Sent ${reaction.reaction} tapback to message ${params.messageId} (reaction id=${reaction.id}).`,
          );
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_mark_imessage_conversation_read",
      description:
        "Send a read receipt and mark every inbound message in an iMessage conversation as read.",
      parameters: Type.Object({
        conversationId: Type.String({
          description: "Inkbox iMessage conversation UUID.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const result = await identity.markIMessageConversationRead(
            params.conversationId,
          );
          return toolText(
            `Marked ${result.updatedCount} message(s) as read in conversation ${params.conversationId}.`,
          );
        });
      },
    },
    { optional: true },
  );
}
