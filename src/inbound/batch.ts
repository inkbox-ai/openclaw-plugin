import type { TextWebhookPayload } from "@inkbox/sdk";

export interface SmsBatchConfig {
  // Wait this many ms after the last text.received from a given remote
  // number before flushing the batch. 0 disables batching entirely.
  batchDelayMs: number;
  // Hard cap on fragments collected in a single batch. When hit, flush
  // immediately even if the delay hasn't elapsed.
  maxMessages: number;
  // Hard cap on total chars collected in a single batch. Same flush rule.
  maxChars: number;
}

export const DEFAULT_SMS_BATCH: SmsBatchConfig = {
  batchDelayMs: 0,
  maxMessages: 8,
  maxChars: 4000,
};

// A flushed batch — what onText receives when batching is on. We emit a
// synthesized payload that looks like a regular TextWebhookPayload with the
// concatenated text in the `text` field, plus a `__batch` extension carrying
// the original event list so a downstream handler can see the raw fragments
// if it cares to.
export interface BatchedTextEvent extends TextWebhookPayload {
  __batch?: {
    fragments: TextWebhookPayload[];
    remotePhoneNumber: string;
  };
}

export type FlushFn = (batched: BatchedTextEvent) => Promise<void> | void;

interface PendingBatch {
  remotePhoneNumber: string;
  fragments: TextWebhookPayload[];
  totalChars: number;
  timer: NodeJS.Timeout | null;
}

// Keyed by remote phone number. Each pending batch flushes when the delay
// elapses with no further fragments, or when a cap is hit. Designed so a
// burst of fragments from the same sender becomes a single logical event
// for the downstream handler.
export class SmsBatcher {
  private pending = new Map<string, PendingBatch>();

  constructor(
    private readonly cfg: SmsBatchConfig,
    private readonly flushFn: FlushFn,
  ) {}

  enabled(): boolean {
    return this.cfg.batchDelayMs > 0;
  }

  // Accept a text.received event. Returns true when the event was
  // accumulated (caller should NOT also call the underlying onText handler);
  // false when batching is disabled and caller should fall through.
  accept(event: TextWebhookPayload): boolean {
    if (!this.enabled()) return false;
    // Only batch text.received — delivery-status events fire-and-forget.
    if (event.event_type !== "text.received") return false;
    const remote =
      (event as any)?.data?.text_message?.remote_phone_number ??
      (event as any)?.data?.text_message?.remotePhoneNumber;
    if (!remote || typeof remote !== "string") return false;

    let batch = this.pending.get(remote);
    if (!batch) {
      batch = {
        remotePhoneNumber: remote,
        fragments: [],
        totalChars: 0,
        timer: null,
      };
      this.pending.set(remote, batch);
    }

    const text: string =
      (event as any)?.data?.text_message?.text ?? "";
    batch.fragments.push(event);
    batch.totalChars += text.length;

    // Flush immediately when caps are hit.
    if (
      batch.fragments.length >= this.cfg.maxMessages ||
      batch.totalChars >= this.cfg.maxChars
    ) {
      this.clearTimer(batch);
      void this.flush(remote);
      return true;
    }

    // Otherwise reset the inactivity timer.
    this.clearTimer(batch);
    batch.timer = setTimeout(() => void this.flush(remote), this.cfg.batchDelayMs);
    return true;
  }

  private clearTimer(batch: PendingBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
  }

  private async flush(remote: string): Promise<void> {
    const batch = this.pending.get(remote);
    if (!batch || batch.fragments.length === 0) return;
    this.pending.delete(remote);
    this.clearTimer(batch);
    const head = batch.fragments[0];
    const concatenated = batch.fragments
      .map((f: any) => f?.data?.text_message?.text ?? "")
      .join("\n");
    // Synthesize a batched event. Keep the first fragment's metadata
    // (timestamp, ids, contact) so handlers that key on those fields don't
    // see surprises.
    const out: BatchedTextEvent = {
      ...(head as any),
      data: {
        ...(head as any).data,
        text_message: {
          ...(head as any).data?.text_message,
          text: concatenated,
        },
      },
      __batch: {
        fragments: batch.fragments,
        remotePhoneNumber: remote,
      },
    };
    await this.flushFn(out);
  }

  // Test helper — flush every pending batch synchronously without waiting
  // for timers. Useful in unit tests so the assertions don't have to await
  // wallclock.
  async flushAll(): Promise<void> {
    const keys = Array.from(this.pending.keys());
    await Promise.all(keys.map((k) => this.flush(k)));
  }
}
