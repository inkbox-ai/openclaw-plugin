// Bounded request-id dedup so retried webhooks short-circuit after a successful
// dispatch, while concurrent retries of an in-flight dispatch are suppressed.
export class RequestIdDedup {
  private seen = new Map<string, number>();
  private inflight = new Map<string, number>();

  constructor(
    private readonly maxSize: number = 10000,
    private readonly ttlMs: number = 300_000,
  ) {}

  has(requestId: string): boolean {
    if (!requestId) return false;
    this.prune();
    return this.seen.has(requestId) || this.inflight.has(requestId);
  }

  // Returns true when the id was claimed for work. Returns false for duplicate
  // committed or in-flight ids.
  begin(requestId: string): boolean {
    if (!requestId) return true;
    this.prune();
    if (this.seen.has(requestId) || this.inflight.has(requestId)) return false;
    this.inflight.set(requestId, Date.now());
    return true;
  }

  commit(requestId: string): void {
    if (!requestId) return;
    this.prune();
    this.inflight.delete(requestId);
    this.seen.set(requestId, Date.now());
    this.prune();
  }

  rollback(requestId: string): void {
    if (!requestId) return;
    this.inflight.delete(requestId);
  }

  // Records the id, evicting the oldest if we're at capacity.
  remember(requestId: string): void {
    this.commit(requestId);
  }

  size(): number {
    this.prune();
    return this.seen.size;
  }

  private prune(): void {
    const now = Date.now();
    for (const [requestId, seenAt] of this.seen) {
      if (now - seenAt >= this.ttlMs) this.seen.delete(requestId);
    }
    for (const [requestId, startedAt] of this.inflight) {
      if (now - startedAt >= this.ttlMs) this.inflight.delete(requestId);
    }
    while (this.seen.size > this.maxSize) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }
}
