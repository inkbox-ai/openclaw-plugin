// Outbound delivery-failure feedback loop — module semantics.
//
// The deterministic half of the loop: the budget math (3-send cap, shared
// across surfaces, reset on inbound/delivered/TTL), the synchronous
// send-rejection classification, the webhook payload extractors, and the
// wake-up prompt. The session-routing half (which conversation/thread the
// wake-up lands in, dedup, [SILENT]) lives in tests/inbound/delivery-failure-retry.test.ts.

import { beforeEach, describe, expect, it } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import {
  classifyDeliveryFailure,
  classifySendRejection,
  clearOutboundFailures,
  DELIVERY_FAILURE_EVENT_TYPES,
  imessageDeliveryFailure,
  mailDeliveryFailure,
  noteOutboundDeliveryFailure,
  outboundFailureKeys,
  OUTBOUND_FAILURE_MAX_ATTEMPTS as MAX,
  OUTBOUND_FAILURE_STATE_TTL_MS,
  resetDeliveryFailureStateForTest,
  textDeliveryFailure,
} from "../src/delivery-failure.js";

// Shaped like the SDK error for the server's content-policy 422.
function spamBlockError(): InkboxAPIError {
  return new InkboxAPIError(422, {
    error: "message_blocked_spam_filter",
    rule: "markdown_artifacts",
    text_message_id: "txt-blocked",
    message: "Markdown formatting (headers/bold/code fences) reads as bot traffic in SMS.",
  });
}

// Shaped like a 503 the host gateway retries on its own.
function transientError(): InkboxAPIError {
  return new InkboxAPIError(503, {
    error: "carrier_unavailable",
    message: "upstream temporarily unavailable",
  });
}

// Shaped like the iMessage-line 402 for an opted-out recipient.
function optOutError(): InkboxAPIError {
  return new InkboxAPIError(402, {
    error: "recipient_opted_out",
    message: "Recipient has opted out of messages from this line.",
  });
}

function noteSms(overrides: Partial<Parameters<typeof noteOutboundDeliveryFailure>[0]> = {}) {
  return noteOutboundDeliveryFailure({
    channel: "sms",
    stage: "send_rejected",
    conversationId: "conv-123",
    target: "+15555550101",
    chatId: "contact-123",
    failedBody: "**Jane Doe** is on file.",
    errorCode: "e",
    errorDetail: "d",
    ...overrides,
  });
}

beforeEach(() => {
  resetDeliveryFailureStateForTest();
});

// ── Failure keys ────────────────────────────────────────────────────────────

describe("outboundFailureKeys", () => {
  it("keys phones by digits so formatting variants share one budget", () => {
    expect(outboundFailureKeys("sms", "conv-1", "+1 (603) 494-5490")).toEqual([
      "sms:conv:conv-1",
      "sms:to:16034945490",
    ]);
  });

  it("keys email by address and falls back to the chat id only when unkeyable", () => {
    expect(outboundFailureKeys("email", undefined, "Kim@Example.com")).toEqual([
      "email:to:kim@example.com",
    ]);
    expect(outboundFailureKeys("sms", undefined, undefined, "chat-9")).toEqual([
      "sms:chat:chat-9",
    ]);
  });
});

// ── Synchronous send rejections ─────────────────────────────────────────────

describe("classifySendRejection", () => {
  it("surfaces the content-policy rule slug and reads as non-retryable", () => {
    const r = classifySendRejection("sms", spamBlockError());
    expect(r.retryable).toBe(false);
    expect(r.errorCode).toBe("message_blocked_spam_filter rule=markdown_artifacts");
    expect(r.errorDetail).toContain("reads as bot traffic in SMS");
  });

  it("marks transient failures retryable so the host gateway retries them", () => {
    expect(classifySendRejection("sms", transientError()).retryable).toBe(true);
  });

  it("classifies an opt-out as a non-retryable rejection", () => {
    const r = classifySendRejection("imessage", optOutError());
    expect(r.retryable).toBe(false);
    expect(r.errorCode).toBe("recipient_opted_out");
    expect(r.errorDetail).toContain("opted out");
  });

  it("classifies the local too-long guard as a fixable non-retryable rejection", () => {
    const r = classifySendRejection("sms", new Error("SMS text is 1601 characters; maximum is 1600."));
    expect(r.retryable).toBe(false);
    expect(r.errorCode).toBe("sms_too_long");
  });

  it("falls back to the raw message when there is no structured detail", () => {
    const r = classifySendRejection("email", new Error("550 mailbox unavailable"));
    expect(r.retryable).toBe(false);
    expect(r.errorDetail).toContain("550 mailbox unavailable");
  });
});

describe("classifyDeliveryFailure", () => {
  it.each([
    ["40002", "Flagged by a SPAM filter; temporary condition", "retryable"],
    ["message_blocked_spam_filter", "Markdown content rejected", "retryable"],
    ["message_too_long", "Message content is too long", "retryable"],
    ["carrier_unavailable", "Service temporarily unavailable", "retryable"],
    ["recipient_opted_out", "Recipient opted out", "terminal"],
    ["invalid_phone_number", "Invalid destination", "terminal"],
    ["unknown", "Destination is unreachable", "terminal"],
    ["content_rejected", "Unsafe or harmful content", "terminal"],
    ["unknown", "Provider rejected the message", "unknown"],
  ] as const)("classifies %s / %s as %s", (errorCode, errorDetail, expected) => {
    expect(classifyDeliveryFailure(errorCode, errorDetail)).toBe(expected);
  });
});

// ── The wake-up decision + prompt ───────────────────────────────────────────

describe("noteOutboundDeliveryFailure", () => {
  it("wakes a first retryable failure without offering [SILENT]", () => {
    const rej = classifySendRejection("sms", spamBlockError());
    const note = noteSms({ errorCode: rej.errorCode, errorDetail: rej.errorDetail });

    expect(note.woke).toBe(true);
    if (!note.woke) throw new Error("unreachable");
    expect(note.body).toContain(`[inkbox:delivery_failure channel=sms stage=send_rejected attempt=1/${MAX}`);
    expect(note.body).toContain("to=+15555550101");
    expect(note.body).toContain("conversation_id=conv-123");
    expect(note.body).toContain("message_blocked_spam_filter rule=markdown_artifacts");
    expect(note.body).toContain("reads as bot traffic in SMS");
    expect(note.body).toContain("«**Jane Doe** is on file.»");
    expect(note.body).toContain("SMS failure classification: FIRST SAFE RETRY REQUIRED");
    expect(note.body).not.toContain("[SILENT]");
  });

  it.each([
    {
      classification: "retryable",
      attempt: 1,
      errorCode: "40002",
      errorDetail: "Temporary spam filter rejection",
      required: "FIRST SAFE RETRY REQUIRED",
      forbidden: "[SILENT]",
    },
    {
      classification: "retryable",
      attempt: 2,
      errorCode: "40002",
      errorDetail: "Temporary spam filter rejection",
      required: "RETRY OPTIONAL",
      forbidden: "FIRST SAFE RETRY REQUIRED",
    },
    {
      classification: "terminal",
      attempt: 1,
      errorCode: "recipient_opted_out",
      errorDetail: "Recipient opted out",
      required: "DO NOT RETRY",
      forbidden: "FIRST SAFE RETRY REQUIRED",
    },
    {
      classification: "terminal",
      attempt: 2,
      errorCode: "invalid_phone_number",
      errorDetail: "Destination unreachable",
      required: "DO NOT RETRY",
      forbidden: "RETRY OPTIONAL",
    },
    {
      classification: "unknown",
      attempt: 1,
      errorCode: "unknown",
      errorDetail: "Provider rejected the message",
      required: "REVIEW BEFORE RETRY",
      forbidden: "FIRST SAFE RETRY REQUIRED",
    },
    {
      classification: "unknown",
      attempt: 2,
      errorCode: "unknown",
      errorDetail: "Provider rejected the message",
      required: "REVIEW BEFORE RETRY",
      forbidden: "RETRY OPTIONAL",
    },
  ] as const)(
    "$classification failure at attempt $attempt uses $required",
    ({ classification, attempt, errorCode, errorDetail, required, forbidden }) => {
      if (attempt === 2) {
        noteSms({ errorCode, errorDetail });
      }
      const note = noteSms({ errorCode, errorDetail });
      expect(note.woke).toBe(true);
      if (!note.woke) throw new Error("unreachable");
      expect(note.attempts).toBe(attempt);
      expect(note.body).toContain(required);
      expect(note.body).not.toContain(forbidden);
      if (classification === "retryable" && attempt === 1) {
        expect(note.body).not.toContain("[SILENT]");
      } else {
        expect(note.body).toContain("[SILENT]");
      }
    },
  );

  it("caps total sends: failures 1 and 2 wake, failure 3+ goes quiet", () => {
    const results = Array.from({ length: MAX + 1 }, () => noteSms());
    const woke = results.filter((r) => r.woke);
    expect(woke).toHaveLength(MAX - 1);
    expect((woke[0] as { body: string }).body).toContain(`attempt=1/${MAX}`);
    expect((woke[1] as { body: string }).body).toContain(`attempt=2/${MAX}`);
    expect(results[MAX]).toMatchObject({ woke: false, reason: "capped" });
  });

  it("does not wake when nothing stable can key the budget", () => {
    expect(noteSms({ conversationId: undefined, target: undefined, chatId: undefined })).toMatchObject({
      woke: false,
      reason: "no_key",
    });
  });

  it("carries the too-long slug through to the wake-up", () => {
    const rej = classifySendRejection("sms", new Error("SMS text is 1601 characters; maximum is 1600."));
    const note = noteSms({ errorCode: rej.errorCode, errorDetail: rej.errorDetail });
    expect(note.woke).toBe(true);
    if (!note.woke) throw new Error("unreachable");
    expect(note.body).toContain("channel=sms stage=send_rejected");
    expect(note.body).toContain("sms_too_long");
  });

  it("shares one budget across the synchronous and webhook surfaces", () => {
    const first = noteSms({ stage: "send_rejected" });
    const second = noteSms({ stage: "delivery_failed" });
    expect((first as { body: string }).body).toContain(`attempt=1/${MAX}`);
    expect((second as { body: string }).body).toContain(`attempt=2/${MAX}`);
  });

  it("resets the budget on a fresh inbound / delivered receipt", () => {
    noteSms();
    noteSms();
    clearOutboundFailures("sms", "conv-123", "+15555550101", "contact-123");
    const after = noteSms();
    expect((after as { body: string }).body).toContain(`attempt=1/${MAX}`);
  });

  it("expires the budget after the TTL", () => {
    const t0 = 1_000_000;
    noteSms({ now: t0 });
    const after = noteSms({ now: t0 + OUTBOUND_FAILURE_STATE_TTL_MS + 1 });
    expect((after as { body: string }).body).toContain(`attempt=1/${MAX}`);
  });
});

// ── Webhook payload extractors ──────────────────────────────────────────────

describe("delivery-failure webhook extractors", () => {
  it("subscribes to every hard failure event and never delivery_unconfirmed", () => {
    expect(DELIVERY_FAILURE_EVENT_TYPES).toEqual([
      "text.delivery_failed",
      "imessage.delivery_failed",
      "message.bounced",
      "message.failed",
    ]);
    expect(DELIVERY_FAILURE_EVENT_TYPES).not.toContain("text.delivery_unconfirmed");
  });

  it("reads a group outbound failure from its per-recipient row", () => {
    const failure = textDeliveryFailure({
      event_type: "text.delivery_failed",
      timestamp: "2026-07-01T00:00:00Z",
      data: {
        contacts: [],
        agent_identities: [],
        recipient_phone_number: "+15555550101",
        text_message: {
          id: "txt-out-1",
          direction: "outbound",
          remote_phone_number: null,
          text: "Sorry Kim — the site isn't built yet.",
          error_code: null,
          error_detail: null,
          conversation_id: "conv-123",
          recipients: [
            {
              recipient_phone_number: "+15555550101",
              delivery_status: "delivery_failed",
              error_code: "40002",
              error_detail: "Flagged by a SPAM filter.",
            },
          ],
        } as any,
      },
    } as any);
    expect(failure).not.toBeNull();
    expect(failure!.errorCode).toBe("40002");
    expect(failure!.errorDetail).toBe("Flagged by a SPAM filter.");
    expect(failure!.recipient).toBe("+15555550101");
    expect(failure!.stage).toBe("delivery_failed");
  });

  it("marks a mail bounce with the bounced stage and a recipient-aware reason", () => {
    const failure = mailDeliveryFailure({
      event_type: "message.bounced",
      timestamp: "2026-07-01T00:00:00Z",
      data: {
        contacts: [],
        agent_identities: [],
        message: {
          id: "mail-out-1",
          thread_id: "thread-1",
          message_id: "<out-1@inkboxmail.com>",
          from_address: "agent@inkboxmail.com",
          to_addresses: ["kim@example.com"],
          subject: "Your website",
          snippet: "Here is the plan for the build.",
          direction: "outbound",
          status: "bounced",
        } as any,
      },
    } as any);
    expect(failure).not.toBeNull();
    expect(failure!.stage).toBe("bounced");
    expect(failure!.recipient).toBe("kim@example.com");
    expect(failure!.rfcMessageId).toBe("<out-1@inkboxmail.com>");
    expect(failure!.failedBody).toBe("Here is the plan for the build.");
    expect(failure!.errorDetail).toContain("kim@example.com");
  });

  it("reads an iMessage failure reason off the message error fields", () => {
    const failure = imessageDeliveryFailure({
      event_type: "imessage.delivery_failed",
      timestamp: "2026-07-01T00:00:00Z",
      data: {
        contacts: [],
        agent_identities: [],
        reaction: null,
        message: {
          id: "imsg-out-1",
          direction: "outbound",
          remote_number: "+15555550101",
          conversation_id: "imsg-conv-1",
          content: "See you at 5!",
          status: "error",
          error_code: "OPTED_OUT",
          error_detail: "Recipient has opted out.",
        } as any,
      },
    } as any);
    expect(failure).not.toBeNull();
    expect(failure!.errorCode).toBe("OPTED_OUT");
    expect(failure!.failedBody).toBe("See you at 5!");
    expect(failure!.conversationId).toBe("imsg-conv-1");
  });
});
