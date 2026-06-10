import type {
  IMessageWebhookPayload,
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

// Resolve remote-party contact ids from a webhook payload. Mail events
// surface contacts per recipient bucket; we use the from-bucket for the
// allowlist decision. Text and call payloads have moved from singular
// `contact` to plural `contacts`, so tolerate both during rollout. Text/call
// keep the previous first-contact allowlist behavior.
function resolveRemoteContactIds(parsed: any, kind: "mail" | "text" | "imessage" | "call"): string[] {
  if (kind === "mail") {
    const contacts = parsed?.data?.contacts;
    if (!Array.isArray(contacts)) return [];
    const fromContact = contacts.find((c: any) => c?.bucket === "from");
    return typeof fromContact?.id === "string" ? [fromContact.id] : [];
  }
  if (kind === "text" || kind === "imessage") {
    const contacts = parsed?.data?.contacts;
    if (Array.isArray(contacts)) {
      const first = contacts.find((c: any) => typeof c?.id === "string");
      return first ? [first.id] : [];
    }
    const contact = parsed?.data?.contact;
    return typeof contact?.id === "string" ? [contact.id] : [];
  }
  const contacts = parsed?.contacts;
  if (Array.isArray(contacts)) {
    const first = contacts.find((c: any) => typeof c?.id === "string");
    return first ? [first.id] : [];
  }
  const contact = parsed?.contact;
  return typeof contact?.id === "string" ? [contact.id] : [];
}

function anyInboundContactAllowed(contactIds: string[], allowedContactIds?: string[]): boolean {
  if (!allowedContactIds?.length) {
    return true;
  }
  return contactIds.some((id) => inboundContactAllowed(id, allowedContactIds));
}

export interface InboundHandlers {
  // Mail events fire-and-forget. Six event_types: message.received/sent/
  // forwarded/delivered/bounced/failed. Most workflows only care about
  // message.received; the rest are telemetry.
  onMail?(event: MailWebhookPayload): Promise<void> | void;

  // Text events fire-and-forget. Five event_types: text.received/sent/
  // delivered/delivery_failed/delivery_unconfirmed.
  onText?(event: TextWebhookPayload): Promise<void> | void;

  // iMessage events fire-and-forget. imessage.received plus the outbound
  // delivery lifecycle (imessage.sent/delivered/delivery_failed); the
  // subscription is owned by the agent identity, not a phone number.
  onIMessage?(event: IMessageWebhookPayload): Promise<void> | void;

  // Inbound calls are synchronous — the HTTP response IS the routing decision.
  // Default if unspecified: reject. To answer, return clientWebsocketUrl
  // pointing at a WS endpoint that will bridge audio.
  onCall?(
    event: PhoneIncomingCallWebhookPayload,
  ): Promise<InboundCallDecision> | InboundCallDecision;
}

export interface DispatchResult {
  kind: "mail" | "text" | "imessage" | "call";
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
      const contactIds = resolveRemoteContactIds(parsed, "mail");
      if (!anyInboundContactAllowed(contactIds, allowedContactIds)) {
        return { kind: "mail" };
      }
      await handlers.onMail?.(parsed as MailWebhookPayload);
      return { kind: "mail" };
    }
    if (eventType.startsWith("text.")) {
      const contactIds = resolveRemoteContactIds(parsed, "text");
      if (!anyInboundContactAllowed(contactIds, allowedContactIds)) {
        return { kind: "text" };
      }
      await handlers.onText?.(parsed as TextWebhookPayload);
      return { kind: "text" };
    }
    if (eventType.startsWith("imessage.")) {
      const contactIds = resolveRemoteContactIds(parsed, "imessage");
      if (!anyInboundContactAllowed(contactIds, allowedContactIds)) {
        return { kind: "imessage" };
      }
      await handlers.onIMessage?.(parsed as IMessageWebhookPayload);
      return { kind: "imessage" };
    }
  }
  // Flat call payload. Check allowlist before consulting the handler so
  // disallowed callers always get a reject regardless of handler logic.
  const contactIds = resolveRemoteContactIds(parsed, "call");
  if (!anyInboundContactAllowed(contactIds, allowedContactIds)) {
    return { kind: "call", callDecision: { action: "reject" } };
  }
  const decision =
    (await handlers.onCall?.(parsed as PhoneIncomingCallWebhookPayload)) ?? {
      action: "reject" as const,
    };
  return { kind: "call", callDecision: decision };
}
