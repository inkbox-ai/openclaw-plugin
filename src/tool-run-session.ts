type Context = { sessionKey?: string; sessionId?: string; runId?: string };

// Hooks may load in separate host module graphs; keep run bindings process-wide.
const registry = Symbol.for("inkbox.tool-run-sessions.v1");
const state = globalThis as typeof globalThis & { [registry]?: Map<string, { sessionKey: string; sessionId: string }> };
const runs = state[registry] ??= new Map<string, { sessionKey: string; sessionId: string }>();
const MAX_RUNS = 1024;

/** Record the routed session key the host reports when a run starts. */
export function bindToolRunSession(context: Context): void {
  if (!context.runId || !context.sessionKey || !context.sessionId?.trim()) return;
  runs.delete(context.runId);
  runs.set(context.runId, { sessionKey: context.sessionKey, sessionId: context.sessionId });
  if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
}

// Hosts can report deferred (Tool Search) child tools under the run's policy
// session key. Restore the routed key only for the exact bound run and session.
export function routedToolContext<T extends Context>(context: T): T {
  const run = context.runId ? runs.get(context.runId) : undefined;
  if (!run || run.sessionKey === context.sessionKey || run.sessionId !== context.sessionId) return context;
  return { ...context, sessionKey: run.sessionKey };
}

export function releaseToolRunSession(context: Context): void {
  if (context.runId && runs.get(context.runId)?.sessionKey === context.sessionKey) runs.delete(context.runId);
}
