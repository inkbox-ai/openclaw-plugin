import type { Inkbox, WebhookSubscription } from "@inkbox/sdk";
import { InkboxAPIError } from "@inkbox/sdk";
import type { PluginLogger } from "../client.js";

// Full event sets the plugin subscribes to. We subscribe broadly and
// filter in dispatch — receive events are load-bearing, the rest are
// telemetry that downstream features may opt into.
export const MAIL_EVENT_TYPES: readonly string[] = [
  "message.received",
  "message.sent",
  "message.forwarded",
  "message.delivered",
  "message.bounced",
  "message.failed",
];

export const TEXT_EVENT_TYPES: readonly string[] = [
  "text.received",
  "text.sent",
  "text.delivered",
  "text.delivery_failed",
  "text.delivery_unconfirmed",
];

// iMessage: inbound plus the outbound delivery lifecycle — same split as
// text. Tapback reactions (`imessage.reaction_received`) are deliberately
// not subscribed: waking the agent for every thumbs-up isn't worth a turn,
// and live reactions are visible on message reads anyway.
export const IMESSAGE_EVENT_TYPES: readonly string[] = [
  "imessage.received",
  "imessage.sent",
  "imessage.delivered",
  "imessage.delivery_failed",
];

export interface DesiredSubscriptionSet {
  mailboxId?: string;
  phoneNumberId?: string;
  // iMessage rides shared Inkbox-managed numbers, so imessage.* subscriptions
  // are owned by the agent identity rather than a phone number.
  agentIdentityId?: string;
  url: string;
  eventTypes: readonly string[];
}

function sameEventTypes(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}

function isDuplicateUrl409(err: unknown): boolean {
  if (!(err instanceof InkboxAPIError) || err.statusCode !== 409) return false;
  const detail =
    typeof err.detail === "string"
      ? err.detail
      : typeof (err.detail as { detail?: unknown })?.detail === "string"
        ? ((err.detail as { detail: string }).detail)
        : JSON.stringify(err.detail);
  return /active subscription/i.test(detail) && /url/i.test(detail);
}

function isCap409(err: unknown): boolean {
  if (!(err instanceof InkboxAPIError) || err.statusCode !== 409) return false;
  const detail =
    typeof err.detail === "string"
      ? err.detail
      : typeof (err.detail as { detail?: unknown })?.detail === "string"
        ? ((err.detail as { detail: string }).detail)
        : JSON.stringify(err.detail);
  return /max\s*\d+|maximum/i.test(detail) && /subscription/i.test(detail);
}

// Reconcile a desired subscription against the live set for one owner.
// Returns the resulting row, or null if reconciliation aborted (e.g.
// cap exceeded). List-then-create races on duplicate URL are recovered
// by re-listing and PATCHing.
export async function reconcileWebhookSubscription(
  inkbox: Inkbox,
  desired: DesiredSubscriptionSet,
  logger?: PluginLogger,
): Promise<WebhookSubscription | null> {
  const hasMailbox = desired.mailboxId !== undefined;
  const hasPhone = desired.phoneNumberId !== undefined;
  const hasIdentity = desired.agentIdentityId !== undefined;
  if (Number(hasMailbox) + Number(hasPhone) + Number(hasIdentity) !== 1) {
    throw new Error(
      "reconcileWebhookSubscription requires exactly one of mailboxId, phoneNumberId, or agentIdentityId",
    );
  }

  const ownerFilter = hasMailbox
    ? { mailboxId: desired.mailboxId! }
    : hasPhone
      ? { phoneNumberId: desired.phoneNumberId! }
      : { agentIdentityId: desired.agentIdentityId! };

  const existing = await inkbox.webhooks.subscriptions.list(ownerFilter);
  const match = existing.find((sub) => sub.url === desired.url);

  if (match) {
    if (sameEventTypes(match.eventTypes, desired.eventTypes)) {
      return match;
    }
    return inkbox.webhooks.subscriptions.update(match.id, {
      eventTypes: [...desired.eventTypes],
    });
  }

  try {
    return await inkbox.webhooks.subscriptions.create({
      ...ownerFilter,
      url: desired.url,
      eventTypes: [...desired.eventTypes],
    });
  } catch (err) {
    if (isDuplicateUrl409(err)) {
      // Concurrent activation created the row first; re-list and treat
      // as the create-result (PATCH event-types if they drift).
      const refreshed = await inkbox.webhooks.subscriptions.list(ownerFilter);
      const racedMatch = refreshed.find((sub) => sub.url === desired.url);
      if (racedMatch) {
        if (sameEventTypes(racedMatch.eventTypes, desired.eventTypes)) {
          return racedMatch;
        }
        return inkbox.webhooks.subscriptions.update(racedMatch.id, {
          eventTypes: [...desired.eventTypes],
        });
      }
      logger?.warn?.(
        `Inkbox webhook subscription create returned a duplicate-URL conflict for ${desired.url} but no matching subscription was found when re-checking. Inbound delivery to that URL may be missing.`,
      );
      return null;
    }
    if (isCap409(err)) {
      logger?.warn?.(
        `Inkbox webhook subscription cap reached for this owner: ${err instanceof Error ? err.message : String(err)}. Delete an unused subscription in the Inkbox Console before retrying.`,
      );
      return null;
    }
    throw err;
  }
}
