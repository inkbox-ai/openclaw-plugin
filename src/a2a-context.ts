export interface ActiveA2ATurn {
  taskId: string;
  messageId: string;
  contextId: string;
  replyIntentCommitted: boolean;
  beforeReplyIntent?: () => Promise<void>;
}

// Prepared tools must see the channel worker's active task and reply-intent fence.
const activeRegistry = Symbol.for("inkbox.active-a2a-turns.v1");
const processState = globalThis as typeof globalThis & { [activeRegistry]?: Map<string, ActiveA2ATurn> };
const active = processState[activeRegistry] ??= new Map<string, ActiveA2ATurn>();

export function setActiveA2ATurn(
  sessionKey: string,
  context: ActiveA2ATurn,
): void {
  active.set(sessionKey, context);
}

export function clearActiveA2ATurn(
  sessionKey: string,
  context: ActiveA2ATurn,
): void {
  if (active.get(sessionKey) === context) active.delete(sessionKey);
}

export function activeA2ATurn(
  sessionKey?: string,
): ActiveA2ATurn | undefined {
  return sessionKey ? active.get(sessionKey) : undefined;
}
