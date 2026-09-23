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
  return ["@agent", `@${(handle ?? "").replace(/^@/, "")}`].includes(first?.toLowerCase().replace(/[,:]$/, ""))
    ? rest.join(" ") : text.trim();
}

export function isLocalControl(text: string): boolean {
  return /^\/(?:stop|abort|clear|new|reset|resume|status|help)(?:\s|$)/i.test(text.trim());
}

export function companionWakes(config: Partial<InkboxPluginConfig>, message: any, channel: string, mailbox?: string): boolean {
  if (config.companionResponseMode !== "relaxed" && message.sender_access !== "direct") return false;
  if (config.groupReplyMode !== "mention") return true;
  const raw = channel === "imessage" ? message.content ?? message.text : channel === "phone" ? message.text ?? message.body : message.body;
  if (mentionsAgent(String(raw ?? ""), config.identity)) return true;
  return channel === "mail" && Boolean(mailbox) && Array.isArray(message.to_addresses) &&
    message.to_addresses.some((value: unknown) => typeof value === "string" && normalizeEmail(value) === normalizeEmail(mailbox!));
}
