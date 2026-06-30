export const SMS_MAX_TEXT_CHARS = 1600;
export const IMESSAGE_MAX_TEXT_CHARS = 18995;

export function smsTextTooLongMessage(text: string): string {
  return `SMS text is ${text.length} characters; maximum is ${SMS_MAX_TEXT_CHARS}. Shorten it or split it into smaller SMS messages.`;
}

export function imessageTextTooLongMessage(text: string): string {
  return `iMessage text is ${text.length} characters; maximum is ${IMESSAGE_MAX_TEXT_CHARS}. Shorten it or split it into smaller iMessages.`;
}

export function assertSmsTextWithinLimit(text: string): void {
  if (text.length > SMS_MAX_TEXT_CHARS) {
    throw new Error(smsTextTooLongMessage(text));
  }
}

export function assertIMessageTextWithinLimit(text: string): void {
  if (text.length > IMESSAGE_MAX_TEXT_CHARS) {
    throw new Error(imessageTextTooLongMessage(text));
  }
}
