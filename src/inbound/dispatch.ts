import type {
  MailWebhookPayload,
  TextWebhookPayload,
  PhoneIncomingCallWebhookPayload,
} from "@inkbox/sdk";

// Sync response Inkbox expects for an inbound call webhook.
export interface InboundCallDecision {
  action: "answer" | "reject";
  clientWebsocketUrl?: string;
}

export interface InboundHandlers {
  // Mail events fire-and-forget. Six event_types: message.received/sent/
  // forwarded/delivered/bounced/failed. Most workflows only care about
  // message.received; the rest are telemetry.
  onMail?(event: MailWebhookPayload): Promise<void> | void;

  // Text events fire-and-forget. Five event_types: text.received/sent/
  // delivered/delivery_failed/delivery_unconfirmed.
  onText?(event: TextWebhookPayload): Promise<void> | void;

  // Inbound calls are synchronous — the HTTP response IS the routing decision.
  // Default if unspecified: reject. To answer, return clientWebsocketUrl
  // pointing at a WS endpoint that will bridge audio.
  onCall?(
    event: PhoneIncomingCallWebhookPayload,
  ): Promise<InboundCallDecision> | InboundCallDecision;
}

export interface DispatchResult {
  kind: "mail" | "text" | "call";
  // Only populated for kind="call". The handler builds the response body
  // from this.
  callDecision?: InboundCallDecision;
}

// Discriminate a parsed Inkbox webhook payload and route to the matching
// handler. Mail and text payloads share an envelope shape with `event_type`
// + `data`. Inbound calls are flat — no envelope — so the absence of
// event_type signals call.
export async function dispatchInbound(
  parsed: unknown,
  handlers: InboundHandlers,
): Promise<DispatchResult> {
  if (
    parsed &&
    typeof parsed === "object" &&
    "event_type" in parsed &&
    typeof (parsed as { event_type: unknown }).event_type === "string"
  ) {
    const eventType = (parsed as { event_type: string }).event_type;
    if (eventType.startsWith("message.")) {
      await handlers.onMail?.(parsed as MailWebhookPayload);
      return { kind: "mail" };
    }
    if (eventType.startsWith("text.")) {
      await handlers.onText?.(parsed as TextWebhookPayload);
      return { kind: "text" };
    }
  }
  // Flat call payload. Default to reject if no handler is wired.
  const decision =
    (await handlers.onCall?.(parsed as PhoneIncomingCallWebhookPayload)) ?? {
      action: "reject" as const,
    };
  return { kind: "call", callDecision: decision };
}
