// Spin-off thread context (issue #10).
//
// When the agent messages someone new mid-conversation ("go ask Alex about
// X"), the send goes out through a send tool and Alex's eventual reply routes
// to a fresh session with no link back to the conversation that spawned it.
//
// This is the same in-process seam as channel-hint.ts: the inbound bridge
// records the conversation it is currently processing, the send tools read
// that to parent a spin-off, and the inbound bridge consumes the link when
// the new recipient replies — so the spawned turn knows why it exists, holds
// a reference to its parent thread, and can relay the answer back.

// The conversation currently being processed. Set by the inbound bridge for
// the duration of a turn's agent run (same global-latest tradeoff as
// channel-hint.ts): a send tool invoked during the run reads this to know
// which conversation it is spinning off from.
export interface ActiveConversation {
  // Session key of the conversation the agent is currently in.
  sessionKey: string;
  // Where a relayed answer goes back (conversation id or address).
  replyTarget: string;
  // Human label of the parent conversation, for the injected context block.
  label: string;
  // The parent's remote party, normalized — used to tell a spin-off (a new
  // recipient) apart from a reply to the same person.
  party?: string;
}

let active: ActiveConversation | undefined;

export function setActiveConversation(ctx: ActiveConversation | undefined): void {
  active = ctx;
}

export function getActiveConversation(): ActiveConversation | undefined {
  return active;
}

// A recorded spin-off: the new recipient's reply should inherit this parent.
export interface SpawnLink {
  parentSessionKey: string;
  parentReplyTarget: string;
  parentLabel: string;
  // The message the agent sent out, as the "why" the thread exists.
  why: string;
}

type StoredSpawnLink = SpawnLink & { recordedAt: number };

// A spin-off waiting on a reply is short-lived; bound by TTL and count so an
// abandoned outreach can't linger and mis-parent a much later, unrelated
// conversation with the same person.
const SPAWN_LINK_TTL_MS = 6 * 60 * 60 * 1000;
const SPAWN_LINK_MAX_ENTRIES = 500;
const WHY_SNIPPET_MAX_CHARS = 500;
const spawnLinks = new Map<string, StoredSpawnLink>();

// Normalize a recipient into the same key an inbound reply will resolve to:
// email addresses lowercased, phone numbers reduced to their +digits.
export function normalizeRecipientKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes("@")) {
    return trimmed.toLowerCase();
  }
  const digits = trimmed.replace(/[^+\d]/g, "");
  return digits || trimmed;
}

function prune(now = Date.now()): void {
  for (const [key, link] of spawnLinks) {
    if (now - link.recordedAt > SPAWN_LINK_TTL_MS) {
      spawnLinks.delete(key);
    }
  }
  while (spawnLinks.size > SPAWN_LINK_MAX_ENTRIES) {
    const oldest = spawnLinks.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    spawnLinks.delete(oldest);
  }
}

// Record that the currently-active conversation spun off a message to
// `recipient`. No-op when there is no active conversation, or when the
// recipient is the active conversation's own party (a reply, not a spin-off).
export function recordSpawnFromActive(params: {
  recipient: string | undefined;
  body: string | undefined;
}): void {
  const parent = active;
  if (!parent) {
    return;
  }
  const key = normalizeRecipientKey(params.recipient);
  if (!key || key === parent.party) {
    return;
  }
  prune();
  spawnLinks.set(key, {
    parentSessionKey: parent.sessionKey,
    parentReplyTarget: parent.replyTarget,
    parentLabel: parent.label,
    why: (params.body ?? "").slice(0, WHY_SNIPPET_MAX_CHARS),
    recordedAt: Date.now(),
  });
}

// Consume the spawn link for a replying recipient, if any. One-shot: the
// first reply inherits the parent (context block + parent session), after
// which the spawned session carries the history itself.
export function consumeSpawnLink(recipient: string | undefined): SpawnLink | undefined {
  prune();
  const key = normalizeRecipientKey(recipient);
  if (!key) {
    return undefined;
  }
  const link = spawnLinks.get(key);
  if (!link) {
    return undefined;
  }
  spawnLinks.delete(key);
  const { recordedAt: _recordedAt, ...rest } = link;
  return rest;
}

// The context block prepended to a spun-off reply's turn: what the thread is
// for, and how to relay the answer back to the parent conversation.
export function buildSpawnContextBlock(link: SpawnLink): string {
  return [
    `[inkbox:spinoff_thread parent=${JSON.stringify(link.parentLabel)} relay_to=${link.parentReplyTarget}]`,
    `You started this conversation from another thread (${link.parentLabel}).`,
    `You reached out here to: ${JSON.stringify(link.why)}`,
    "When you have what you need, relay the answer back to that original conversation using your messaging tools; do not leave it waiting.",
  ].join("\n");
}

// Test hook — the module-level stores persist across vitest cases otherwise.
export function resetSpawnContextForTest(): void {
  active = undefined;
  spawnLinks.clear();
}
