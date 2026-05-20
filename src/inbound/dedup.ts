// Bounded request-id dedup so retried webhooks short-circuit. Inkbox retries
// on non-200; we want repeat deliveries of the same event to be cheap no-ops
// rather than re-running session ingress.
export class RequestIdDedup {
  private seen = new Set<string>();
  private order: string[] = [];

  constructor(private readonly maxSize: number = 10000) {}

  has(requestId: string): boolean {
    return this.seen.has(requestId);
  }

  // Records the id, evicting the oldest if we're at capacity.
  remember(requestId: string): void {
    if (this.seen.has(requestId)) return;
    this.seen.add(requestId);
    this.order.push(requestId);
    if (this.order.length > this.maxSize) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.seen.delete(evicted);
    }
  }

  size(): number {
    return this.seen.size;
  }
}
