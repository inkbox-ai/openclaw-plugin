import { Type } from "typebox";
import { CallMode, CallOrigin, VoicemailDetection } from "@inkbox/sdk";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText, toolError } from "../errors.js";
import { checkOutboundRecipient } from "../allowlist.js";
import { resolveChannelHint } from "../channel-hint.js";
import {
  decorateCallWebsocketUrlWithContext,
  registerOutboundCallContext,
  type OutboundCallContext,
} from "../outbound-call-context.js";
import {
  resolveVoicemailDetection,
  type PhoneVoiceStack,
} from "../voice-stack.js";

interface CallPolicy {
  voiceStack?: PhoneVoiceStack;
  voicemailDetection?: "enabled" | "disabled";
}

export function buildVoiceAiReason(params: {
  purpose: string;
  openingMessage?: string;
  context?: string;
}): string {
  const reason = [
    ["Purpose", params.purpose],
    ["Opening message", params.openingMessage],
    ["Context", params.context],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[1]?.trim()))
    .map(([label, value]) => `${label}: ${value.trim()}`)
    .join("\n");
  return reason.length <= 2_000 ? reason : `${reason.slice(0, 1_999).trimEnd()}…`;
}

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
  resolveCallPolicy: () => CallPolicy = () => ({}),
): void {
  const registeredPolicy = resolveCallPolicy();
  const hostedAtRegistration = registeredPolicy.voiceStack === "inkbox_voice_ai";
  const callProperties: Record<string, any> = {
    toNumber: Type.String({
      description: "Recipient phone number in E.164 format.",
    }),
    purpose: Type.String({
      description: hostedAtRegistration
        ? "Why this call is being placed; becomes Inkbox Voice AI's task brief."
        : "Why this call is being placed; loaded before the live greeting.",
    }),
    origination: Type.Optional(
      Type.Union(
        [Type.Literal("dedicated_number"), Type.Literal("shared_imessage_number")],
        {
          description:
            'Which line to call from. Use "dedicated_number" for the identity phone number and "shared_imessage_number" only for an iMessage-connected recipient. If omitted, the plugin follows the current channel and available lines.',
        },
      ),
    ),
    openingMessage: Type.Optional(
      Type.String({
        description: hostedAtRegistration
          ? "Optional opening guidance included in the Voice AI task brief."
          : "Optional first thing to say when the call connects.",
      }),
    ),
    context: Type.Optional(
      Type.String({
        description: hostedAtRegistration
          ? "Optional concise background included in the Voice AI task brief."
          : "Optional relevant background loaded into the local call session.",
      }),
    ),
  };
  if (!hostedAtRegistration) {
    callProperties.clientWebsocketUrl = Type.Optional(
      Type.String({
        description:
          "Optional WebSocket URL (wss://...) for call media. Omit to use the active Inkbox tunnel.",
      }),
    );
  }
  api.registerTool(
    {
      name: "inkbox_place_call",
      description: hostedAtRegistration
        ? "Ask Inkbox Voice AI to place an outbound call and complete the stated task. OpenClaw is notified after the call ends."
        : "Place an outbound voice call through the configured OpenClaw phone call voice stack.",
      parameters: Type.Object(callProperties),
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
          const policy = resolveCallPolicy();
          if (policy.voiceStack !== registeredPolicy.voiceStack) {
            return toolError(
              "The phone call voice stack changed after tools were registered. Restart the OpenClaw gateway before placing a call.",
            );
          }
          const hosted = policy.voiceStack === "inkbox_voice_ai";
          let decoratedClientWebsocketUrl: string | undefined;
          if (!hosted) {
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
                "No Inkbox call WebSocket is available. Start the Inkbox channel gateway or pass clientWebsocketUrl explicitly.",
              );
            }
            decoratedClientWebsocketUrl = decorateCallWebsocketUrlWithContext(
              clientWebsocketUrl,
              callContext,
            );
          }

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
              mode: hosted ? CallMode.HOSTED_AGENT : CallMode.CLIENT_WEBSOCKET,
              ...(hosted
                ? { reason: buildVoiceAiReason({ purpose, openingMessage, context }) }
                : { clientWebsocketUrl: decoratedClientWebsocketUrl }),
              voicemailDetection:
                resolveVoicemailDetection(policy) === "disabled"
                  ? VoicemailDetection.DISABLED
                  : VoicemailDetection.ENABLED,
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
            `Placed call id=${call.id} to=${params.toNumber} status=${call.status} origination=${origination} mode=${hosted ? "inkbox_voice_ai" : "client_websocket"}` +
              (remaining !== undefined ? ` callsRemaining=${remaining}` : ""),
          );
        });
      },
    },
    { optional: true },
  );
}
