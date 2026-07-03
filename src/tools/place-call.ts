import { Type } from "typebox";
import { CallOrigin } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";
import { resolveChannelHint } from "../channel-hint.js";
import {
  decorateCallWebsocketUrlWithContext,
  registerOutboundCallContext,
  type OutboundCallContext,
} from "../outbound-call-context.js";

// Pick which line an outbound call originates from. Resolution order:
//   1. An explicit choice (from the agent) always wins.
//   2. If only one line exists, use it (dedicated number but no iMessage →
//      dedicated; iMessage enabled but no number → shared).
//   3. If BOTH exist, follow the channel the current conversation is on — an
//      iMessage turn calls over the shared iMessage line, an SMS/phone turn
//      over the dedicated number. This makes "call me" do the right thing
//      without the agent having to specify the line.
//   4. If both exist but the channel is unknown, default to the dedicated
//      number (the open line that can reach anyone).
// Returns undefined when neither line exists (nothing to call from).
export function resolveCallOrigination(
  identity: { phoneNumber?: unknown; imessageEnabled?: boolean },
  explicit: string,
  toNumber?: string,
): "dedicated_number" | "shared_imessage_number" | undefined {
  const choice = explicit.trim().toLowerCase();
  if (choice === "dedicated_number" || choice === "shared_imessage_number") {
    return choice;
  }
  const hasNumber = identity.phoneNumber != null;
  const imessageEnabled = Boolean(identity.imessageEnabled);
  if (hasNumber && imessageEnabled) {
    // Both lines available — follow the conversation's channel.
    return resolveChannelHint(toNumber) === "imessage"
      ? "shared_imessage_number"
      : "dedicated_number";
  }
  if (hasNumber) {
    return "dedicated_number";
  }
  if (imessageEnabled) {
    return "shared_imessage_number";
  }
  return undefined;
}

// Outbound voice — initiates a call to the given E.164 recipient over either
// the identity's dedicated phone number or the shared iMessage line. When the
// Inkbox channel gateway is running, the tool reuses the plugin's live call
// WebSocket; callers can still override with an explicit URL for external
// bridges.
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
        "Place an outbound voice call. Calls can go out over two lines: your own dedicated phone number, or the shared Inkbox iMessage line you are already messaging the recipient on. Match the channel you're talking on — call SMS/phone contacts from your dedicated number, and call an iMessage contact over the shared iMessage line (set `origination` accordingly). Always include purpose; it is loaded into the live call so the agent opens with context instead of a generic greeting. Returns the queued call's id + status + origination + rate-limit info.",
      parameters: Type.Object({
        toNumber: Type.String({
          description: "Recipient phone number in E.164 format.",
        }),
        purpose: Type.String({
          description:
            "Why this call is being placed. If no topic was specified, say that the user asked for a general call. This is loaded into the live call before the greeting.",
        }),
        origination: Type.Optional(
          Type.Union(
            [Type.Literal("dedicated_number"), Type.Literal("shared_imessage_number")],
            {
              description:
                'Which line to call from. Use "dedicated_number" to call from your own phone number (the same line SMS/voice conversations use). Use "shared_imessage_number" to call someone over the shared iMessage line you are already messaging them on — this only works if they are connected to you over iMessage (otherwise the call is rejected). If omitted, it is resolved automatically: the only available line, or — when both are available — the line matching the current conversation\'s channel.',
            },
          ),
        ),
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
          // Resolve the outbound line (dedicated number vs shared iMessage line).
          const origination = resolveCallOrigination(
            identity,
            typeof params.origination === "string" ? params.origination : "",
            params.toNumber,
          );
          if (!origination) {
            return toolError(
              "This identity can't place calls: it has no dedicated phone number and iMessage is not enabled. Provision a number or enable iMessage first.",
            );
          }
          let call;
          try {
            call = await identity.placeCall({
              toNumber: params.toNumber,
              origination:
                origination === "shared_imessage_number"
                  ? CallOrigin.SHARED_IMESSAGE_NUMBER
                  : CallOrigin.DEDICATED_NUMBER,
              clientWebsocketUrl: decoratedClientWebsocketUrl,
            });
          } catch (error) {
            // A shared-line call to someone who isn't connected over iMessage
            // is rejected server-side; surface a legible reason to the agent.
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("no_shared_connection")) {
              return toolError(
                'Can\'t place a shared iMessage-line call: this person isn\'t connected to you over iMessage yet. They need to message your iMessage number first. To call from your own phone number instead, set origination to "dedicated_number".',
              );
            }
            throw error;
          }
          // rateLimit is on the call response — surface it so the agent can
          // see remaining capacity before queueing more outbound calls.
          const remaining = call.rateLimit?.callsRemaining;
          return toolText(
            `Placed call id=${call.id} to=${params.toNumber} status=${call.status} origination=${origination}` +
              (remaining !== undefined ? ` callsRemaining=${remaining}` : ""),
          );
        });
      },
    },
    { optional: true },
  );
}
