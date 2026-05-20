import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader, takeAsync } from "../format.js";

// Read-side surface for the email channel. iterEmails / iterUnreadEmails are
// unbounded async generators on the SDK; we cap them with takeAsync() so the
// agent can't accidentally pull a whole mailbox into one tool call.
export function registerEmailReads(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_unread_emails",
    description:
      "List unread emails in the configured Inkbox identity's mailbox. Returns at most `limit` messages, newest first. Use this as the entry point for email triage flows.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          default: 25,
          description: "Maximum number of messages to return (default 25, max 200).",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const limit = params.limit ?? 25;
        const msgs = await takeAsync(identity.iterUnreadEmails(), limit);
        return toolText(
          formatWithHeader(`Found ${msgs.length} unread email(s).`, msgs),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_list_emails",
    description:
      "List emails in the configured Inkbox identity's mailbox. Optionally filter by direction (inbound/outbound). Returns at most `limit` messages, newest first.",
    parameters: Type.Object({
      direction: Type.Optional(
        Type.Union(
          [Type.Literal("inbound"), Type.Literal("outbound")],
          { description: "Filter by direction. Omit for both." },
        ),
      ),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          default: 25,
          description: "Maximum number of messages to return.",
        }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const limit = params.limit ?? 25;
        const msgs = await takeAsync(
          identity.iterEmails({ direction: params.direction }),
          limit,
        );
        return toolText(
          formatWithHeader(`Returned ${msgs.length} email(s).`, msgs),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_email",
    description:
      "Fetch a single email by message UUID. Returns full body (text + HTML), addresses, and threading info.",
    parameters: Type.Object({
      messageId: Type.String({ description: "UUID of the message to fetch." }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const msg = await identity.getMessage(params.messageId);
        return toolText(formatJson(msg));
      });
    },
  });

  api.registerTool({
    name: "inkbox_get_email_thread",
    description:
      "Fetch a full email thread by thread UUID. Messages returned oldest-first. Includes the thread's folder (inbox/spam/archive/blocked).",
    parameters: Type.Object({
      threadId: Type.String({ description: "UUID of the thread to fetch." }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const thread = await identity.getThread(params.threadId);
        return toolText(formatJson(thread));
      });
    },
  });

  api.registerTool(
    {
      name: "inkbox_mark_emails_read",
      description:
        "Mark one or more emails as read by message UUID. Pair with inkbox_list_unread_emails to clear the unread queue after processing.",
      parameters: Type.Object({
        messageIds: Type.Array(Type.String(), {
          minItems: 1,
          description: "Message UUIDs to mark as read.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          await identity.markEmailsRead(params.messageIds);
          return toolText(
            `Marked ${params.messageIds.length} email(s) as read.`,
          );
        });
      },
    },
    { optional: true },
  );
}
