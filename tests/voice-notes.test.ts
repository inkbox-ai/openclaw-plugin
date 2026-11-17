import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pollVoiceNote,
  type VoiceEvent,
  VoiceNoteInbox,
  voiceNoteContext,
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
  ...received(family, statuses),
  id: "different-event-id",
  event_type: `${family}.transcription_finished`,
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
      await inbox.accept(completion(family));
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(1);
      const message = deliver.mock.calls[0][0].data[family === "text" ? "text_message" : "message"];
      expect(message.content).toBe("Original caption");
      expect(voiceNoteContext(message)).toContain("Voice note 1 — transcription");
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
  it("retains a failed delivery for recovery rather than recording it as done", async () => {
    const current = setup();
    current.deliver.mockRejectedValueOnce(new Error("host unavailable"));
    await current.inbox.accept(received());
    await inboxes[0].accept(completion());
    await vi.advanceTimersByTimeAsync(0);
    current.inbox.close();
    const recovered = setup();
    recovered.inbox.recover();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(recovered.deliver).toHaveBeenCalledTimes(1);
  });
  it("retries a transient host admission failure without polling a second time", async () => {
    const { inbox, deliver, poll } = setup();
    deliver.mockRejectedValueOnce(new Error("host temporarily unavailable"));
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
    first.deliver.mockRejectedValueOnce(new Error("host temporarily unavailable"));
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
