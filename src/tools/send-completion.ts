import { Type } from "typebox";
import { toolText, type ToolTextResult } from "../errors.js";

export const silentSendCompletionParameter = Type.Optional(Type.Boolean({
  description:
    "Complete this turn without another reply after the send succeeds. Set true only when this is the final requested action and no acknowledgment is wanted. Leave false when more work or a reply remains.",
}));

/** Only call after the outbound API accepted the send. Failures never terminate. */
export function sentToolText(
  text: string,
  completeSilently: unknown,
  details?: Record<string, unknown>,
): ToolTextResult {
  const result = toolText(text, details);
  return completeSilently === true ? {
    ...result,
    terminate: true,
    details: {
      ...result.details,
      inkboxSendCompletion: { accepted: true, completeSilently: true },
    },
  } : result;
}
