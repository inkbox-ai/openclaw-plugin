import { Type } from "typebox";
import { activeA2ATurn } from "../a2a-context.js";
import {
  findDelegationByTask,
  promoteAfterSend,
  recordBeforeSend,
} from "../a2a-delegations.js";
import type { InkboxRuntime } from "../client.js";
import { checkOutboundRecipients } from "../allowlist.js";
import { runTool, toolError, toolText } from "../errors.js";
import { formatJson } from "../format.js";

async function a2aClient(runtime: InkboxRuntime): Promise<any> {
  const identity = await runtime.getIdentity();
  const factory = (identity as any).a2aClient;
  if (typeof factory !== "function") {
    throw new Error(
      "This A2A tool requires @inkbox/sdk with identity.a2aClient() support.",
    );
  }
  return factory.call(identity);
}

export function registerA2ATools(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
): void {
  const clientNames = [
    "inkbox_a2a_call",
    "inkbox_a2a_check",
    "inkbox_a2a_reply",
  ];
  api.registerTool(
    (toolContext: { sessionKey?: string }) => [
      {
        name: "inkbox_a2a_call",
        description:
          "Send a task to an A2A 1.0 Agent Card. Keep the returned task and context ids for later checks or replies.",
        parameters: Type.Object({
          cardUrl: Type.String({ format: "uri", description: "A2A Agent Card URL." }),
          text: Type.String({ minLength: 1, description: "Task text." }),
          contextId: Type.Optional(
            Type.String({ description: "Optional context to continue." }),
          ),
          taskId: Type.Optional(
            Type.String({ description: "Optional task requesting more input." }),
          ),
          messageId: Type.Optional(
            Type.String({ description: "Stable idempotency id." }),
          ),
        }),
        async execute(_id: string, params: any) {
          return runTool(async () => {
            const block = checkOutboundRecipients(
              [params.cardUrl],
              allowedRecipients,
            );
            if (block) return toolError(block);
            const identity = await runtime.getIdentity();
            const a2a = await a2aClient(runtime);
            try {
              const target = await a2a.fetchCard(params.cardUrl);
              const messageId = params.messageId ?? crypto.randomUUID();
              const pendingKey = await recordBeforeSend({
                identityId: String((identity as any).id),
                rpcUrl: String(target.rpcUrl),
                cardUrl: params.cardUrl,
                contextId: params.contextId,
                taskId: params.taskId,
                messageId,
                sessionKey: toolContext.sessionKey,
              });
              const result = await a2a.send(target, {
                text: params.text,
                contextId: params.contextId,
                taskId: params.taskId,
                messageId,
              });
              if (result.task?.id && result.task?.contextId) {
                await promoteAfterSend(
                  pendingKey,
                  String(result.task.contextId),
                  String(result.task.id),
                );
              }
              return toolText(formatJson(result));
            } finally {
              a2a.close?.();
            }
          });
        },
      },
      {
        name: "inkbox_a2a_check",
        description:
          "Fetch an A2A task, or wait until it reaches a final or input-required state.",
        parameters: Type.Object({
          cardUrl: Type.String({ format: "uri", description: "A2A Agent Card URL." }),
          taskId: Type.String({ minLength: 1, description: "Remote task id." }),
          wait: Type.Optional(
            Type.Boolean({
              description: "Wait until the task reaches a stopped state.",
            }),
          ),
        }),
        async execute(_id: string, params: any) {
          return runTool(async () => {
            const a2a = await a2aClient(runtime);
            try {
              const target = await a2a.fetchCard(params.cardUrl);
              const task = params.wait
                ? await a2a.wait(target, params.taskId)
                : await a2a.getTask(target, params.taskId);
              return toolText(formatJson(task));
            } finally {
              a2a.close?.();
            }
          });
        },
      },
      {
        name: "inkbox_a2a_reply",
        description: "Reply to a remote A2A task that requested more input.",
        parameters: Type.Object({
          cardUrl: Type.String({ format: "uri", description: "A2A Agent Card URL." }),
          taskId: Type.String({ minLength: 1, description: "Remote task id." }),
          text: Type.String({ minLength: 1, description: "Reply text." }),
          messageId: Type.Optional(
            Type.String({ description: "Stable idempotency id." }),
          ),
        }),
        async execute(_id: string, params: any) {
          return runTool(async () => {
            const block = checkOutboundRecipients(
              [params.cardUrl],
              allowedRecipients,
            );
            if (block) return toolError(block);
            const identity = await runtime.getIdentity();
            const a2a = await a2aClient(runtime);
            try {
              const target = await a2a.fetchCard(params.cardUrl);
              const existing = await findDelegationByTask(params.taskId);
              const messageId = params.messageId ?? crypto.randomUUID();
              const pendingKey = await recordBeforeSend({
                identityId: String((identity as any).id),
                rpcUrl: String(target.rpcUrl),
                cardUrl: params.cardUrl,
                contextId: existing?.contextId,
                taskId: params.taskId,
                messageId,
                sessionKey: toolContext.sessionKey ?? existing?.sessionKey,
              });
              const result = await a2a.send(target, {
                taskId: params.taskId,
                text: params.text,
                messageId,
              });
              if (result.task?.contextId) {
                await promoteAfterSend(
                  pendingKey,
                  String(result.task.contextId),
                  params.taskId,
                );
              }
              return toolText(formatJson(result));
            } finally {
              a2a.close?.();
            }
          });
        },
      },
    ],
    { names: clientNames },
  );

  const intentNames = [
    "inkbox_a2a_complete",
    "inkbox_a2a_ask_caller",
    "inkbox_a2a_fail",
  ];
  api.registerTool(
    (toolContext: { sessionKey?: string }) =>
      intentNames.map((name) => ({
        name,
        description:
          name === "inkbox_a2a_complete"
            ? "Complete the active inbound A2A task with a final answer."
            : name === "inkbox_a2a_ask_caller"
              ? "Ask the caller for more input on the active inbound A2A task."
              : "Fail the active inbound A2A task with a reason.",
        parameters:
          name === "inkbox_a2a_fail"
            ? Type.Object({
                reason: Type.String({
                  minLength: 1,
                  description: "Failure reason.",
                }),
              })
            : Type.Object({
                text: Type.String({
                  minLength: 1,
                  description: "A2A reply text.",
                }),
              }),
        async execute(_id: string, params: any) {
          return runTool(async () => {
            const context = activeA2ATurn(toolContext.sessionKey);
            if (!context) {
              return toolError(
                "This tool is only available during an inbound A2A task",
              );
            }
            const identity = await runtime.getIdentity();
            const reply = (identity as any).a2aReply;
            if (typeof reply !== "function") {
              return toolError(
                "This A2A tool requires @inkbox/sdk with identity.a2aReply() support.",
              );
            }
            const intent =
              name === "inkbox_a2a_complete"
                ? "complete"
                : name === "inkbox_a2a_ask_caller"
                  ? "ask_caller"
                  : "fail";
            const result = await reply.call(identity, context.taskId, {
              intent,
              text: name === "inkbox_a2a_fail" ? params.reason : params.text,
            });
            context.replyIntentCommitted = true;
            return toolText(formatJson(result));
          });
        },
      })),
    { names: intentNames },
  );
}
