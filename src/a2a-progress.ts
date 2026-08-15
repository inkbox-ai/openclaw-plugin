import {
  normalizeA2AIdentifierText,
  normalizeA2AToolIdentifier,
} from "./a2a-progress-activity.js";

export const DEFAULT_A2A_PROGRESS_INTERVAL_SECONDS = 180;

const TERMINAL_CLAIM_RE =
  /\b(?:done|complete|completed|finished|failed|failure|blocked|solved|finalized|ready|succeed(?:ed|s|ing)?|successful(?:ly)?|resolved|final\s+(?:answer|result)|cannot\s+(?:complete|continue)|need(?:ed|s)?\s+(?:your\s+)?input|waiting\s+(?:for\s+)?(?:your\s+)?input|waiting\s+for\s+you)\b/i;

export function resolveA2AProgressIntervalSeconds(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : DEFAULT_A2A_PROGRESS_INTERVAL_SECONDS;
}

export function a2aReceiptText(taskId: string, intervalSeconds: number): string {
  const cadence = intervalSeconds % 60 === 0
    ? `about every ${intervalSeconds / 60} ${intervalSeconds === 60 ? "minute" : "minutes"}`
    : `about every ${intervalSeconds} seconds`;
  return `Task ${taskId} received. Work is queued and starting. Expect progress updates ${cadence}.`;
}

export function a2aProgressFallback(elapsedSeconds: number): string {
  return `I'm continuing the requested work. (${elapsedSeconds}s elapsed)`;
}

export function sanitizeA2AProgressText(
  value: string,
  toolIdentifiers: string[],
  elapsedSeconds: number,
): string {
  const fallback = a2aProgressFallback(elapsedSeconds);
  const normalized = value.replace(/\s+/g, " ").trim();
  const withoutElapsed = normalized.replace(/\s*\(\d+s elapsed\)\s*$/i, "").trim();
  const normalizedText = normalizeA2AIdentifierText(withoutElapsed);
  const repeatsIdentifier = toolIdentifiers.some((identifier) => {
    const safeIdentifier = normalizeA2AToolIdentifier(identifier);
    return safeIdentifier.length > 0 && new RegExp(
      `(?:^|_)${safeIdentifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:_|$)`,
    ).test(normalizedText);
  });
  if (
    !withoutElapsed ||
    repeatsIdentifier ||
    TERMINAL_CLAIM_RE.test(withoutElapsed)
  ) {
    return fallback;
  }
  const words = withoutElapsed.split(" ").slice(0, 16).join(" ").slice(0, 180).trim();
  if (!words) return fallback;
  return `${words.replace(/[.!?]+$/, "")}. (${elapsedSeconds}s elapsed)`;
}

export function taskAgentHistoryContains(task: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  const visit = (value: unknown): boolean => {
    if (value === expected) return true;
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some(visit);
    return Object.values(value as Record<string, unknown>).some(visit);
  };
  if (!task || typeof task !== "object") return false;
  const record = task as {
    messages?: unknown;
    raw?: { history?: unknown };
  };
  const messages = Array.isArray(record.messages)
    ? record.messages
    : Array.isArray(record.raw?.history)
      ? record.raw.history
      : [];
  return messages.some((message) => {
    if (!message || typeof message !== "object") return false;
    const entry = message as { role?: unknown; parts?: unknown };
    const role = String(entry.role ?? "").toLowerCase();
    return (role === "agent" || role === "role_agent") && visit(entry.parts);
  });
}

export function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      signal.removeEventListener("abort", finish);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}
