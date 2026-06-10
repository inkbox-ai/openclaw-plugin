import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { IMessageBatcher, SmsBatcher } from "../../src/inbound/batch.js";

function textEvent(remote: string, text: string, conversationId?: string): any {
  return {
    event_type: "text.received",
    timestamp: "2026-05-21T00:00:00Z",
    data: {
      text_message: {
        id: `t-${Math.random()}`,
        remote_phone_number: remote,
        ...(conversationId ? { conversation_id: conversationId } : {}),
        text,
      },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SmsBatcher", () => {
  it("falls through when batchDelayMs is 0", () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 0, maxMessages: 8, maxChars: 4000 }, flush);
    expect(b.accept(textEvent("+15551234567", "hi"))).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not batch delivery-status events", () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    const delivered = textEvent("+15551234567", "hi");
    delivered.event_type = "text.delivered";
    expect(b.accept(delivered)).toBe(false);
  });

  it("accumulates fragments from same number and flushes after delay", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    expect(b.accept(textEvent("+15551234567", "hi"))).toBe(true);
    expect(b.accept(textEvent("+15551234567", "are"))).toBe(true);
    expect(b.accept(textEvent("+15551234567", "you there?"))).toBe(true);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(110);
    expect(flush).toHaveBeenCalledTimes(1);
    const batched = flush.mock.calls[0][0];
    // Concatenated body, joined with newlines.
    expect(batched.data.text_message.text).toBe("hi\nare\nyou there?");
    // Original fragments preserved on the __batch extension.
    expect(batched.__batch.fragments).toHaveLength(3);
    expect(batched.__batch.remotePhoneNumber).toBe("+15551234567");
  });

  it("flushes per remote number — bursts from different senders do not merge", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    b.accept(textEvent("+15551234567", "hi from A"));
    b.accept(textEvent("+15559999999", "hi from B"));
    await vi.advanceTimersByTimeAsync(110);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("does not merge different senders in the same group conversation", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    b.accept(textEvent("+15551234567", "hi from A", "conv-group"));
    b.accept(textEvent("+15559999999", "hi from B", "conv-group"));
    await vi.advanceTimersByTimeAsync(110);
    expect(flush).toHaveBeenCalledTimes(2);
    const first = flush.mock.calls[0][0];
    expect(first.__batch.conversationId).toBe("conv-group");
  });

  it("respects maxMessages cap by flushing immediately", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 2, maxChars: 4000 }, flush);
    b.accept(textEvent("+15551234567", "one"));
    b.accept(textEvent("+15551234567", "two"));
    // Flush is async; let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("respects maxChars cap by flushing immediately", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 100, maxMessages: 10, maxChars: 10 }, flush);
    b.accept(textEvent("+15551234567", "hello"));
    b.accept(textEvent("+15551234567", "world!")); // total 11 chars → caps
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushAll synchronously drains pending batches", async () => {
    const flush = vi.fn();
    const b = new SmsBatcher({ batchDelayMs: 999_999, maxMessages: 10, maxChars: 10000 }, flush);
    b.accept(textEvent("+15551234567", "queued"));
    expect(flush).not.toHaveBeenCalled();
    await b.flushAll();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});

function imessageEvent(remote: string, content: string, conversationId = "imconv-1"): any {
  return {
    event_type: "imessage.received",
    timestamp: "2026-06-10T00:00:00Z",
    data: {
      message: {
        id: `im-${Math.random()}`,
        conversation_id: conversationId,
        direction: "inbound",
        remote_number: remote,
        content,
      },
    },
  };
}

describe("IMessageBatcher", () => {
  it("falls through when batchDelayMs is 0", () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 0, maxMessages: 8, maxChars: 4000 }, flush);
    expect(b.accept(imessageEvent("+15551234567", "hi"))).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it("does not batch delivery-lifecycle events", () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    const delivered = imessageEvent("+15551234567", "hi");
    delivered.event_type = "imessage.delivered";
    expect(b.accept(delivered)).toBe(false);
  });

  it("accumulates fragments from the same conversation and flushes after delay", async () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    expect(b.accept(imessageEvent("+15551234567", "hi"))).toBe(true);
    expect(b.accept(imessageEvent("+15551234567", "are"))).toBe(true);
    expect(b.accept(imessageEvent("+15551234567", "you there?"))).toBe(true);
    expect(flush).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(110);
    expect(flush).toHaveBeenCalledTimes(1);
    const batched = flush.mock.calls[0][0];
    expect(batched.data.message.content).toBe("hi\nare\nyou there?");
    expect(batched.__batch.fragments).toHaveLength(3);
    expect(batched.__batch.remoteNumber).toBe("+15551234567");
    expect(batched.__batch.conversationId).toBe("imconv-1");
  });

  it("does not merge bursts from different conversations", async () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 100, maxMessages: 8, maxChars: 4000 }, flush);
    b.accept(imessageEvent("+15551234567", "hi from A", "imconv-a"));
    b.accept(imessageEvent("+15559999999", "hi from B", "imconv-b"));
    await vi.advanceTimersByTimeAsync(110);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("respects maxMessages cap by flushing immediately", async () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 100, maxMessages: 2, maxChars: 4000 }, flush);
    b.accept(imessageEvent("+15551234567", "one"));
    b.accept(imessageEvent("+15551234567", "two"));
    await Promise.resolve();
    await Promise.resolve();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("flushAll synchronously drains pending batches", async () => {
    const flush = vi.fn();
    const b = new IMessageBatcher({ batchDelayMs: 999_999, maxMessages: 10, maxChars: 10000 }, flush);
    b.accept(imessageEvent("+15551234567", "queued"));
    expect(flush).not.toHaveBeenCalled();
    await b.flushAll();
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
