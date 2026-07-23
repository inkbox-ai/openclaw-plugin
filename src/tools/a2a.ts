import { Type } from "typebox";
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
  api.registerTool({
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
        const a2a = await a2aClient(runtime);
        try {
          const target = await a2a.fetchCard(params.cardUrl);
          const result = await a2a.send(target, {
            text: params.text,
            contextId: params.contextId,
            taskId: params.taskId,
            messageId: params.messageId,
          });
          return toolText(formatJson(result));
        } finally {
          a2a.close?.();
        }
      });
    },
  });

  api.registerTool({
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
  });

  api.registerTool({
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
        const a2a = await a2aClient(runtime);
        try {
          const target = await a2a.fetchCard(params.cardUrl);
          const result = await a2a.send(target, {
            taskId: params.taskId,
            text: params.text,
            messageId: params.messageId,
          });
          return toolText(formatJson(result));
        } finally {
          a2a.close?.();
        }
      });
    },
  });
}
