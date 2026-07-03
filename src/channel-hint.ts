// Which line is a conversation happening on? The inbound session bridge
// records the modality of every dispatched turn here (same in-process seam
// as outbound-call-context), so the place-call tool can follow the current
// conversation's channel when resolving which line an outbound call should
// originate from without the agent having to say so.

const CHANNEL_HINT_TTL_MS = 24 * 60 * 60 * 1000;

// iMessage turns ride the shared iMessage line; SMS and voice turns ride the
// dedicated number. Email (and warmup) turns say nothing about phone lines.
export type ChannelHint = "imessage" | "dedicated";

type HintEntry = { hint: ChannelHint; at: number };

// Last inbound modality per remote address, plus the most recent turn overall
// (the "current conversation" while the agent is processing that turn).
const byAddress = new Map<string, HintEntry>();
let latest: HintEntry | undefined;

function normalizeAddress(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/[^+\d]/g, "") || trimmed : undefined;
}

function prune(now = Date.now()): void {
  for (const [key, entry] of byAddress) {
    if (now - entry.at > CHANNEL_HINT_TTL_MS) {
      byAddress.delete(key);
    }
  }
}

function hintForMode(mode: string): ChannelHint | undefined {
  if (mode === "imessage") {
    return "imessage";
  }
  if (mode === "sms" || mode === "voice") {
    return "dedicated";
  }
  return undefined;
}

// Record an inbound turn's modality. Non-phone modalities (email, warmup,
// external) clear the "current conversation" hint without touching per-address
// history — during those turns the phone channel is simply unknown.
export function recordInboundChannelHint(params: {
  mode: string;
  remoteAddress?: string;
}): void {
  const hint = hintForMode(params.mode);
  const now = Date.now();
  if (!hint) {
    latest = undefined;
    return;
  }
  prune(now);
  latest = { hint, at: now };
  const address = normalizeAddress(params.remoteAddress);
  if (address) {
    byAddress.set(address, { hint, at: now });
  }
}

// Resolve the channel the conversation with `remoteAddress` is on: the
// per-address record wins (covers "call me" for a specific person), falling
// back to the most recent inbound turn's modality. Undefined when nothing is
// known (CLI, tests, or a non-phone turn).
export function resolveChannelHint(remoteAddress?: string): ChannelHint | undefined {
  const now = Date.now();
  prune(now);
  const address = normalizeAddress(remoteAddress);
  const entry = address ? byAddress.get(address) : undefined;
  if (entry) {
    return entry.hint;
  }
  return latest && now - latest.at <= CHANNEL_HINT_TTL_MS ? latest.hint : undefined;
}

// Test hook — the module-level store persists across vitest cases otherwise.
export function resetChannelHintsForTest(): void {
  byAddress.clear();
  latest = undefined;
}
