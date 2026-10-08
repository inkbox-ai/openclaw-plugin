import { isSubagentSessionKey } from "openclaw/plugin-sdk/routing";
import { slackMrkdwn } from "../slack-style.js";
import { checkedSlackUpload, recordSlackUploadRejection, slackFilePayload, slackUploadFingerprint, uploadSlackSourceFile } from "../slack-files.js";
import { activeNativeSource, assertNativeSource } from "../native-source.js";
import { Type, type TSchema } from "typebox";
import type { InkboxPluginConfig, InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson } from "../format.js";
import { ownSlackConnection, slackText, slackAuthorAllowed } from "../slack.js";

const str = () => Type.String({ minLength: 1 });
const page = () => ({ cursor: Type.Optional(str()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) });
const connection = () => ({ connectionId: str() });
const conversation = () => ({ ...connection(), conversationId: str() });
const specs: { name: string; description: string; properties: Record<string, TSchema> }[] = [
  { name: "list_connections", description: "List this identity's connected Slack workspaces.", properties: {} },
  { name: "list_conversations", description: "List accessible Slack conversations; follow nextCursor.", properties: { ...connection(), ...page() } },
  { name: "list_messages", description: "Read a Slack conversation or native thread; follow nextCursor.", properties: { ...conversation(), ...page(), threadTs: Type.Optional(str()) } },
  { name: "search", description: "Search retained Slack text, not complete workspace history or files. Follow nextCursor even on an empty page.", properties: { q: str(), connectionId: Type.Optional(str()), conversationId: Type.Optional(str()), ...page() } },
  { name: "send_message", description: "Send only when explicitly requested; ordinary replies are automatic. Reuse idempotencyKey for the same message. Inspect sending/unknown outcomes with get_action; never blindly resend.", properties: { ...conversation(), text: Type.String({ minLength: 1, maxLength: 12_000 }), threadTs: Type.Optional(Type.Union([str(), Type.Null()])), idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" }) } },
  { name: "upload_file", description: "Upload a requested local image or file (1 byte–10 MiB). Use filePath, not a URL. Reuse idempotencyKey only for the exact payload. Inspect get_operation after in_progress/unknown; never blindly resend.", properties: { ...conversation(), filePath: str(), filename: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })), title: Type.Optional(Type.String({ maxLength: 255 })), initialComment: Type.Optional(Type.String({ maxLength: 12_000 })), threadTs: Type.Optional(Type.Union([str(), Type.Null()])), idempotencyKey: Type.String({ pattern: "^[A-Za-z0-9._:-]{1,128}$" }) } },
  { name: "get_operation", description: "Inspect a Slack file upload. Poll only in_progress; unknown is not proof of failure or permission to resend.", properties: { ...connection(), operationId: str() } },
  { name: "get_action", description: "Inspect a Slack send action. Unknown is not proof of failure and must not cause a duplicate send.", properties: { ...connection(), actionId: str() } },
];
export function registerSlackTools(api: any, runtime: InkboxRuntime, config: () => Partial<InkboxPluginConfig>): void {
  if (!config().slackEnabled) return;
  for (const spec of specs) api.registerTool((context: { sessionKey?: string; sessionId?: string }) => {
    const source = activeNativeSource(context.sessionKey);
    return {
    name: `inkbox_slack_${spec.name}`, description: spec.description,
    parameters: Type.Object(spec.properties, { additionalProperties: false }),
    async execute(_id: string, args: Record<string, any>) {
      return runTool(async () => {
        const cfg = config();
        if (!cfg.slackEnabled) throw new Error("Slack is disabled.");
        const required: Record<string, string[]> = { list_connections: [], list_conversations: ["connectionId"], list_messages: ["connectionId", "conversationId"], search: ["q"], send_message: ["connectionId", "conversationId", "text", "idempotencyKey"], get_action: ["connectionId", "actionId"], upload_file: ["connectionId", "conversationId", "filePath", "idempotencyKey"], get_operation: ["connectionId", "operationId"] };
        if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !(key in spec.properties)) || required[spec.name]!.some((key) => !(key in args))) throw new Error("Invalid Slack tool arguments.");
        for (const [key, value] of Object.entries(args)) {
          if (key === "limit") { if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error("limit must be an integer from 1 to 100."); }
          else if (key === "threadTs" && value === null && ["send_message", "upload_file"].includes(spec.name)) {}
          else if (typeof value !== "string" || (!value.trim() && !["title", "initialComment"].includes(key)) || value.includes("\0")) throw new Error(`${key} must be a nonempty string without NUL characters.`);
        }
        const client = await runtime.getClient(), identity = await runtime.getIdentity();
        const selectedConnection = args.connectionId ? await ownSlackConnection(client, identity.id, args.connectionId, undefined, ["get_operation", "get_action"].includes(spec.name)) : undefined;
        const options = { ...(args.cursor ? { cursor: args.cursor } : {}), ...(args.limit ? { limit: args.limit } : {}) };
        let result: unknown;
        switch (spec.name) {
          case "list_connections": result = await client.slack.listConnections(identity.id); break;
          case "list_conversations": result = await client.slack.listConversations(args.connectionId, options); break;
          case "list_messages": result = await client.slack.listMessages(args.connectionId, args.conversationId, { ...options, ...(args.threadTs ? { threadTs: args.threadTs } : {}) }); break;
          case "search": result = await client.slack.searchMessages({ identityId: identity.id, q: args.q, connectionId: args.connectionId, conversationId: args.conversationId, ...options }); break;
          case "send_message": {
            const text = slackMrkdwn(args.text);
            slackText(text);
            if (!/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey)) throw new Error("Invalid Slack idempotencyKey.");
            const current = source?.slackRoute;
            const route = current && args.connectionId === current.connectionId && args.conversationId === current.conversationId && (!("threadTs" in args) || args.threadTs === current.threadTs) ? current : undefined;
            if (route && selectedConnection?.workspaceId !== route.workspaceId) throw new Error("Slack source workspace changed.");
            if (source) assertNativeSource(source, identity.id);
            const allowed = cfg.allowedRecipients;
            if (!slackAuthorAllowed(allowed, route ? source!.author : `slack:${args.connectionId}:${args.conversationId}`, route)) throw new Error("Slack conversation is not on the outbound allowlist.");
            if (route) await source!.beforeSend(_id);
            else if (source) await source.validate();
            if (!config().slackEnabled) throw new Error("Slack is disabled.");
            if (source) assertNativeSource(source, identity.id);
            const action = await client.slack.sendMessage(args.connectionId, { conversationId: args.conversationId, text, threadTs: route ? route.threadTs : args.threadTs, idempotencyKey: args.idempotencyKey });
            if (route && action.status === "sent") await source!.afterSend(_id, action.id, args.text);
            result = { ...action, ...(action.status !== "sent" ? { instruction: "Do not resend. Inspect this action with inkbox_slack_get_action." } : {}) }; break;
          }
          case "upload_file": {
            if (isSubagentSessionKey(context.sessionKey)) throw new Error("Return the file to the parent turn for source-owned Slack delivery.");
            if (source && (!source.runId || !source.uploadCalls?.has(_id) || (context.sessionId && source.nativeSessionId !== context.sessionId))) throw new Error("This upload is not owned by the original native tool run.");
            if (!/^[A-Za-z0-9._:-]{1,128}$/.test(args.idempotencyKey)) throw new Error("Invalid Slack idempotencyKey.");
            const current = source?.slackRoute;
            const route = current && args.connectionId === current.connectionId && args.conversationId === current.conversationId && (!("threadTs" in args) || args.threadTs === current.threadTs) ? current : undefined;
            if (source) assertNativeSource(source, identity.id);
            if (!slackAuthorAllowed(cfg.allowedRecipients, route ? source!.author : `slack:${args.connectionId}:${args.conversationId}`, route)) throw new Error("Slack conversation is not on the outbound allowlist.");
            const options = { filePath: args.filePath, filename: args.filename, title: args.title, initialComment: args.initialComment };
            if (route) result = await uploadSlackSourceFile(client, source!, route, options, _id, args.idempotencyKey);
            else {
              const payload = await slackFilePayload(options);
              if (source) { await source.validate(); assertNativeSource(source, identity.id); }
              if (!config().slackEnabled) throw new Error("Slack is disabled.");
              const owned = await ownSlackConnection(client, identity.id, args.connectionId);
              if (owned.workspaceId !== selectedConnection?.workspaceId) throw new Error("Slack upload workspace changed.");
              let cached: ReturnType<typeof checkedSlackUpload> | undefined;
              if (source) {
                await source.validate(); assertNativeSource(source, identity.id);
                if (source.beforeUpload) cached = await source.beforeUpload(_id, { idempotencyKey: args.idempotencyKey, connectionId: args.connectionId, conversationId: args.conversationId, workspaceId: owned.workspaceId, automatic: false, fingerprint: slackUploadFingerprint(args.connectionId, args.conversationId, args.threadTs, payload) });
                else await source.beforeSend(_id);
                assertNativeSource(source, identity.id);
              }
              let receipt = cached;
              if (!receipt) {
                let operation;
                try { operation = await client.slack.uploadFile(args.connectionId, { ...payload, conversationId: args.conversationId, threadTs: args.threadTs, idempotencyKey: args.idempotencyKey }); }
                catch (error) { await recordSlackUploadRejection(source, _id, error); throw error; }
                receipt = checkedSlackUpload(operation, args.connectionId, args.conversationId);
              }
              if (!cached) await source?.afterUpload?.(_id, receipt);
              result = receipt;
            }
            if ((result as any).status !== "succeeded") result = { ...(result as any), instruction: "The file was not confirmed delivered. Inspect inkbox_slack_get_operation; do not resend an uncertain upload." };
            break;
          }
          case "get_operation": {
            const operation = await client.slack.getOperation(args.connectionId, args.operationId);
            result = checkedSlackUpload(operation, args.connectionId);
            if (source) await source.inspectUpload?.(result as ReturnType<typeof checkedSlackUpload>);
            break;
          }
          case "get_action": result = await client.slack.getAction(args.connectionId, args.actionId); break;
        }
        return toolText(formatJson(result));
      });
    },
    };
  }, { names: [`inkbox_slack_${spec.name}`] });
}
