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
    conversationId?: string;
  };
}

export type FlushFn = (batched: BatchedTextEvent) => Promise<void> | void;

interface PendingBatch {
  key: string;
  remotePhoneNumber: string;
  conversationId?: string;
  fragments: TextWebhookPayload[];
  totalChars: number;
  timer: NodeJS.Timeout | null;
}

function textRemotePhone(event: TextWebhookPayload): string | undefined {
  const message = (event as any)?.data?.text_message;
  const remote = message?.sender_phone_number ??
    message?.senderPhoneNumber ??
    message?.remote_phone_number ??
    message?.remotePhoneNumber;
  return typeof remote === "string" && remote.trim() ? remote.trim() : undefined;
}

function textConversationId(event: TextWebhookPayload): string | undefined {
  const message = (event as any)?.data?.text_message;
  const conversationId = message?.conversation_id ?? message?.conversationId;
  return typeof conversationId === "string" && conversationId.trim()
    ? conversationId.trim()
    : undefined;
}

function batchKey(event: TextWebhookPayload): { key: string; remote: string; conversationId?: string } | undefined {
  const remote = textRemotePhone(event);
  if (!remote) return undefined;
  const conversationId = textConversationId(event);
  return {
    remote,
    conversationId,
    key: conversationId ? `${conversationId}:${remote}` : remote,
  };
}

// Keyed by conversation + sender when a conversation id is available, otherwise
// by remote phone number. This keeps split fragments from one sender together
// without merging different people talking inside the same group chat.
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
    const keyInfo = batchKey(event);
    if (!keyInfo) return false;

    let batch = this.pending.get(keyInfo.key);
    if (!batch) {
      batch = {
        key: keyInfo.key,
        remotePhoneNumber: keyInfo.remote,
        conversationId: keyInfo.conversationId,
        fragments: [],
        totalChars: 0,
        timer: null,
      };
      this.pending.set(keyInfo.key, batch);
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
      void this.flush(keyInfo.key);
      return true;
    }

    // Otherwise reset the inactivity timer.
    this.clearTimer(batch);
    batch.timer = setTimeout(() => void this.flush(keyInfo.key), this.cfg.batchDelayMs);
    return true;
  }

  private clearTimer(batch: PendingBatch): void {
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }
  }

  private async flush(key: string): Promise<void> {
    const batch = this.pending.get(key);
    if (!batch || batch.fragments.length === 0) return;
    this.pending.delete(key);
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
        remotePhoneNumber: batch.remotePhoneNumber,
        ...(batch.conversationId ? { conversationId: batch.conversationId } : {}),
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
