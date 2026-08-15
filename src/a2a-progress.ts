export const DEFAULT_A2A_PROGRESS_INTERVAL_SECONDS = 180;

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

export function a2aProgressFallback(activities: string[], elapsedSeconds: number): string {
  const recent = [...new Set(activities.slice(-2))];
  const work = recent.length > 0
    ? recent.join(" and ")
    : "working through the requested task";
  return `I'm ${work}. (${elapsedSeconds}s elapsed)`;
}

export function sanitizeA2AProgressText(
  value: string,
  fallback: string,
  elapsedSeconds: number,
): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  const withoutElapsed = normalized.replace(/\s*\(\d+s elapsed\)\s*$/i, "").trim();
  if (
    !withoutElapsed ||
    /\b(done|complete[dt]?|finished|final answer|failed|failure|blocked|cannot complete|need(?:ed|s)? (?:your )?input|waiting for (?:you|input))\b/i.test(withoutElapsed)
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
