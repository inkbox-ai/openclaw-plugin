import { InkboxAPIError } from "@inkbox/sdk";

// Shape OpenClaw expects from tool execute() — content blocks plus an isError
// flag for failure cases. Matches the MCP-style result envelope.
export interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export function toolText(text: string): ToolTextResult {
  return { content: [{ type: "text", text }] };
}

export function toolError(text: string): ToolTextResult {
  return { isError: true, content: [{ type: "text", text }] };
}

// Translate an Inkbox SDK error into a tool-result error block with the most
// useful framing for the calling agent. Specific 403 detail strings are
// hoisted to plain-language guidance so the model doesn't have to interpret
// raw API error codes.
export function mapInkboxError(err: unknown): ToolTextResult {
  if (err instanceof InkboxAPIError) {
    const detail =
      typeof err.detail === "string" ? err.detail : JSON.stringify(err.detail);
    if (err.statusCode === 403) {
      if (detail.includes("sender_sms_pending")) {
        return toolError(
          "Your Inkbox phone number is still propagating to carriers (~10–15 min after provisioning). Try again shortly.",
        );
      }
      if (detail.includes("recipient_not_opted_in")) {
        return toolError(
          "Recipient has not opted in to SMS. Ask them to text START to your Inkbox number before retrying.",
        );
      }
      if (detail.includes("recipient_opted_out")) {
        return toolError(
          "Recipient has opted out of SMS (texted STOP). They must text START again to opt back in.",
        );
      }
      return toolError(`Permission denied (403): ${detail}`);
    }
    if (err.statusCode === 404) {
      return toolError(`Not found (404): ${detail}`);
    }
    if (err.statusCode === 409) {
      return toolError(`Conflict (409): ${detail}`);
    }
    if (err.statusCode === 422) {
      return toolError(`Validation error (422): ${detail}`);
    }
    return toolError(`Inkbox API error (${err.statusCode}): ${detail}`);
  }
  if (err instanceof Error) {
    return toolError(`Inkbox plugin error: ${err.message}`);
  }
  return toolError(`Inkbox plugin error: ${String(err)}`);
}

// Wrap a tool execute body so all thrown errors land as ToolTextResult errors
// instead of propagating up to OpenClaw's generic handler.
export async function runTool(
  fn: () => Promise<ToolTextResult>,
): Promise<ToolTextResult> {
  try {
    return await fn();
  } catch (err) {
    return mapInkboxError(err);
  }
}
