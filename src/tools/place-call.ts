import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";

// Outbound voice — initiates a call from the identity's phone number to the
// given E.164 recipient. When the Inkbox channel gateway is running, the tool
// reuses the plugin's live call WebSocket; callers can still override with an
// explicit URL for external bridges.
export function registerPlaceCall(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
  resolveClientWebsocketUrl?: () => string | undefined,
): void {
  api.registerTool(
    {
      name: "inkbox_place_call",
      description:
        "Place an outbound call from the configured Inkbox identity's phone number. Uses the plugin's active call WebSocket when available, or an explicit clientWebsocketUrl override. Returns the queued call's id + status + rate-limit info.",
      parameters: Type.Object({
        toNumber: Type.String({
          description: "Recipient phone number in E.164 format.",
        }),
        clientWebsocketUrl: Type.Optional(
          Type.String({
            description:
              "Optional WebSocket URL (wss://...) that Inkbox will connect to for the call stream. Omit to use the plugin's active Inkbox tunnel.",
          }),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const block = checkOutboundRecipient(params.toNumber, allowedRecipients);
          if (block) return toolError(block);

          const clientWebsocketUrl =
            params.clientWebsocketUrl ?? resolveClientWebsocketUrl?.();
          if (!clientWebsocketUrl) {
            return toolError(
              "No Inkbox call WebSocket is available. Start the inkbox channel gateway or pass clientWebsocketUrl explicitly.",
            );
          }

          const identity = await runtime.getIdentity();
          const call = await identity.placeCall({
            toNumber: params.toNumber,
            clientWebsocketUrl,
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
