export interface ActiveA2ATurn {
  taskId: string;
  messageId: string;
  contextId: string;
  replyIntentCommitted: boolean;
  beforeReplyIntent?: () => Promise<void>;
}

const active = new Map<string, ActiveA2ATurn>();

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
