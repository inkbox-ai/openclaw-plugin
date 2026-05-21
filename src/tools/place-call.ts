import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";

// Outbound voice — initiates a call from the identity's phone number to the
// given E.164 recipient. The caller is responsible for hosting the WebSocket
// endpoint that receives the call's audio stream. An in-plugin audio bridge
// (so the agent can both listen and speak via OpenClaw's realtime surface)
// is on the Phase 2c roadmap.
export function registerPlaceCall(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
): void {
  api.registerTool(
    {
      name: "inkbox_place_call",
      description:
        "Place an outbound call from the configured Inkbox identity's phone number. The caller must provide a clientWebsocketUrl that will receive the call audio stream. Returns the queued call's id + status + rate-limit info.",
      parameters: Type.Object({
        toNumber: Type.String({
          description: "Recipient phone number in E.164 format.",
        }),
        clientWebsocketUrl: Type.String({
          description:
            "WebSocket URL (wss://...) that Inkbox will connect to for the call's audio stream. The caller hosts this endpoint.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const block = checkOutboundRecipient(params.toNumber, allowedRecipients);
          if (block) return toolError(block);

          const identity = await runtime.getIdentity();
          const call = await identity.placeCall({
            toNumber: params.toNumber,
            clientWebsocketUrl: params.clientWebsocketUrl,
          });
          // rateLimit is on the call response — surface it so the agent can
          // see remaining capacity before queueing more outbound calls.
          const remaining = call.rateLimit?.callsRemaining;
          return toolText(
            `Placed call id=${call.id} to=${params.toNumber} status=${call.status}` +
              (remaining !== undefined ? ` callsRemaining=${remaining}` : ""),
          );
        });
      },
    },
    { optional: true },
  );
}
