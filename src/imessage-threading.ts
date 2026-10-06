import type { AgentIdentity } from "@inkbox/sdk";

export function hasNativeIMessageCapability(identity: unknown): boolean {
  const value = identity as Partial<AgentIdentity> | null;
  return Boolean(value && ["sendIMessage", "getIMessage", "getIMessageThread", "getIMessageConversationThread"].every((name) => typeof (value as any)[name] === "function"));
}

/** Old APIs may ignore unknown send fields. Prove native support before sending. */
export async function verifyNativeIMessageTarget(identity: AgentIdentity, conversationId: string, messageId: string): Promise<void> {
  if (!hasNativeIMessageCapability(identity)) throw new Error("Native iMessage reply APIs are unavailable; update the plugin or disable threaded replies.");
  const source = await identity.getIMessage(messageId);
  if (source.id !== messageId || source.conversationId !== conversationId) throw new Error("The iMessage reply source does not belong to the current conversation.");
  const page = await identity.getIMessageThread(messageId, { limit: 1 });
  if (page.conversationId !== conversationId) throw new Error("Native iMessage reply support could not be verified for this conversation.");
}
