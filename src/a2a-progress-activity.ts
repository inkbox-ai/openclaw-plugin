interface HookContext {
  sessionKey?: string;
  runId?: string;
}

interface ToolHookEvent {
  toolName?: string;
  runId?: string;
}

interface ActivityCapture {
  promptMarker: string;
  runId?: string;
  activities: string[];
}

const captures = new Map<string, ActivityCapture>();

function category(toolName: string): string {
  const name = toolName.toLowerCase();
  if (/search|find|lookup|list|get|read|fetch|browse/.test(name)) return "researching information";
  if (/test|check|verify|lint|build/.test(name)) return "running verification checks";
  if (/write|edit|patch|update|create/.test(name)) return "working on the requested changes";
  if (/shell|exec|command|terminal/.test(name)) return "running implementation checks";
  return "using the tools needed for the task";
}

export function beginA2AProgressActivityCapture(params: {
  sessionKey: string;
  promptMarker: string;
}): { snapshot(): string[]; finish(): void } {
  const capture: ActivityCapture = {
    promptMarker: params.promptMarker,
    activities: [],
  };
  captures.set(params.sessionKey, capture);
  return {
    snapshot: () => [...capture.activities],
    finish: () => {
      if (captures.get(params.sessionKey) === capture) captures.delete(params.sessionKey);
    },
  };
}

export function bindA2AProgressActivityToRun(
  event: { prompt?: string },
  context: HookContext,
): void {
  const capture = context.sessionKey ? captures.get(context.sessionKey) : undefined;
  if (!capture || capture.runId || !context.runId) return;
  if (typeof event.prompt !== "string" || !event.prompt.includes(capture.promptMarker)) return;
  capture.runId = context.runId;
}

export function recordA2AProgressToolActivity(
  event: ToolHookEvent,
  context: HookContext,
): void {
  const capture = context.sessionKey ? captures.get(context.sessionKey) : undefined;
  const runId = event.runId ?? context.runId;
  if (!capture?.runId || capture.runId !== runId || !event.toolName) return;
  const next = category(event.toolName);
  if (capture.activities.at(-1) !== next) capture.activities.push(next);
  if (capture.activities.length > 8) capture.activities.shift();
}
