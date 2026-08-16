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
  toolIdentifiers: string[];
}

const captures = new Map<string, ActivityCapture>();
const MAX_TOOL_IDENTIFIERS = 8;
const MAX_TOOL_IDENTIFIER_CHARS = 80;

export function normalizeA2AIdentifierText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^[_.:-]+|[_.:-]+$/g, "");
}

export function normalizeA2AToolIdentifier(value: unknown): string {
  return normalizeA2AIdentifierText(value)
    .slice(0, MAX_TOOL_IDENTIFIER_CHARS)
    .replace(/[_.:-]+$/g, "");
}

export function beginA2AProgressActivityCapture(params: {
  sessionKey: string;
  promptMarker: string;
}): { snapshot(): string[]; finish(): void } {
  const capture: ActivityCapture = {
    promptMarker: params.promptMarker,
    toolIdentifiers: [],
  };
  captures.set(params.sessionKey, capture);
  return {
    snapshot: () => [...capture.toolIdentifiers],
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
  const next = normalizeA2AToolIdentifier(event.toolName);
  if (!next || capture.toolIdentifiers.at(-1) === next) return;
  capture.toolIdentifiers.push(next);
  if (capture.toolIdentifiers.length > MAX_TOOL_IDENTIFIERS) {
    capture.toolIdentifiers.shift();
  }
}
