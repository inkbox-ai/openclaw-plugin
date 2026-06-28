export const IMESSAGE_MAX_TEXT_CHARS = 18995;

export function imessageTextTooLongMessage(text: string): string {
  return `iMessage text is ${text.length} characters; maximum is ${IMESSAGE_MAX_TEXT_CHARS}. Shorten it or split it into smaller iMessages.`;
}

export function assertIMessageTextWithinLimit(text: string): void {
  if (text.length > IMESSAGE_MAX_TEXT_CHARS) {
    throw new Error(imessageTextTooLongMessage(text));
  }
}
