import { randomUUID } from "node:crypto";

const OUTBOUND_CALL_CONTEXT_PARAM = "inkbox_call_context_id";
const OUTBOUND_CALL_CONTEXT_TTL_MS = 10 * 60 * 1000;

export type OutboundCallContextInput = {
  toNumber: string;
  purpose?: string;
  openingMessage?: string;
  context?: string;
};

export type OutboundCallContext = OutboundCallContextInput & {
  id: string;
  createdAt: number;
};

const contexts = new Map<string, OutboundCallContext>();

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function prune(now = Date.now()): void {
  for (const [id, context] of contexts) {
    if (now - context.createdAt > OUTBOUND_CALL_CONTEXT_TTL_MS) {
      contexts.delete(id);
    }
  }
}

export function registerOutboundCallContext(
  input: OutboundCallContextInput,
): OutboundCallContext | undefined {
  const purpose = nonEmptyString(input.purpose);
  const openingMessage = nonEmptyString(input.openingMessage);
  const context = nonEmptyString(input.context);
  if (!purpose && !openingMessage && !context) {
    return undefined;
  }
  prune();
  const value: OutboundCallContext = {
    id: randomUUID(),
    toNumber: input.toNumber,
    purpose,
    openingMessage,
    context,
    createdAt: Date.now(),
  };
  contexts.set(value.id, value);
  return value;
}

export function decorateCallWebsocketUrlWithContext(
  rawUrl: string,
  context: OutboundCallContext | undefined,
): string {
  if (!context) {
    return rawUrl;
  }
  try {
    const url = new URL(rawUrl);
    url.searchParams.set(OUTBOUND_CALL_CONTEXT_PARAM, context.id);
    return url.toString();
  } catch {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${separator}${OUTBOUND_CALL_CONTEXT_PARAM}=${encodeURIComponent(context.id)}`;
  }
}

export function consumeOutboundCallContextFromUrl(
  url: URL,
): OutboundCallContext | undefined {
  const id = url.searchParams.get(OUTBOUND_CALL_CONTEXT_PARAM)?.trim();
  if (!id) {
    return undefined;
  }
  prune();
  const context = contexts.get(id);
  if (context) {
    contexts.delete(id);
  }
  return context;
}
