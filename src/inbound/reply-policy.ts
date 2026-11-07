import { whatsappControlText, whatsappMentions } from "../whatsapp-groups.js";
import type { InkboxPluginConfig } from "../client.js";

export function mentionsAgent(text: string, handle?: string): boolean {
  const aliases = ["agent", (handle ?? "").replace(/^@/, "")].filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const content = text.replace(/(?:https?:\/\/|www\.)\S+/gi, " ");
  return new RegExp(`(?<![\\p{L}\\p{N}_@.+-])@(?:${aliases.join("|")})(?![\\p{L}\\p{N}_-])(?!\\.[\\p{L}\\p{N}_])`, "iu").test(content);
}

export function normalizeEmail(value: string): string {
  return (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
}

export function sameAuthor(channel: string, left: string, right: string): boolean {
  return Boolean(left && right) && (channel === "mail" ? normalizeEmail(left) === normalizeEmail(right) : left === right);
}

export function controlText(text: string, handle?: string): string {
  const [first, ...rest] = text.trim().split(/\s+/);
  return ["@agent", `@${(handle ?? "").replace(/^@/, "").toLowerCase()}`].includes(first?.toLowerCase().replace(/[,:]$/, ""))
    ? rest.join(" ") : text.trim();
}

/** Native numeric tokens are not typed aliases, even when the configured handle is numeric. */
export function whatsappCommandText(message: any, handle?: string): string {
  const raw = whatsappControlText(message);
  const first = raw.trim().split(/\s+/)[0]?.replace(/[,:]$/, "");
  if (whatsappMentions(message).some(mention => mention.text === first)) return raw.trim();
  return controlText(raw, handle);
}

export function isLocalControl(text: string): boolean {
  return /^\/(?:stop|abort|clear|new|reset|resume|status|help)(?:\s|$)/i.test(text.trim());
}

export function isCompanionControl(text: string): boolean {
  return /^\/(?:clear|new|stop|cancel|resume|status|usage|health)$/i.test(text.trim());
}

export function whatsappMentioned(message: any, handle?: string): boolean {
  if (message.agent_mentioned === true) return true;
  let literal = String(message.content ?? message.text ?? "");
  for (const mention of whatsappMentions(message)) {
    if (mention.text) literal = literal.replace(new RegExp(`(?<![\\p{L}\\p{N}_@.+-])${mention.text}(?![\\p{L}\\p{N}_-])(?!\\.[\\p{L}\\p{N}_])`, "gu"), "native_mention");
  }
  return mentionsAgent(literal, handle);
}

export function companionWakes(config: Partial<InkboxPluginConfig>, message: any, channel: string, mailbox?: string): boolean {
  if (message._ordinaryAddressed === true) return true;
  if (config.companionResponseMode !== "relaxed" && message.sender_access !== "direct") return false;
  if (config.groupReplyMode !== "mention") return true;
  if (channel === "whatsapp") return whatsappMentioned(message, config.identity);
  if (channel === "slack") return message.mentioned === true || message._slackDirect === true;
  const raw = ["imessage", "whatsapp"].includes(channel) ? message.content ?? message.text : channel === "phone" ? message.text ?? message.body : message.body;
  if (mentionsAgent(String(raw ?? ""), config.identity)) return true;
  return channel === "mail" && Boolean(mailbox) && Array.isArray(message.to_addresses) &&
    message.to_addresses.some((value: unknown) => typeof value === "string" && normalizeEmail(value) === normalizeEmail(mailbox!));
}
