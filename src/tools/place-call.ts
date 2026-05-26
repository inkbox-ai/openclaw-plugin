import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";
import {
  decorateCallWebsocketUrlWithContext,
  registerOutboundCallContext,
  type OutboundCallContext,
} from "../outbound-call-context.js";

// Outbound voice — initiates a call from the identity's phone number to the
// given E.164 recipient. When the Inkbox channel gateway is running, the tool
// reuses the plugin's live call WebSocket; callers can still override with an
// explicit URL for external bridges.
export function registerPlaceCall(
  api: any,
  runtime: InkboxRuntime,
  allowedRecipients?: string[],
  resolveClientWebsocketUrl?: (context?: OutboundCallContext) => string | undefined,
): void {
  api.registerTool(
    {
      name: "inkbox_place_call",
      description:
        "Place an outbound call from the configured Inkbox identity's phone number. Always include purpose when the user gave a topic/reason; it is loaded into the live call so the agent opens with context instead of asking a generic greeting. Uses the plugin's active call WebSocket when available, or an explicit clientWebsocketUrl override. Returns the queued call's id + status + rate-limit info.",
      parameters: Type.Object({
        toNumber: Type.String({
          description: "Recipient phone number in E.164 format.",
        }),
        purpose: Type.String({
          description:
            "Why this call is being placed. If no topic was specified, say that the user asked for a general call. This is loaded into the live call before the greeting.",
        }),
        openingMessage: Type.Optional(
          Type.String({
            description:
              "Optional exact or near-exact first thing to say when the call connects. Use this when the user specified what the call is about.",
          }),
        ),
        context: Type.Optional(
          Type.String({
            description:
              "Optional relevant background to load into the call session. Include concise facts the voice agent may need after the opening.",
          }),
        ),
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

          const purpose =
            typeof params.purpose === "string" ? params.purpose.trim() : "";
          if (!purpose) {
            return toolError(
              "inkbox_place_call requires a purpose so the live call can start with the right context. If the user did not give a topic, set purpose to 'The user asked for a general call.'",
            );
          }
          const openingMessage =
            typeof params.openingMessage === "string"
              ? params.openingMessage.trim() || undefined
              : undefined;
          const context =
            typeof params.context === "string" ? params.context.trim() || undefined : undefined;
          const callContext = registerOutboundCallContext({
            toNumber: params.toNumber,
            purpose,
            openingMessage,
            context,
          });
          const clientWebsocketUrl =
            params.clientWebsocketUrl ?? resolveClientWebsocketUrl?.(callContext);
          if (!clientWebsocketUrl) {
            return toolError(
              "No Inkbox call WebSocket is available. Start the inkbox channel gateway or pass clientWebsocketUrl explicitly.",
            );
          }
          const decoratedClientWebsocketUrl = decorateCallWebsocketUrlWithContext(
            clientWebsocketUrl,
            callContext,
          );

          const identity = await runtime.getIdentity();
          const call = await identity.placeCall({
            toNumber: params.toNumber,
            clientWebsocketUrl: decoratedClientWebsocketUrl,
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
