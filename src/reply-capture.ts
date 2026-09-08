import { isInkboxSilentReply } from "./silent-reply.js";

/** Capture an auxiliary agent answer without claiming delivery to a conversation. */
export function createInkboxTextReplyCapture() {
  const texts: string[] = [];
  let sawError = false;
  return {
    transformReplyPayload(payload: { text?: string; isError?: boolean }): null {
      if (payload.isError) sawError = true;
      const text = typeof payload.text === "string" ? payload.text.trim() : "";
      if (text && !payload.isError && !isInkboxSilentReply(text)) texts.push(text);
      // The host classifies this as intentional channel transformation, so a
      // captured answer does not cause a second "nothing delivered" fallback.
      return null;
    },
    hasError(): boolean { return sawError; },
    lastText(): string { return texts.at(-1) ?? ""; },
  };
}
