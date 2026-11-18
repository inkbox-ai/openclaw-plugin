import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type VoiceEvent = Record<string, any>;
type Pending = { event: VoiceEvent; deadline: number; polled?: boolean; retryAt?: number };
type Saved = { pending: Record<string, Pending>; done: Record<string, number> };
const FAMILIES = new Set(["text", "imessage", "whatsapp"]);

function source(event: VoiceEvent): VoiceEvent | undefined {
  return event.data?.[event.event_type?.startsWith("text.") ? "text_message" : "message"];
}
function key(event: VoiceEvent): string | undefined {
  const message = source(event),
    family = event.event_type?.split(".")[0];
  return FAMILIES.has(family) && typeof message?.id === "string"
    ? `${family}:${message.id}`
    : undefined;
}
function pending(message: VoiceEvent | undefined): boolean {
  return (
    Array.isArray(message?.media) &&
    message.media.some((item: VoiceEvent) => item?.transcription?.status === "pending")
  );
}
function merge(original: VoiceEvent, updated: VoiceEvent): VoiceEvent {
  const before = source(original),
    after = source(updated);
  if (
    !before ||
    !after ||
    before.id !== after.id ||
    after.direction === "outbound" ||
    after.is_blocked === true ||
    (after.conversation_id &&
      before.conversation_id &&
      after.conversation_id !== before.conversation_id) ||
    (after.agent_identity_id &&
      before.agent_identity_id &&
      after.agent_identity_id !== before.agent_identity_id)
  )
    return original;
  const event = structuredClone(original),
    message = source(event);
  if (!message) return original;
  if (!Array.isArray(after.media)) return original;
  message.media = (before.media ?? []).map((item: VoiceEvent, index: number) => {
    const current = item.id
      ? after.media.find((candidate: VoiceEvent) => candidate.id === item.id)
      : after.media[index];
    if (item.transcription && item.transcription.status !== "pending") return item;
    return current?.transcription ? { ...item, transcription: current.transcription } : item;
  });
  return event;
}

export function voiceNoteContext(message: VoiceEvent | undefined): string {
  return (Array.isArray(message?.media) ? message.media : [])
    .flatMap((item: VoiceEvent, index: number) => {
      const result = item?.transcription;
      if (!result) return [];
      const label = `[Voice note ${index + 1} — ${result.status === "completed" ? "transcription" : "transcript unavailable"}]`;
      return [
        result.status === "completed" && typeof result.text === "string" && result.text.trim()
          ? `${label}\n${result.text}\n[End voice-note transcription]`
          : `${label}${result.status === "completed" ? " No speech detected." : " Process the original attachment as usual."}`,
      ];
    })
    .join("\n\n");
}

/** Delay only audio-bearing messages; completion callbacks never create turns. */
export class VoiceNoteInbox {
  private saved: Saved = { pending: {}, done: {} };
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private early = new Map<string, { event: VoiceEvent; at: number }>();
  private running = new Map<string, Promise<void>>();
  private stopped = false;
  constructor(
    private readonly options: {
      path: string;
      poll(event: VoiceEvent): Promise<VoiceEvent | undefined>;
      deliver(event: VoiceEvent): Promise<void>;
      warn(): void;
    },
  ) {
    if (existsSync(options.path)) this.saved = JSON.parse(readFileSync(options.path, "utf8"));
  }
  private persist(): void {
    const now = Date.now();
    this.saved.done = Object.fromEntries(
      Object.entries(this.saved.done)
        .filter(([, at]) => now - at < 86_400_000)
        .slice(-10_000),
    );
    mkdirSync(dirname(this.options.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(this.options.path), 0o700);
    const temporary = `${this.options.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.saved), { mode: 0o600, flush: true });
    renameSync(temporary, this.options.path);
    chmodSync(this.options.path, 0o600);
  }
  async accept(event: VoiceEvent): Promise<boolean> {
    if (this.stopped) throw new Error("Voice-note receiver is stopping.");
    if (typeof event.event_type !== "string") return false;
    const id = key(event);
    if (!id) return false;
    if (process.env.INKBOX_HOSTED_MODE === "1")
      return event.event_type.endsWith(".transcription_finished");
    const completion = event.event_type.endsWith(".transcription_finished");
    if (completion) {
      if (this.saved.done[id]) return true;
      const entry = this.saved.pending[id];
      if (entry) {
        entry.event = merge(entry.event, event);
        this.persist();
        if (!pending(source(entry.event))) this.launch(id, false);
      } else {
        const now = Date.now();
        for (const [cached, value] of this.early)
          if (now - value.at > 300_000) this.early.delete(cached);
        this.early.set(id, { event, at: now });
        if (this.early.size > 1000) {
          const oldest = this.early.keys().next().value;
          if (oldest) this.early.delete(oldest);
        }
      }
      return true;
    }
    if (
      !event.event_type.endsWith(".received") ||
      !Array.isArray(source(event)?.media) ||
      !source(event)?.media.some((item: VoiceEvent) => item?.transcription)
    )
      return false;
    if (this.saved.done[id] || this.saved.pending[id]) return true;
    const cached = this.early.get(id);
    this.early.delete(id);
    const current = cached && Date.now() - cached.at < 300_000 ? merge(event, cached.event) : event;
    this.saved.pending[id] = { event: current, deadline: Date.now() + 60_000 };
    this.persist();
    if (pending(source(current))) this.schedule(id);
    else await this.launch(id, false);
    return true;
  }
  recover(): void {
    if (process.env.INKBOX_HOSTED_MODE === "1") return;
    for (const id of Object.keys(this.saved.pending)) this.schedule(id);
  }
  private schedule(id: string): void {
    if (this.stopped || this.timers.has(id) || this.running.has(id)) return;
    const entry = this.saved.pending[id];
    if (!entry) return;
    const delay = entry.retryAt !== undefined
      ? Math.max(0, entry.retryAt - Date.now())
      : pending(source(entry.event)) && !entry.polled
        ? Math.max(0, entry.deadline - Date.now())
        : 0;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.launch(id, true);
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }
  private launch(id: string, poll: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const previous = this.running.get(id);
    if (previous) return previous;
    const task = Promise.resolve()
      .then(() => this.finish(id, poll))
      .catch(() => {
        const entry = this.saved.pending[id];
        if (entry) {
          entry.retryAt = Date.now() + 5_000;
          try { this.persist(); } catch { /* The original receipt remains retained. */ }
        }
        this.options.warn();
      })
      .finally(() => {
        this.running.delete(id);
        if (this.saved.pending[id]) this.schedule(id);
      });
    this.running.set(id, task);
    return task;
  }
  private async finish(id: string, poll: boolean): Promise<void> {
    const entry = this.saved.pending[id];
    if (!entry || this.stopped) return;
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    if (poll && pending(source(entry.event)) && !entry.polled) {
      entry.polled = true;
      this.persist();
      try {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const updated = await Promise.race([
          this.options.poll(entry.event),
          new Promise<undefined>((resolve) => {
            timeout = setTimeout(() => resolve(undefined), 10_000);
          }),
        ]).finally(() => clearTimeout(timeout));
        if (updated && this.saved.pending[id] === entry) entry.event = merge(entry.event, updated);
      } catch {
        /* The original attachment remains the fallback. */
      }
    }
    if (this.stopped || this.saved.pending[id] !== entry) return;
    delete entry.retryAt;
    this.persist();
    await this.options.deliver(entry.event);
    delete this.saved.pending[id];
    this.saved.done[id] = Date.now();
    this.persist();
  }
  close(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.early.clear();
  }
}

/** Read raw attachment metadata so older SDK response parsers cannot discard it. */
export async function pollVoiceNote(
  event: VoiceEvent,
  options: {
    apiKey?: string;
    baseUrl?: string;
    identity(): Promise<{ id: string; phoneNumber?: { id: string } | null }>;
  },
): Promise<VoiceEvent | undefined> {
  const message = source(event),
    family = event.event_type?.split(".")[0];
  if (!message?.id || !options.apiKey) return;
  const signal = AbortSignal.timeout(10_000);
  const identity = await options.identity();
  const id = encodeURIComponent(message.id),
    owner = encodeURIComponent(identity.id);
  const path =
    family === "text" && identity.phoneNumber?.id
      ? `/api/v1/phone/numbers/${encodeURIComponent(identity.phoneNumber.id)}/texts/${id}`
      : family === "imessage" || family === "whatsapp"
        ? `/api/v1/${family}/messages/${id}?agent_identity_id=${owner}`
        : undefined;
  if (!path) return;
  const response = await fetch(
    `${(options.baseUrl || "https://inkbox.ai").replace(/\/$/, "")}${path}`,
    {
      headers: { "X-Api-Key": options.apiKey },
      signal,
    },
  );
  if (!response.ok) return;
  return {
    ...event,
    data: {
      ...event.data,
      [family === "text" ? "text_message" : "message"]: await response.json(),
    },
  };
}
