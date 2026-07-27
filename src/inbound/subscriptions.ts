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
// text. Tapback reactions (`imessage.reaction_received`) are subscribed and
// dispatched as a turn carrying the reaction + a response policy: the agent
// decides whether to reply or return [SILENT] (a "?" tapback usually
// warrants a reply, a "love" usually does not).
export const IMESSAGE_EVENT_TYPES: readonly string[] = [
  "imessage.received",
  "imessage.sent",
  "imessage.delivered",
  "imessage.delivery_failed",
  "imessage.reaction_received",
];
export const A2A_EVENT_TYPES: readonly string[] = [
  "a2a.task.created",
  "a2a.task.message",
  "a2a.task.canceled",
  "a2a.sent_task.updated",
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

function urlPathname(url: string): string | null {
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function eventFamilies(eventTypes: readonly string[]): Set<string> {
  return new Set(eventTypes.map((eventType) => eventType.split(".", 1)[0]));
}

// A same-owner row is one of OUR stale rows when it points somewhere else
// but at this plugin's webhook route (`/inkbox[/account]/webhook`). The
// pathname is the plugin's fingerprint: the base host changes across boots
// (tunnel vs publicUrl, or a new tunnel host), the route does not. Rows on
// other paths belong to other consumers and are never touched.
function isStalePluginSubscription(sub: WebhookSubscription, desired: DesiredSubscriptionSet): boolean {
  if (sub.url === desired.url) return false;
  const desiredPath = urlPathname(desired.url);
  if (!desiredPath) return false;
  if (urlPathname(sub.url) !== desiredPath) return false;
  const desiredFamilies = eventFamilies(desired.eventTypes);
  return [...eventFamilies(sub.eventTypes)].some((family) =>
    desiredFamilies.has(family),
  );
}

// Best-effort removal of a redundant stale row; a delete failure must never
// fail the reconcile that already converged a live receiver.
async function deleteStaleSubscription(
  inkbox: Inkbox,
  sub: WebhookSubscription,
  logger?: PluginLogger,
): Promise<void> {
  try {
    await inkbox.webhooks.subscriptions.delete(sub.id);
    logger?.info?.(`Inkbox stale webhook subscription removed: ${sub.url}`);
  } catch (err) {
    if (err instanceof InkboxAPIError && err.statusCode === 404) return;
    logger?.warn?.(
      `Inkbox stale webhook subscription delete failed for ${sub.url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// Reconcile a desired subscription against the live set for one owner so a
// boot always converges the owner onto ITS current webhook URL: adopt the
// matching row, repoint a stale plugin row whose base URL changed, or create
// one. Returns the resulting row, or null if reconciliation aborted (e.g.
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
  // Rows left by earlier boots of this plugin (same route, old base URL —
  // e.g. a prior tunnel host, or a CI run in publicUrl mode). Repointed or
  // removed below so Inkbox never keeps delivering to a dead URL.
  const staleOurs = existing.filter((sub) => isStalePluginSubscription(sub, desired));

  if (match) {
    const result = sameEventTypes(match.eventTypes, desired.eventTypes)
      ? match
      : await inkbox.webhooks.subscriptions.update(match.id, {
          eventTypes: [...desired.eventTypes],
        });
    for (const stale of staleOurs) {
      await deleteStaleSubscription(inkbox, stale, logger);
    }
    return result;
  }

  if (staleOurs.length > 0) {
    // Repoint in place rather than delete+create: no zero-receiver window,
    // and it cannot trip the per-owner subscription cap.
    const [primary, ...extras] = staleOurs;
    try {
      const updated = await inkbox.webhooks.subscriptions.update(primary.id, {
        url: desired.url,
        ...(sameEventTypes(primary.eventTypes, desired.eventTypes)
          ? {}
          : { eventTypes: [...desired.eventTypes] }),
      });
      logger?.info?.(
        `Inkbox webhook subscription repointed from ${primary.url} to ${desired.url}`,
      );
      for (const stale of extras) {
        await deleteStaleSubscription(inkbox, stale, logger);
      }
      return updated;
    } catch (err) {
      if (!isDuplicateUrl409(err)) throw err;
      // A concurrent activation already owns the desired URL — adopt that
      // row and drop our stale ones.
      const refreshed = await inkbox.webhooks.subscriptions.list(ownerFilter);
      const raced = refreshed.find((sub) => sub.url === desired.url);
      if (!raced) throw err;
      const result = sameEventTypes(raced.eventTypes, desired.eventTypes)
        ? raced
        : await inkbox.webhooks.subscriptions.update(raced.id, {
            eventTypes: [...desired.eventTypes],
          });
      for (const stale of staleOurs) {
        await deleteStaleSubscription(inkbox, stale, logger);
      }
      return result;
    }
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
