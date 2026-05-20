import type {
  MailWebhookPayload,
  TextWebhookPayload,
  PhoneIncomingCallWebhookPayload,
} from "@inkbox/sdk";
import { inboundContactAllowed } from "../allowlist.js";

// Sync response Inkbox expects for an inbound call webhook.
export interface InboundCallDecision {
  action: "answer" | "reject";
  clientWebsocketUrl?: string;
}

// Resolve the "remote party" contact id from a webhook payload. Mail events
// carry an array of contacts with `bucket` (from/cc/to/bcc); we use the
// from-bucket for the allowlist decision. Text and call payloads have a
// singular `contact` field.
function resolveRemoteContactId(parsed: any, kind: "mail" | "text" | "call"): string | null {
  if (kind === "mail") {
    const contacts = parsed?.data?.contacts;
    if (!Array.isArray(contacts)) return null;
    const fromContact = contacts.find((c: any) => c?.bucket === "from");
    return fromContact?.id ?? null;
  }
  if (kind === "text") {
    return parsed?.data?.contact?.id ?? null;
  }
  // call: flat payload, contact at top level.
  return parsed?.contact?.id ?? null;
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
//
// When allowedContactIds is set, events whose remote contact id isn't on the
// list are dropped: mail/text become silent no-ops, calls return a reject
// decision. Events with no resolvable contact id are also dropped.
export async function dispatchInbound(
  parsed: unknown,
  handlers: InboundHandlers,
  allowedContactIds?: string[],
): Promise<DispatchResult> {
  if (
    parsed &&
    typeof parsed === "object" &&
    "event_type" in parsed &&
    typeof (parsed as { event_type: unknown }).event_type === "string"
  ) {
    const eventType = (parsed as { event_type: string }).event_type;
    if (eventType.startsWith("message.")) {
      const contactId = resolveRemoteContactId(parsed, "mail");
      if (!inboundContactAllowed(contactId, allowedContactIds)) {
        return { kind: "mail" };
      }
      await handlers.onMail?.(parsed as MailWebhookPayload);
      return { kind: "mail" };
    }
    if (eventType.startsWith("text.")) {
      const contactId = resolveRemoteContactId(parsed, "text");
      if (!inboundContactAllowed(contactId, allowedContactIds)) {
        return { kind: "text" };
      }
      await handlers.onText?.(parsed as TextWebhookPayload);
      return { kind: "text" };
    }
  }
  // Flat call payload. Check allowlist before consulting the handler so
  // disallowed callers always get a reject regardless of handler logic.
  const contactId = resolveRemoteContactId(parsed, "call");
  if (!inboundContactAllowed(contactId, allowedContactIds)) {
    return { kind: "call", callDecision: { action: "reject" } };
  }
  const decision =
    (await handlers.onCall?.(parsed as PhoneIncomingCallWebhookPayload)) ?? {
      action: "reject" as const,
    };
  return { kind: "call", callDecision: decision };
}
