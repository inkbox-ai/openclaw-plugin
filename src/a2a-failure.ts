const STOPPED_STATES = new Set([
  "input_required", "auth_required", "completed", "failed", "canceled", "rejected",
]);

/** Fixed diagnostic fields only: never include the exception message or path. */
export function a2aFailureShape(stage: "dispatch" | "admission" | "terminal", error: unknown): string {
  const names = new Set(["Error", "TypeError", "RangeError", "AbortError"]);
  const name = error instanceof Error && names.has(error.name) ? error.name : "other";
  let frame = "unknown:0";
  if (error instanceof Error) {
    const header = `${error.name}: ${error.message}`;
    const stack = error.stack?.startsWith(header) ? error.stack.slice(header.length) : "";
    for (const line of stack.split("\n")) {
      if (!/^\s*at\s/.test(line)) continue;
      const host = line.match(/\/openclaw\/dist\/(?:plugin-sdk\/)?([A-Za-z0-9_.-]+\.js):(\d+):\d+/);
      const plugin = line.match(/\/src\/(?:inbound\/)?(session|a2a|a2a-registry)\.(ts|js):(\d+):\d+/);
      if (host) frame = `${host[1]}:${host[2]}`;
      else if (plugin) frame = `${plugin[1]}.${plugin[2]}:${plugin[3]}`;
      else continue;
      break;
    }
  }
  return `A2A failure shape: stage=${stage} name=${name} frame=${frame}`;
}

/** Fail a still-active task once; ambiguous reads/sends remain recoverable. */
export async function settleCaughtA2AFailure(params: {
  identity: {
    a2aTask: (id: string) => Promise<{ state: unknown }>;
    a2aReply: (id: string, reply: { intent: "fail"; text: string }) => Promise<unknown>;
  };
  taskId: string;
  signal: AbortSignal;
  replyIntentCommitted?: boolean;
  replyIntentAttempted?: boolean;
  beforeFail: () => Promise<void>;
}): Promise<"finalized" | "preserved"> {
  if (params.signal.aborted) return "preserved";
  if (params.replyIntentCommitted) return "finalized";
  if (params.replyIntentAttempted) return "preserved";
  const task = await params.identity.a2aTask(params.taskId);
  if (params.signal.aborted) return "preserved";
  const state = String(task.state);
  if (STOPPED_STATES.has(state)) return "finalized";
  if (state !== "submitted" && state !== "working") return "preserved";
  await params.beforeFail();
  if (params.signal.aborted) return "preserved";
  // Do not replay this mutation after a transport error: it may be accepted.
  await params.identity.a2aReply(params.taskId, {
    intent: "fail",
    text: "The worker could not finish this task because its execution failed.",
  });
  return "finalized";
}
