import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollVoiceNote,
  unconfirmedVoiceNoteIds,
  snapshotHasVoiceNote,
  type VoiceEvent,
  VoiceNoteInbox,
  VoiceNoteNotAdmitted,
  voiceNoteContext,
  voiceNoteMessage,
} from "../src/voice-notes.js";

const received = (family = "imessage", statuses = ["pending"]): VoiceEvent => ({
  id: "event-received",
  event_type: `${family}.received`,
  data: {
    [family === "text" ? "text_message" : "message"]: {
      id: "message-1",
      direction: "inbound",
      conversation_id: "conversation-1",
      agent_identity_id: "agent-1",
      content: "Original caption",
      media: statuses.map((status, index) => ({
        id: `media-${index}`,
        url: "https://example.com/voice.wav",
        content_type: "audio/wav",
        transcription: {
          status,
          text: status === "completed" ? "Move the review to Thursday." : null,
        },
      })),
    },
  },
});
const completion = (family = "imessage", statuses = ["completed"]): VoiceEvent => ({
  data: { ...received(family, statuses).data, channel: family, message_id: "message-1" },
  id: "different-event-id",
  event_type: "message.transcription_finished",
});
let directory: string;
let inboxes: VoiceNoteInbox[];
beforeEach(() => {
  vi.useFakeTimers();
  directory = mkdtempSync(join(tmpdir(), "voice-notes-"));
  inboxes = [];
});
afterEach(() => {
  inboxes.forEach((inbox) => {
    inbox.close();
  });
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});
function setup(
  options: { poll?: (event: VoiceEvent) => Promise<VoiceEvent | undefined>; path?: string } = {},
) {
  const deliver = vi.fn(async (_event: VoiceEvent) => {}),
    poll = vi.fn(options.poll ?? (async () => undefined));
  const inbox = new VoiceNoteInbox({
    path: options.path ?? join(directory, "voice.json"),
    poll,
    deliver,
    warn: vi.fn(),
  });
  inboxes.push(inbox);
  return { inbox, deliver, poll };
}

describe("voice-note delivery", () => {
  it.each(["text", "imessage", "whatsapp"])(
    "waits nonblocking for %s completion and wakes once",
    async (family) => {
      const { inbox, deliver, poll } = setup();
      const original = received(family);
      expect(await inbox.accept(original)).toBe(true);
      expect(deliver).not.toHaveBeenCalled();
      const wrongId = completion(family);
      wrongId.data.message_id = "unrelated-source";
      expect(await inbox.accept(wrongId)).toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).not.toHaveBeenCalled();
      await inbox.accept(completion(family));
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      const message = deliver.mock.calls[0][0].data[family === "text" ? "text_message" : "message"];
      expect(message.content).toBe("Original caption");
      expect(voiceNoteContext(message)).toContain("Voice note 1 — automatically transcribed");
      expect(message.media[0].url).toBe(
        original.data[family === "text" ? "text_message" : "message"].media[0].url,
      );
      await inbox.accept(completion(family));
      await inbox.accept(received(family));
      await vi.advanceTimersByTimeAsync(70_000);
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(poll).not.toHaveBeenCalled();
    },
  );
  it("uses an early callback without turning it into a standalone wake", async () => {
    const { inbox, deliver } = setup();
    await inbox.accept(completion());
    expect(deliver).not.toHaveBeenCalled();
    await inbox.accept(received());
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("polls once at 60 seconds, then falls back without waiting for a late callback", async () => {
    const { inbox, deliver, poll } = setup();
    await inbox.accept(received());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(voiceNoteContext(deliver.mock.calls[0][0].data.message)).toContain(
      "Process the original attachment as usual",
    );
    await inbox.accept(completion());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("uses a completed poll and bounds an unresponsive poll", async () => {
    const resolved = setup({ poll: async () => completion() });
    await resolved.inbox.accept(received());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(resolved.deliver.mock.calls[0][0].data.message.media[0].transcription.status).toBe(
      "completed",
    );
    const hung = setup({ path: join(directory, "hung.json"), poll: () => new Promise(() => {}) });
    await hung.inbox.accept(received());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hung.deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hung.deliver).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite a completion arriving during the fallback poll", async () => {
    let resolve!: (event: VoiceEvent) => void;
    const { inbox, deliver } = setup({
      poll: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await inbox.accept(received());
    await vi.advanceTimersByTimeAsync(60_000);
    await inbox.accept(completion());
    resolve(received());
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].data.message.media[0].transcription.status).toBe("completed");
  });
  it("waits for every pending attachment and tolerates failed results", async () => {
    const { inbox, deliver } = setup();
    await inbox.accept(received("imessage", ["pending", "pending"]));
    await inbox.accept(completion("imessage", ["completed", "pending"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
    await inbox.accept(completion("imessage", ["completed", "failed"]));
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(1);
  });
  it("does not delay legacy messages or accept a mismatched completion", async () => {
    const { inbox, deliver } = setup();
    const legacy = received();
    delete legacy.data.message.media[0].transcription;
    expect(await inbox.accept(legacy)).toBe(false);
    await inbox.accept(received());
    const wrong = completion();
    wrong.data.message.conversation_id = "another-conversation";
    await inbox.accept(wrong);
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).not.toHaveBeenCalled();
  });
  it("resumes the original deadline after restart and cancels stopped timers", async () => {
    const path = join(directory, "restart.json");
    const first = setup({ path });
    await first.inbox.accept(received());
    await vi.advanceTimersByTimeAsync(45_000);
    first.inbox.close();
    const second = setup({ path });
    second.inbox.recover();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(first.deliver).not.toHaveBeenCalled();
    expect(second.poll).toHaveBeenCalledTimes(1);
    expect(second.deliver).toHaveBeenCalledTimes(1);
  });
  it("does not replay an ambiguous handoff after restart", async () => {
    const current = setup();
    current.deliver.mockRejectedValueOnce(new Error("host unavailable"));
    await current.inbox.accept(received());
    await inboxes[0].accept(completion());
    await vi.advanceTimersByTimeAsync(0);
    expect(unconfirmedVoiceNoteIds(join(directory, "voice.json"))).toEqual(["imessage:message-1"]);
    current.inbox.close();
    const recovered = setup();
    const refreshed = received();
    refreshed.data.message.media = [];
    expect(await recovered.inbox.accept(refreshed)).toBe(true);
    recovered.inbox.recover();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recovered.deliver).not.toHaveBeenCalled();
  });
  it("retries a transient host admission failure without polling a second time", async () => {
    const { inbox, deliver, poll } = setup();
    deliver.mockRejectedValueOnce(new VoiceNoteNotAdmitted("host temporarily unavailable"));
    await inbox.accept(received());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(poll).toHaveBeenCalledTimes(1);
    await inbox.accept(completion());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(2);
  });
  it("retains the one-poll decision across restart after failed admission", async () => {
    const path = join(directory, "poll-recovery.json");
    const first = setup({ path });
    first.deliver.mockRejectedValueOnce(new VoiceNoteNotAdmitted("host temporarily unavailable"));
    await first.inbox.accept(received());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(first.poll).toHaveBeenCalledTimes(1);
    first.inbox.close();
    const second = setup({ path });
    second.inbox.recover();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(second.deliver).toHaveBeenCalledTimes(1);
    expect(second.poll).not.toHaveBeenCalled();
  });
  it("polls the authenticated message read once without dropping raw metadata", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(completion("text").data.text_message)));
    const event = await pollVoiceNote(received("text"), {
      apiKey: "synthetic-key",
      baseUrl: "https://example.com",
      identity: async () => ({ id: "agent-1", phoneNumber: { id: "phone-1" } }),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://example.com/api/v1/phone/numbers/phone-1/texts/message-1",
    );
    expect(event?.data.text_message.media[0].transcription.status).toBe("completed");
  });
});


it.each(["text", "imessage", "whatsapp"])(
  "does not add a second wait for configured hosted %s input",
  async family => {
    vi.stubEnv("INKBOX_HOSTED_MODE", "1");
    try {
      const { inbox, deliver, poll } = setup();
      const event = received(family);
      expect(await inbox.accept(event)).toBe(false);
      const message = event.data[family === "text" ? "text_message" : "message"];
      expect(voiceNoteContext(message)).toContain("transcript unavailable");
      expect(await inbox.accept(completion(family))).toBe(true);
      inbox.recover();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(deliver).not.toHaveBeenCalled();
      expect(poll).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("does not let an event body claim hosted transcription ownership", async () => {
  vi.stubEnv("INKBOX_HOSTED_MODE", "");
  try {
    const { inbox, deliver } = setup();
    expect(await inbox.accept({ ...received(), hosted_delivery: { starts_agent: true } })).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
  }
});


it("leaves Companion admission to its durable consumer and resolves without dispatch", async () => {
  const { inbox, deliver, poll } = setup();
  const original = { ...received(), companion: { phase: "initialization", sequence: 1 } };
  expect(await inbox.accept(original)).toBe(false);
  const result = inbox.resolve(original);
  expect(deliver).not.toHaveBeenCalled();
  await inbox.accept(completion());
  await vi.advanceTimersByTimeAsync(0);
  const resolved = await result;
  expect(resolved.companion).toEqual(original.companion);
  expect(resolved.data.message.media[0].transcription.status).toBe("completed");
  expect(deliver).not.toHaveBeenCalled();
  expect(poll).not.toHaveBeenCalled();
});

it("retains an ordered consumer's deadline and one-poll fallback across restart", async () => {
  const file = join(directory, "companion-resolution.json");
  const original = { ...received(), companion: { phase: "initialization", sequence: 1 } };
  const first = setup({ path: file });
  const pending = first.inbox.resolve(original);
  const cancelled = expect(pending).rejects.toThrow("stopping");
  await vi.advanceTimersByTimeAsync(30_000);
  first.inbox.close();
  await cancelled;
  const second = setup({ path: file });
  second.inbox.recover();
  const resumed = second.inbox.resolve(original);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(second.poll).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await resumed).data.message.media[0].transcription.status).toBe("pending");
  expect(second.poll).toHaveBeenCalledTimes(1);
  expect(second.deliver).not.toHaveBeenCalled();
  second.inbox.close();
  const third = setup({ path: file });
  expect((await third.inbox.resolve(original)).data.message.media[0].transcription.status).toBe("pending");
  await third.inbox.accept(completion());
  expect((await third.inbox.resolve(original)).data.message.media[0].transcription.status).toBe("pending");
  expect(third.poll).not.toHaveBeenCalled();
  expect(third.deliver).not.toHaveBeenCalled();
});


it("does not label real video as an unavailable voice note", () => {
  const message = received().data.message;
  message.media[0].transcription = { status: "skipped", error_code: "not_audio" };
  expect(voiceNoteContext(message)).toBe("");
  message.media[0].transcription.error_code = "unsupported_audio";
  expect(voiceNoteContext(message)).toContain("transcript unavailable");
});


it("recognizes generated snapshot notes only on the exact trigger and caption", () => {
  const message = received("imessage", ["completed"]).data.message;
  message.media.unshift({ content_type: "image/png" });
  const note = "[Voice note 2 — automatically transcribed]\nMove the review to Thursday.";
  const entry = { id: message.id, isTrigger: true, text: `Original caption\n\n${note}` };
  expect(snapshotHasVoiceNote(message, [entry], "Original caption")).toBe(true);
  expect(snapshotHasVoiceNote(message, [{ ...entry, id: "other-source" }], "Original caption")).toBe(false);
  expect(snapshotHasVoiceNote(message, [{ ...entry, isTrigger: false }], "Original caption")).toBe(false);
  expect(snapshotHasVoiceNote(message, [entry], `Original caption\n\n${note}`)).toBe(false);
  expect(snapshotHasVoiceNote(message, [{ ...entry, text: "Original caption\n[Voice note 1]" }], "Original caption")).toBe(false);
});


it("settles a consumer waiter attached while ordinary delivery is in flight", async () => {
  let release!: () => void;
  const deliver = vi.fn(async () => new Promise<void>(resolve => { release = resolve; }));
  const inbox = new VoiceNoteInbox({ path: join(directory, "handoff.json"), poll: vi.fn(), deliver, warn: vi.fn() });
  inboxes.push(inbox);
  const accepting = inbox.accept(received("imessage", ["completed"]));
  await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
  const resolving = inbox.resolve(received());
  release();
  await accepting;
  const resolved = await resolving;
  expect(resolved.data.message.media[0].transcription.status).toBe("completed");
  expect(deliver).toHaveBeenCalledOnce();
});


const slackMessageId = "44444444-4444-4444-8444-444444444444";
const slackData = (statuses: string[]) => ({
  identity_id: "agent-1",
  connection_id: "connection-1",
  workspace_id: "TWORK",
  conversation_id: "CROOM",
  message_ts: "1770000000.000100",
  thread_ts: null,
  message_id: slackMessageId,
  event: {
    type: "message",
    text: "Original caption",
    files: statuses.map((status, index) => ({
      id: `F${index}`,
      name: "voice.m4a",
      mimetype: "audio/mp4",
      transcription: status === "pending"
        ? { status }
        : { status, text: status === "completed" ? "Move the review to Thursday." : null, error_code: status === "failed" ? "provider_error" : null },
    })),
  },
});
/** The normalized consumer event: the Slack envelope plus its Companion message view. */
const slackReceived = (statuses = ["pending"]): VoiceEvent => {
  const data: VoiceEvent = slackData(statuses);
  return {
    id: "slack-event",
    event_type: "slack.mention_received",
    companion: { channel: "slack", phase: "ordinary", sequence: 1 },
    data: { ...data, message: { id: slackMessageId, direction: "inbound", attachments: structuredClone(data.event.files) } },
  };
};
const slackCompletion = (statuses = ["completed"]): VoiceEvent => ({
  id: "slack-completion",
  event_type: "message.transcription_finished",
  data: { ...slackData(statuses), channel: "slack" },
});
const slackContext = (event: VoiceEvent) => voiceNoteContext(voiceNoteMessage(event, event.data.message));

describe("Slack voice-note resolution", () => {
  it("waits for the matching completion, labels it, and never wakes independently", async () => {
    const { inbox, deliver, poll } = setup();
    const original = slackReceived();
    expect(await inbox.accept(original)).toBe(false);
    const result = inbox.resolve(original);
    const unrelated = slackCompletion();
    unrelated.data.message_id = "55555555-5555-4555-8555-555555555555";
    expect(await inbox.accept(unrelated)).toBe(true);
    const moved = slackCompletion();
    moved.data.connection_id = "connection-2";
    expect(await inbox.accept(moved)).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([result.then(() => "settled"), Promise.resolve("waiting")])).toBe("waiting");
    expect(await inbox.accept(slackCompletion())).toBe(true);
    const resolved = await result;
    expect(resolved.companion).toEqual(original.companion);
    expect(resolved.data.event.files[0].transcription.status).toBe("completed");
    expect(resolved.data.message.attachments[0].transcription.status).toBe("completed");
    expect(slackContext(resolved)).toBe("[Voice note 1 — automatically transcribed]\nMove the review to Thursday.");
    expect(await inbox.accept(slackCompletion(["failed"]))).toBe(true);
    expect((await inbox.resolve(original)).data.event.files[0].transcription.status).toBe("completed");
    await vi.advanceTimersByTimeAsync(70_000);
    expect(deliver).not.toHaveBeenCalled();
    expect(poll).not.toHaveBeenCalled();
  });
  it("uses an early completion without waiting", async () => {
    const { inbox, poll } = setup();
    await inbox.accept(slackCompletion());
    const result = inbox.resolve(slackReceived());
    await vi.advanceTimersByTimeAsync(0);
    expect(slackContext(await result)).toContain("automatically transcribed");
    expect(poll).not.toHaveBeenCalled();
  });
  it("polls once at 60 seconds and uses the archived result", async () => {
    const { inbox, deliver, poll } = setup({ poll: async (event) => ({ ...event, data: { ...event.data, event: { ...event.data.event, files: slackData(["completed"]).event.files } } }) });
    const result = inbox.resolve(slackReceived());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(poll).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(slackContext(await result)).toContain("Move the review to Thursday.");
    expect(deliver).not.toHaveBeenCalled();
  });
  it("falls back to the original attachment after the wait and one poll", async () => {
    const { inbox, poll } = setup();
    const result = inbox.resolve(slackReceived());
    await vi.advanceTimersByTimeAsync(60_000);
    const resolved = await result;
    expect(poll).toHaveBeenCalledTimes(1);
    expect(resolved.data.event.files[0].transcription.status).toBe("pending");
    expect(slackContext(resolved)).toBe("[Voice note 1 — transcript unavailable] Process the original attachment as usual.");
    await inbox.accept(slackCompletion());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
  it("delivers a failed transcription as an unavailable voice note", async () => {
    const { inbox } = setup();
    const result = inbox.resolve(slackReceived());
    await inbox.accept(slackCompletion(["failed"]));
    expect(slackContext(await result)).toBe("[Voice note 1 — transcript unavailable] Process the original attachment as usual.");
  });
  it("does not delay a Slack message without enrolled audio", async () => {
    const { inbox, poll } = setup();
    const plain = slackReceived();
    delete plain.data.event.files[0].transcription;
    expect(await inbox.resolve(plain)).toBe(plain);
    const unkeyed = slackReceived();
    delete unkeyed.data.message_id;
    expect(await inbox.resolve(unkeyed)).toBe(unkeyed);
    expect(poll).not.toHaveBeenCalled();
  });
  it("keeps the original attachment when the envelope id differs from the verified source", async () => {
    const { inbox, deliver, poll } = setup();
    await inbox.accept(slackCompletion());
    const mismatched = slackReceived();
    mismatched.data.message.id = "55555555-5555-4555-8555-555555555555";
    expect(await inbox.resolve(mismatched)).toBe(mismatched);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(slackContext(mismatched)).toBe("[Voice note 1 — transcript unavailable] Process the original attachment as usual.");
    expect(poll).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
  it("polls the retained Slack message by its ID", async () => {
    const files = slackData(["completed"]).event.files;
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      messages: [{ id: slackMessageId, connection_id: "connection-1", conversation_id: "CROOM", message_ts: "1770000000.000100", files }],
    })));
    const identity = vi.fn();
    const event = await pollVoiceNote(slackReceived(), { apiKey: "synthetic-key", baseUrl: "https://example.com/", identity });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe(
      `https://example.com/api/v1/slack/connections/connection-1/archive/messages?message_id=${slackMessageId}`,
    );
    expect(identity).not.toHaveBeenCalled();
    expect(event?.data.event.files[0].transcription.status).toBe("completed");
    fetch.mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "another", connection_id: "connection-1", files }] })));
    expect(await pollVoiceNote(slackReceived(), { apiKey: "synthetic-key", identity })).toBeUndefined();
  });
});
