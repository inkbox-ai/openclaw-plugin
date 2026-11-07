import type { InkboxRuntime } from "./client.js";

const phone = (value: unknown): value is string => typeof value === "string" && /^\+[1-9]\d{6,14}$/.test(value);
export function whatsappGroup(value: any): boolean {
  return value?.is_group === true || value?.isGroup === true;
}
export function validWhatsAppGroup(value: any): boolean {
  const unresolved = value?.unresolved_participant_count ?? value?.unresolvedParticipantCount;
  return whatsappGroup(value) && (value.remote_number ?? value.remoteNumber) == null &&
    Array.isArray(value.participants) && value.participants.every(phone) &&
    new Set(value.participants).size === value.participants.length &&
    Number.isSafeInteger(unresolved) && unresolved >= 0 && unresolved <= 2048 &&
    value.participants.length + unresolved <= 2048;
}
export type WhatsAppMention = { text: string | null; phone_number: string | null; is_agent: boolean };
export function whatsappMentions(message: any): WhatsAppMention[] {
  if (!Array.isArray(message?.mentions)) return [];
  return message.mentions.slice(0, 2048).filter((item: any) => item &&
    (item.text === null || typeof item.text === "string" && /^@[0-9]{1,25}$/.test(item.text)) &&
    (item.phone_number === null || phone(item.phone_number)) && typeof item.is_agent === "boolean")
    .map(({ text, phone_number, is_agent }: WhatsAppMention) => ({ text, phone_number, is_agent }));
}
export function whatsappControlText(message: any): string {
  let text = String(message?.content ?? message?.text ?? "");
  if (message?.agent_mentioned !== true) return text;
  for (const mention of whatsappMentions(message)) {
    if (!mention.is_agent || !mention.text) continue;
    const pattern = new RegExp(`^\\s*${mention.text}(?![\\p{L}\\p{N}_])[,:]?\\s*`, "u");
    text = text.replace(pattern, "");
  }
  return text;
}
/** Names are presentation only; never feed this projection into attention or controls. */
export async function renderWhatsAppMentions(runtime: InkboxRuntime, message: any, handle: string) {
  let text = String(message.content ?? message.text ?? "");
  const mentions = [];
  for (const mention of whatsappMentions(message)) {
    let name: string | undefined;
    if (mention.is_agent) name = handle.replace(/^@/, "");
    else if (mention.phone_number) {
      const contacts = await (await runtime.getClient()).contacts.lookup({ phone: mention.phone_number });
      if (contacts.length === 1) name = contacts[0]!.preferredName || [contacts[0]!.givenName, contacts[0]!.familyName].filter(Boolean).join(" ") || undefined;
    }
    const label = name || mention.phone_number || "unknown participant";
    if (mention.text) {
      const pattern = new RegExp(`(?<![\\p{L}\\p{N}_@.+/:-])${mention.text}(?![\\p{L}\\p{N}_])`, "gu");
      text = text.replace(pattern, () => `@${label}`);
    }
    mentions.push({ ...mention, ...(name ? { name } : {}) });
  }
  return { text, mentions };
}

export function validWhatsAppCompanion(m: any, message: any): boolean {
  return m?.channel === "whatsapp" && ["ordinary", "initialization", "live"].includes(m.phase) &&
    Number.isSafeInteger(m.sequence) && m.sequence > 0 && m.conversation_id === message.conversation_id &&
    typeof m.scope_id === "string" && m.scope_id.length > 0 && m.scope_id.length <= 256 &&
    (m.phase === "ordinary" ? !["activation_id", "history", "reply_context", "history_complete", "history_next_cursor"].some(key => key in m)
      : typeof m.activation_id === "string" && m.activation_id.length > 0 && m.activation_id.length <= 256) &&
    ["direct", "sponsored"].includes(message.sender_access);
}
