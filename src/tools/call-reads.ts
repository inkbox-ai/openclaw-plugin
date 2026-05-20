import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

// Read-side for the voice channel. Both tools are required since calls are
// often the slowest channel to keep up with and the agent will want to
// review missed-call history + transcripts.
export function registerCallReads(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_list_calls",
    description:
      "List calls (inbound + outbound) for the configured Inkbox identity's phone number. Most recent first.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 200,
          default: 25,
          description: "Maximum number of calls to return.",
        }),
      ),
      offset: Type.Optional(
        Type.Integer({ minimum: 0, default: 0, description: "Pagination offset." }),
      ),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const calls = await identity.listCalls({
          limit: params.limit ?? 25,
          offset: params.offset ?? 0,
        });
        return toolText(
          formatWithHeader(`Returned ${calls.length} call(s).`, calls),
        );
      });
    },
  });

  api.registerTool({
    name: "inkbox_list_call_transcripts",
    description:
      "Fetch transcript segments for a single call by call UUID. Segments are ordered by seq; each segment includes the party (local/remote) and text.",
    parameters: Type.Object({
      callId: Type.String({ description: "UUID of the call." }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const segments = await identity.listTranscripts(params.callId);
        return toolText(
          formatWithHeader(
            `Returned ${segments.length} transcript segment(s) for call ${params.callId}.`,
            segments,
          ),
        );
      });
    },
  });
}
