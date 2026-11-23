import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type VoiceEvent = Record<string, any>;
export class VoiceNoteNotAdmitted extends Error {}

type Pending = { event: VoiceEvent; deadline: number; polled?: boolean; handoff?: "attempting" | "retry"; retryAt?: number; resolutionOnly?: boolean; resolvedAt?: number };
type Saved = { handoffVersion?: number; pending: Record<string, Pending>; done: Record<string, number> };
const FAMILIES = new Set(["text", "imessage", "whatsapp", "slack"]);
// A Slack completion must name the same retained message in the same place.
const SLACK_COORDINATES = ["identity_id", "connection_id", "workspace_id", "conversation_id", "message_ts"];

export const TRANSCRIPTION_FINISHED = "message.transcription_finished";

function channelOf(event: VoiceEvent): string | undefined {
  return event.event_type === TRANSCRIPTION_FINISHED ? event.data?.channel : event.event_type?.split(".")[0];
}

function source(event: VoiceEvent): VoiceEvent | undefined {
  return event.data?.[channelOf(event) === "text" ? "text_message" : "message"];
}
/** Attachments that carry transcription results; Slack keeps them on the event's files. */
function media(event: VoiceEvent): VoiceEvent[] | undefined {
  const items = channelOf(event) === "slack" ? event.data?.event?.files : source(event)?.media;
  return Array.isArray(items) ? items : undefined;
}
function key(event: VoiceEvent): string | undefined {
  const message = source(event),
    family = channelOf(event);
  if (family === "slack") {
    const id = event.data?.message_id;
    return typeof id === "string" && id ? `slack:${id}` : undefined;
  }
  if (event.event_type === TRANSCRIPTION_FINISHED && event.data?.message_id !== message?.id) return undefined;
  return family && FAMILIES.has(family) && typeof message?.id === "string"
    ? `${family}:${message.id}`
    : undefined;
}
function pending(event: VoiceEvent): boolean {
  return Boolean(media(event)?.some((item: VoiceEvent) => item?.transcription?.status === "pending"));
}
function mergeMedia(before: VoiceEvent[], after: VoiceEvent[]): VoiceEvent[] {
  return before.map((item: VoiceEvent, index: number) => {
    const current = item?.id
      ? after.find((candidate: VoiceEvent) => candidate?.id === item.id)
      : after[index];
    if (item?.transcription && item.transcription.status !== "pending") return item;
    return current?.transcription ? { ...item, transcription: current.transcription } : item;
  });
}
function mergeSlack(original: VoiceEvent, updated: VoiceEvent): VoiceEvent {
  const before = original.data,
    after = updated.data;
  if (
    !before ||
    !after ||
    channelOf(updated) !== "slack" ||
    before.message_id !== after.message_id ||
    !Array.isArray(after.event?.files) ||
    SLACK_COORDINATES.some(field => before[field] != null && after[field] != null && before[field] !== after[field])
  )
    return original;
  const event = structuredClone(original),
    files = mergeMedia(Array.isArray(before.event?.files) ? before.event.files : [], after.event.files);
  event.data.event = { ...event.data.event, files };
  // The normalized consumer message mirrors the same files as attachment metadata.
  if (Array.isArray(event.data.message?.attachments))
    event.data.message.attachments = mergeMedia(event.data.message.attachments, files);
  return event;
}
function merge(original: VoiceEvent, updated: VoiceEvent): VoiceEvent {
  if (channelOf(original) === "slack") return mergeSlack(original, updated);
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
  message.media = mergeMedia(before.media ?? [], after.media);
  return event;
}

/** The message view whose `media` carries results; Slack results live on the event's files. */
export function voiceNoteMessage(event: VoiceEvent, message: VoiceEvent | undefined): VoiceEvent | undefined {
  return channelOf(event) === "slack" ? { id: message?.id, media: media(event) ?? [] } : message;
}

export function voiceNoteContext(message: VoiceEvent | undefined): string {
  return (Array.isArray(message?.media) ? message.media : [])
    .flatMap((item: VoiceEvent, index: number) => {
      const result = item?.transcription;
      if (!result || result.error_code === "not_audio") return [];
      const label = `[Voice note ${index + 1} — ${result.status === "completed" ? "automatically transcribed" : "transcript unavailable"}]`;
      return [
        result.status === "completed" && typeof result.text === "string" && result.text.trim()
          ? `${label}\n${result.text}`
          : `${label}${result.status === "completed" ? " No speech detected." : " Process the original attachment as usual."}`,
      ];
    })
    .join("\n\n");
}

/** Recognize generated speech only on the matching initialization source. */
export function snapshotHasVoiceNote(
  message: VoiceEvent | undefined,
  entries: { id: string; isTrigger?: boolean; text?: string }[],
  caption: string,
): boolean {
  const trigger = entries.find(entry => entry.id === message?.id && entry.isTrigger === true);
  if (!trigger || !Array.isArray(message?.media)) return false;
  const notes = message.media.flatMap((item: VoiceEvent, index: number) => {
    const result = item?.transcription;
    if (!result || result.error_code === "not_audio") return [];
    const text = typeof result.text === "string" ? result.text.trim() : "";
    if (result.status === "completed") return [text
      ? `[Voice note ${index + 1} — automatically transcribed]\n${text}`
      : `[Voice note ${index + 1}: no speech detected in the recording]`];
    return [result.status === "pending"
      ? `[Voice note ${index + 1}: transcription pending; use the original attachment if needed and do not guess its contents]`
      : `[Voice note ${index + 1}: transcript unavailable; process the original attachment normally and do not guess its contents]`];
  });
  return notes.length > 0 && trigger.text === `${caption}\n\n${notes.join("\n\n")}`;
}

/** Delay only audio-bearing messages; completion callbacks never create turns. */
export function unconfirmedVoiceNoteIds(path: string): string[] {
  let saved: Saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return Object.entries(saved.pending)
    .filter(([, entry]) => entry.handoff === "attempting" && !entry.resolutionOnly)
    .map(([id]) => id)
    .sort();
}

export class VoiceNoteInbox {
  private saved: Saved = { pending: {}, done: {} };
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private early = new Map<string, { event: VoiceEvent; at: number }>();
  private running = new Map<string, Promise<void>>();
  private resolutions = new Map<string, Promise<VoiceEvent>>();
  private settled = new Map<string, { resolve(event: VoiceEvent): void; reject(error: Error): void }>();
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
    if (this.saved.handoffVersion !== 1) {
      // Older receipts that reached delivery had no pre-call checkpoint.
      for (const entry of Object.values(this.saved.pending)) {
        if (!entry.resolutionOnly && (entry.polled || entry.retryAt || !pending(entry.event))) {
          entry.handoff = "attempting";
        }
      }
      this.saved.handoffVersion = 1;
    }
  }
  private persist(): void {
    const now = Date.now();
    this.saved.pending = Object.fromEntries(Object.entries(this.saved.pending)
      .filter(([, entry]) => !entry.resolvedAt || now - entry.resolvedAt < 86_400_000));
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
    if (!id) return event.event_type === TRANSCRIPTION_FINISHED;
    if (process.env.INKBOX_HOSTED_MODE === "1")
      return event.event_type === TRANSCRIPTION_FINISHED;
    const completion = event.event_type === TRANSCRIPTION_FINISHED;
    if (completion) {
      if (this.saved.done[id]) return true;
      const entry = this.saved.pending[id];
      if (entry) {
        if (entry.resolvedAt || entry.handoff) return true;
        entry.event = merge(entry.event, event);
        this.persist();
        if (!pending(entry.event)) this.launch(id, false);
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
    if (event.companion) return false;
    if (!event.event_type.endsWith(".received")) return false;
    const retained = this.saved.pending[id];
    if (this.saved.done[id] || (retained && !retained.resolutionOnly)) return true;
    if (!media(event)?.some((item: VoiceEvent) => item?.transcription)) return false;
    if (retained) return true;
    const cached = this.early.get(id);
    this.early.delete(id);
    const current = cached && Date.now() - cached.at < 300_000 ? merge(event, cached.event) : event;
    this.saved.pending[id] = { event: current, deadline: Date.now() + 60_000 };
    this.persist();
    if (pending(current)) this.schedule(id);
    else await this.launch(id, false);
    return true;
  }
  /** Resolve within an already-durable consumer without independently dispatching it. */
  async resolve(event: VoiceEvent, deadline = Date.now() + 60_000): Promise<VoiceEvent> {
    if (this.stopped) throw new Error("Voice-note receiver is stopping.");
    if (process.env.INKBOX_HOSTED_MODE === "1") return event;
    const id = key(event);
    // A Slack wait is keyed by the envelope's message id; it must name the verified source message.
    if (channelOf(event) === "slack" && event.data?.message?.id !== event.data?.message_id) return event;
    if (!id || !pending(event) || this.saved.done[id]) return event;
    let entry = this.saved.pending[id];
    if (!entry) {
      const cached = this.early.get(id);
      this.early.delete(id);
      const current = cached && Date.now() - cached.at < 300_000 ? merge(event, cached.event) : event;
      entry = this.saved.pending[id] = { event: current, deadline, resolutionOnly: true };
    } else if (entry.handoff) {
      return merge(event, entry.event);
    } else {
      entry.resolutionOnly = true;
    }
    if (entry.resolvedAt) return merge(event, entry.event);
    this.persist();
    let task = this.resolutions.get(id);
    if (!task) {
      task = new Promise<VoiceEvent>((resolve, reject) => this.settled.set(id, { resolve, reject }));
      this.resolutions.set(id, task);
      this.schedule(id);
    }
    return merge(event, await task);
  }
  recover(): void {
    if (process.env.INKBOX_HOSTED_MODE === "1") return;
    for (const [id, entry] of Object.entries(this.saved.pending))
      if (!entry.resolutionOnly && !entry.event.companion) this.schedule(id);
  }
  private schedule(id: string): void {
    if (this.stopped || this.timers.has(id) || this.running.has(id)) return;
    const entry = this.saved.pending[id];
    if (!entry || entry.handoff === "attempting" || entry.resolvedAt || (entry.resolutionOnly && !this.resolutions.has(id))) return;
    const delay = entry.retryAt !== undefined
      ? Math.max(0, entry.retryAt - Date.now())
      : pending(entry.event) && !entry.polled
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
      .catch(error => {
        const entry = this.saved.pending[id];
        if (entry?.resolutionOnly) {
          delete entry.resolvedAt;
          this.settled.get(id)?.reject(error);
          this.settled.delete(id);
          this.resolutions.delete(id);
          this.options.warn();
          return;
        }
        if (entry && entry.handoff !== "attempting") {
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
    if (!entry.handoff && poll && pending(entry.event) && !entry.polled) {
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
    if (entry.resolutionOnly) {
      entry.resolvedAt = Date.now();
      this.persist();
      this.settled.get(id)?.resolve(entry.event);
      this.settled.delete(id);
      this.resolutions.delete(id);
      return;
    }
    // Persist before calling the host: a crash or generic exception does not
    // prove that the turn was refused.
    entry.handoff = "attempting";
    this.persist();
    try {
      await this.options.deliver(entry.event);
    } catch (error) {
      if (error instanceof VoiceNoteNotAdmitted) entry.handoff = "retry";
      throw error;
    }
    delete this.saved.pending[id];
    this.saved.done[id] = Date.now();
    this.persist();
    this.settled.get(id)?.resolve(entry.event);
    this.settled.delete(id);
    this.resolutions.delete(id);
  }
  close(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.early.clear();
    for (const waiter of this.settled.values()) waiter.reject(new Error("Voice-note receiver is stopping."));
    this.settled.clear();
    this.resolutions.clear();
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
    family = channelOf(event);
  const base = (options.baseUrl || "https://inkbox.ai").replace(/\/$/, "");
  if (family === "slack") {
    const id = event.data?.message_id,
      connection = event.data?.connection_id;
    if (typeof id !== "string" || typeof connection !== "string" || !options.apiKey) return;
    const response = await fetch(
      `${base}/api/v1/slack/connections/${encodeURIComponent(connection)}/archive/messages?message_id=${encodeURIComponent(id)}`,
      { headers: { "X-Api-Key": options.apiKey }, signal: AbortSignal.timeout(10_000) },
    );
    if (!response.ok) return;
    const body = await response.json();
    const found = Array.isArray(body?.messages)
      ? body.messages.find((candidate: VoiceEvent) => candidate?.id === id)
      : undefined;
    if (!found || found.connection_id !== connection || !Array.isArray(found.files)) return;
    // Carry the archived coordinates so the merge rejects a different message.
    return {
      ...event,
      data: {
        ...event.data,
        conversation_id: found.conversation_id,
        message_ts: found.message_ts,
        event: { ...event.data.event, files: found.files },
      },
    };
  }
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
    `${base}${path}`,
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
