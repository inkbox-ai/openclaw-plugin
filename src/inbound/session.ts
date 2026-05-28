import { verifyWebhook } from "@inkbox/sdk";
import type {
  AgentIdentity,
  Contact,
  MailWebhookPayload,
  PhoneIncomingCallWebhookPayload,
  TextWebhookPayload,
} from "@inkbox/sdk";
import type { InkboxWebSocket, InkboxWsHandler } from "@inkbox/sdk/tunnels/connect";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import {
  buildRealtimeVoiceAgentConsultChatMessage,
  buildRealtimeVoiceAgentConsultPolicyInstructions,
  createRealtimeVoiceBridgeSession,
  REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
  REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
  resolveConfiguredRealtimeVoiceProvider,
  resolveRealtimeVoiceAgentConsultToolPolicy,
  resolveRealtimeVoiceAgentConsultTools,
  type RealtimeVoiceBridgeSession,
  type RealtimeVoiceToolCallEvent,
  type RealtimeVoiceTool,
} from "openclaw/plugin-sdk/realtime-voice";
import type { InkboxRuntime, PluginLogger } from "../client.js";
import type { ResolvedInkboxAccount } from "../accounts.js";
import {
  consumeOutboundCallContextFromUrl,
  type OutboundCallContext,
} from "../outbound-call-context.js";
import type { InboundCallDecision, InboundHandlers } from "./dispatch.js";

type ChannelRuntime = any;

type InboundMode = "email" | "sms" | "voice" | "warmup";

type ContactSummary = {
  id?: string;
  name?: string;
  emails?: string[];
  phones?: string[];
  company?: string | null;
  jobTitle?: string | null;
  notes?: string | null;
};

type InkboxInboundTurn = {
  mode: InboundMode;
  contactKey: string;
  contact?: ContactSummary;
  fromLabel: string;
  remoteAddress?: string;
  localAddress?: string;
  subject?: string;
  body: string;
  messageId: string;
  replyToId?: string;
  threadId?: string;
  timestamp?: number;
  raw: unknown;
};

type ActiveCall = {
  callId: string;
  contactKey: string;
  remotePhoneNumber?: string;
  ws: InkboxWebSocket;
  sequence: number;
  keys: string[];
};

type VoiceTranscriptSegment = {
  text: string;
  turnId: string;
  receivedAt: number;
};

type RealtimeTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

type RealtimePostCallAction = {
  id: string;
  action: string;
  details?: string;
  requestedBy?: string;
  createdAt: number;
};

type RealtimeAgentIdentityInfo = {
  handle?: string;
  id?: string;
  displayName?: string | null;
  emailAddress?: string | null;
  phoneNumber?: string | null;
  phoneNumberId?: string | null;
  phoneNumberType?: string | null;
  smsStatus?: string | null;
  tunnelPublicHost?: string | null;
};

type RealtimeCallMeta = {
  callId: string;
  remotePhoneNumber: string;
  direction: string;
  agentIdentity: RealtimeAgentIdentityInfo;
  contact?: ContactSummary;
  contactKey: string;
  fromLabel: string;
  outboundContext?: OutboundCallContext;
};

export interface InkboxSessionBridgeOptions {
  cfg: unknown;
  account: ResolvedInkboxAccount;
  runtime: InkboxRuntime;
  channelRuntime?: ChannelRuntime;
  logger?: PluginLogger;
  getCallWebsocketUrl?: () => string | undefined;
}

export interface InkboxSessionBridge {
  handlers: InboundHandlers;
  wsHandler: InkboxWsHandler;
  activeCalls: Map<string, ActiveCall>;
}

export interface ConfigureIdentityDeliveryOptions {
  runtime: InkboxRuntime;
  webhookUrl: string;
  callWebhookUrl?: string;
  callWebsocketUrl?: string;
  logger?: PluginLogger;
}

const DEFAULT_VOICE_TRANSCRIPT_COALESCE_MS = 1200;
const DEFAULT_VOICE_AGENT_PREWARM_TTL_MS = 10 * 60 * 1000;
const DEFAULT_VOICE_AGENT_PREWARM_TIMEOUT_MS = 70 * 1000;
const TELEPHONY_CHUNK_BYTES = 160;
const TELEPHONY_CHUNK_MS = 20;
const REALTIME_AUDIO_START_BUFFER_CHUNKS = 8;
const REALTIME_AUDIO_MAX_START_BUFFER_MS = 160;
const REALTIME_AUDIO_STALE_CLOCK_MS = TELEPHONY_CHUNK_MS * 2;
const REALTIME_POST_CALL_ACTION_TOOL_NAME = "inkbox_register_post_call_action";
const REALTIME_SPEECH_RMS_THRESHOLD = 0.035;
const REALTIME_REQUIRED_LOUD_CHUNKS = 4;
const REALTIME_REQUIRED_QUIET_CHUNKS = 12;
const MULAW_LINEAR_SAMPLES = new Int16Array(256);

for (let i = 0; i < MULAW_LINEAR_SAMPLES.length; i += 1) {
  MULAW_LINEAR_SAMPLES[i] = decodeMulawSample(i);
}

const voiceAgentPrewarmState = new Map<
  string,
  {
    promise?: Promise<void>;
    lastCompletedAt?: number;
  }
>();

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
}

function decodeMulawSample(value: number): number {
  const muLaw = ~value & 255;
  const sign = muLaw & 128;
  const exponent = (muLaw >> 4) & 7;
  let sample = (((muLaw & 15) << 3) + 132) << exponent;
  sample -= 132;
  return sign ? -sample : sample;
}

function calculateMulawRms(muLaw: Buffer): number {
  if (muLaw.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const byte of muLaw) {
    const normalized = (MULAW_LINEAR_SAMPLES[byte] ?? 0) / 32768;
    sum += normalized * normalized;
  }
  return Math.sqrt(sum / muLaw.length);
}

class RealtimeMulawSpeechStartDetector {
  private loudChunks = 0;
  private quietChunks = REALTIME_REQUIRED_QUIET_CHUNKS;
  private speaking = false;

  accept(muLaw: Buffer): boolean {
    if (calculateMulawRms(muLaw) >= REALTIME_SPEECH_RMS_THRESHOLD) {
      this.quietChunks = 0;
      this.loudChunks += 1;
      if (!this.speaking && this.loudChunks >= REALTIME_REQUIRED_LOUD_CHUNKS) {
        this.speaking = true;
        return true;
      }
      return false;
    }

    this.loudChunks = 0;
    this.quietChunks += 1;
    if (this.quietChunks >= REALTIME_REQUIRED_QUIET_CHUNKS) {
      this.speaking = false;
    }
    return false;
  }
}

export class InkboxRealtimeAudioPacer {
  private queue: Array<Buffer | "done"> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private draining = false;
  private queuedAudioBytes = 0;
  private started = false;
  private bufferingSince = 0;
  private nextSendAt = 0;

  constructor(
    private readonly send: (payload: Record<string, unknown>) => Promise<void>,
    private readonly streamId: () => string | undefined,
  ) {}

  get hasQueuedAudio(): boolean {
    return this.queuedAudioBytes > 0;
  }

  sendAudio(audio: Buffer): void {
    if (this.closed || audio.length === 0) {
      return;
    }
    for (let offset = 0; offset < audio.length; offset += TELEPHONY_CHUNK_BYTES) {
      const chunk = Buffer.from(audio.subarray(offset, offset + TELEPHONY_CHUNK_BYTES));
      this.queue.push(chunk);
      this.queuedAudioBytes += chunk.length;
    }
    this.pump();
  }

  sendAudioDone(): void {
    if (this.closed) {
      return;
    }
    this.queue.push("done");
    if (this.timer && !this.started) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.pump();
  }

  clearAudio(): void {
    if (this.closed) {
      return;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.queuedAudioBytes = 0;
    this.started = false;
    this.bufferingSince = 0;
    this.nextSendAt = 0;
    void this.send({ event: "clear" }).catch(() => {});
  }

  close(): void {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.queue = [];
    this.queuedAudioBytes = 0;
    this.draining = false;
    this.started = false;
    this.bufferingSince = 0;
    this.nextSendAt = 0;
  }

  private countQueuedAudioChunks(): number {
    let chunks = 0;
    for (const item of this.queue) {
      if (item !== "done") {
        chunks += 1;
      }
    }
    return chunks;
  }

  private hasQueuedAudioDone(): boolean {
    return this.queue.includes("done");
  }

  private pump(): void {
    if (this.closed || this.draining || this.timer || this.queue.length === 0) {
      return;
    }
    if (!this.started) {
      const audioChunks = this.countQueuedAudioChunks();
      if (
        audioChunks > 0 &&
        audioChunks < REALTIME_AUDIO_START_BUFFER_CHUNKS &&
        !this.hasQueuedAudioDone()
      ) {
        this.bufferingSince ||= Date.now();
        if (Date.now() - this.bufferingSince >= REALTIME_AUDIO_MAX_START_BUFFER_MS) {
          this.started = true;
          this.nextSendAt = Date.now();
        } else {
          this.timer = setTimeout(() => {
            this.timer = undefined;
            this.pump();
          }, TELEPHONY_CHUNK_MS);
          return;
        }
      } else {
        this.started = true;
        this.nextSendAt = Date.now();
      }
      this.bufferingSince = 0;
    }
    const now = Date.now();
    if (this.nextSendAt > now) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, this.nextSendAt - now);
      return;
    }
    if (now - this.nextSendAt > REALTIME_AUDIO_STALE_CLOCK_MS) {
      this.nextSendAt = now;
    }
    this.draining = true;
    void this.drainDue(1)
      .catch(() => {})
      .finally(() => {
        this.draining = false;
        this.pump();
      });
  }

  private async drainDue(maxChunks: number): Promise<void> {
    let sentChunks = 0;
    while (!this.closed && sentChunks < maxChunks && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) {
        return;
      }
      if (item === "done") {
        const message: Record<string, unknown> = { event: "audio_done" };
        const streamId = this.streamId();
        if (streamId) {
          message.stream_id = streamId;
        }
        await this.send(message);
        this.started = false;
        this.nextSendAt = 0;
        continue;
      }

      this.queuedAudioBytes = Math.max(0, this.queuedAudioBytes - item.length);
      const message: Record<string, unknown> = {
        event: "media",
        media: {
          payload: item.toString("base64"),
          track: "outbound",
        },
      };
      const streamId = this.streamId();
      if (streamId) {
        message.stream_id = streamId;
      }
      await this.send(message);
      sentChunks += 1;
      this.nextSendAt += TELEPHONY_CHUNK_MS;
    }
    if (!this.closed && this.queue.length > 0) {
      const delay = Math.max(0, this.nextSendAt - Date.now());
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.pump();
      }, delay);
    } else if (!this.closed) {
      this.started = false;
      this.bufferingSince = 0;
      this.nextSendAt = 0;
    }
  }
}

function contactSummary(
  contact: Contact | ContactSummary | null | undefined,
): ContactSummary | undefined {
  if (!contact) {
    return undefined;
  }
  const c = contact as Contact;
  const fallback = contact as ContactSummary;
  const name =
    c.preferredName ||
    [c.givenName, c.familyName].filter(Boolean).join(" ").trim() ||
    fallback.name ||
    undefined;
  return {
    id: c.id ?? fallback.id,
    name,
    company: c.companyName ?? fallback.company,
    jobTitle: c.jobTitle ?? fallback.jobTitle,
    notes: c.notes ?? fallback.notes,
    emails: Array.isArray(c.emails)
      ? c.emails.map((entry) => entry.value).filter(Boolean)
      : fallback.emails,
    phones: Array.isArray(c.phones)
      ? c.phones.map((entry) => entry.value).filter(Boolean)
      : fallback.phones,
  };
}

function webhookContactSummary(contact: { id: string; name: string } | null | undefined) {
  return contact ? { id: contact.id, name: contact.name } : undefined;
}

function renderContactMarker(contact: ContactSummary | undefined): string {
  if (!contact?.id) {
    return "contact=unknown_in_inkbox";
  }
  const parts = [`contact_id=${contact.id}`];
  if (contact.name) {
    parts.push(`contact_name=${JSON.stringify(contact.name)}`);
  }
  if (contact.company) {
    parts.push(`contact_company=${JSON.stringify(contact.company)}`);
  }
  if (contact.jobTitle) {
    parts.push(`contact_job_title=${JSON.stringify(contact.jobTitle)}`);
  }
  if (contact.emails?.length) {
    parts.push(`contact_emails=${contact.emails.join(",")}`);
  }
  if (contact.phones?.length) {
    parts.push(`contact_phones=${contact.phones.join(",")}`);
  }
  if (contact.notes) {
    parts.push(`contact_notes=${JSON.stringify(contact.notes)}`);
  }
  return parts.join(" ");
}

function renderIdentityMarker(account: ResolvedInkboxAccount): string {
  const identity = account.config.identity?.trim();
  return identity ? ` inkbox_identity=${identity}` : "";
}

function defaultAgentIdentityInfo(account: ResolvedInkboxAccount): RealtimeAgentIdentityInfo {
  return {
    handle: account.config.identity?.trim() || account.identity,
  };
}

function agentIdentityInfoFromIdentity(identity: AgentIdentity): RealtimeAgentIdentityInfo {
  return {
    handle: identity.agentHandle,
    id: identity.id,
    displayName: identity.displayName,
    emailAddress: identity.mailbox?.emailAddress ?? identity.emailAddress ?? null,
    phoneNumber: identity.phoneNumber?.number ?? null,
    phoneNumberId: identity.phoneNumber?.id ?? null,
    phoneNumberType: identity.phoneNumber?.type ?? null,
    smsStatus: identity.phoneNumber?.smsStatus ? String(identity.phoneNumber.smsStatus) : null,
    tunnelPublicHost: identity.tunnel?.publicHost ?? null,
  };
}

function renderAgentIdentityLines(identity: RealtimeAgentIdentityInfo): string[] {
  const lines = [
    identity.handle ? `Your Inkbox identity handle: ${identity.handle}.` : undefined,
    identity.displayName ? `Your Inkbox display name: ${identity.displayName}.` : undefined,
    identity.emailAddress ? `Your Inkbox agent email address: ${identity.emailAddress}.` : undefined,
    identity.phoneNumber ? `Your Inkbox agent phone number: ${identity.phoneNumber}.` : undefined,
    identity.tunnelPublicHost ? `Your Inkbox tunnel host: ${identity.tunnelPublicHost}.` : undefined,
  ].filter((line): line is string => Boolean(line));
  if (identity.emailAddress || identity.phoneNumber) {
    lines.push(
      "If the caller asks for your agent email address, phone number, handle, or full Inkbox identity, answer from the fields above. Do not deny that you have an agent email or phone number.",
    );
  }
  return lines;
}

async function hydrateContact(
  runtime: InkboxRuntime,
  summary: ContactSummary | undefined,
): Promise<ContactSummary | undefined> {
  if (!summary?.id) {
    return summary;
  }
  try {
    const inkbox = await runtime.getClient();
    return contactSummary(await inkbox.contacts.get(summary.id));
  } catch {
    return summary;
  }
}

async function lookupContact(
  runtime: InkboxRuntime,
  kind: "email" | "phone",
  value: string,
): Promise<ContactSummary | undefined> {
  try {
    const inkbox = await runtime.getClient();
    const matches = await inkbox.contacts.lookup(
      kind === "email" ? { email: value } : { phone: value },
    );
    if (matches.length === 1) {
      return contactSummary(matches[0]);
    }
  } catch {
    // Missing contact lookup is not fatal; the raw address becomes the session key.
  }
  return undefined;
}

function textMediaMarkers(
  media: NonNullable<TextWebhookPayload["data"]["text_message"]["media"]> | null,
): string[] {
  if (!media?.length) {
    return [];
  }
  return media.map((item, index) => {
    const contentType = item.content_type || "application/octet-stream";
    const size = typeof item.size === "number" ? ` size=${item.size}` : "";
    return `[inkbox:mms_attachment index=${index + 1} content_type=${contentType}${size} url=${item.url}]`;
  });
}

function isSmsControlWord(text: string): boolean {
  const normalized = text.trim().toUpperCase();
  return ["START", "STOP", "UNSTOP", "HELP"].includes(normalized);
}

function payloadText(payload: unknown): string {
  if (typeof payload === "string") {
    return payload;
  }
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.text === "string") {
      return record.text;
    }
    if (typeof record.body === "string") {
      return record.body;
    }
  }
  return "";
}

function activeCallKeys(
  input: {
    callId?: string;
    contactKey?: string;
    remotePhoneNumber?: string;
  },
): string[] {
  return Array.from(
    new Set(
      [input.contactKey, input.callId, input.remotePhoneNumber]
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
}

function registerActiveCall(
  activeCalls: Map<string, ActiveCall>,
  active: ActiveCall,
): void {
  for (const key of active.keys) {
    activeCalls.set(key, active);
  }
}

function unregisterActiveCall(
  activeCalls: Map<string, ActiveCall>,
  active: ActiveCall,
): void {
  for (const key of active.keys) {
    if (activeCalls.get(key) === active) {
      activeCalls.delete(key);
    }
  }
}

function callIdFromTurn(turn: InkboxInboundTurn): string | undefined {
  const candidate = [turn.messageId, turn.threadId].find((value) => value?.startsWith("call:"));
  if (!candidate) {
    return undefined;
  }
  const [, callId] = candidate.split(":");
  return callId || undefined;
}

function sessionKeySegment(value: string | undefined): string {
  const normalized = value?.trim().replace(/[^A-Za-z0-9_.-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized || "unknown";
}

function voiceSessionKey(agentId: string, turn: InkboxInboundTurn): string {
  return `agent:${agentId}:inkbox:call:${sessionKeySegment(callIdFromTurn(turn) ?? turn.contactKey)}`;
}

function findActiveCall(
  activeCalls: Map<string, ActiveCall>,
  turn: InkboxInboundTurn,
): ActiveCall | undefined {
  const callId = callIdFromTurn(turn);
  for (const key of activeCallKeys({
    contactKey: turn.contactKey,
    remotePhoneNumber: turn.remoteAddress,
    callId,
  })) {
    const call = activeCalls.get(key);
    if (call) {
      return call;
    }
  }
  return undefined;
}

async function sendVoiceText(
  call: ActiveCall,
  text: string,
  turnId: string,
): Promise<void> {
  call.sequence += 1;
  await call.ws.send(
    JSON.stringify({
      event: "text",
      delta: text,
      turn_id: turnId,
      sequence: call.sequence,
    }),
  );
  call.sequence += 1;
  await call.ws.send(
    JSON.stringify({
      event: "text",
      done: true,
      turn_id: turnId,
      sequence: call.sequence,
    }),
  );
}

async function deliverReply(
  params: {
    turn: InkboxInboundTurn;
    text: string;
    runtime: InkboxRuntime;
    activeCalls: Map<string, ActiveCall>;
    logger?: PluginLogger;
  },
): Promise<string | undefined> {
  const text = params.text.trim();
  if (!text || text.toUpperCase() === "[SILENT]") {
    return undefined;
  }
  if (params.turn.mode === "warmup") {
    return undefined;
  }
  if (params.turn.mode === "voice") {
    const call = findActiveCall(params.activeCalls, params.turn);
    if (!call) {
      params.logger?.warn?.("Inkbox voice reply dropped; no active call WebSocket matched.");
      return undefined;
    }
    const turnId = params.turn.replyToId ?? params.turn.messageId;
    await sendVoiceText(call, text, turnId);
    params.logger?.info?.(
      `Inkbox voice TTS sent: call_id=${call.callId} turn_id=${turnId} chars=${text.length}`,
    );
    return undefined;
  }

  const identity = await params.runtime.getIdentity();
  if (params.turn.mode === "sms") {
    if (!params.turn.remoteAddress) {
      throw new Error("Inkbox SMS reply missing remote phone number.");
    }
    const msg = await identity.sendText({
      to: params.turn.remoteAddress,
      text,
    });
    return msg.id;
  }

  if (!params.turn.remoteAddress) {
    throw new Error("Inkbox email reply missing remote email address.");
  }
  const subject = params.turn.subject
    ? params.turn.subject.toLowerCase().startsWith("re:")
      ? params.turn.subject
      : `Re: ${params.turn.subject}`
    : "(no subject)";
  const msg = await identity.sendEmail({
    to: [params.turn.remoteAddress],
    subject,
    bodyText: text,
    inReplyToMessageId: params.turn.replyToId,
  });
  return msg.id;
}

function mergeVoiceTranscriptSegments(segments: VoiceTranscriptSegment[]): string {
  return segments.map((segment) => segment.text).join("\n");
}

function lastVoiceTranscriptTurnId(segments: VoiceTranscriptSegment[]): string {
  return segments[segments.length - 1]?.turnId ?? `${Date.now()}`;
}

function resolveVoiceTranscriptCoalesceMs(account: ResolvedInkboxAccount): number {
  const raw = account.config.voiceTranscriptCoalesceMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_VOICE_TRANSCRIPT_COALESCE_MS;
}

function isVoiceRealtimeEnabled(account: ResolvedInkboxAccount): boolean {
  return account.config.voiceRealtime?.enabled === true;
}

function shouldFallbackToInkboxSttTts(account: ResolvedInkboxAccount): boolean {
  return account.config.voiceRealtime?.fallbackToInkboxSttTts !== false;
}

function resolveRealtimeConfig(account: ResolvedInkboxAccount) {
  const config = account.config.voiceRealtime ?? {};
  return {
    provider: config.provider,
    model: config.model,
    voice: config.voice,
    instructions: config.instructions,
    providers: config.providers,
    toolPolicy: resolveRealtimeVoiceAgentConsultToolPolicy(config.toolPolicy, "owner"),
    consultPolicy: config.consultPolicy ?? "substantive",
  };
}

function renderRealtimeContactInfo(contact: ContactSummary | undefined): string | undefined {
  if (!contact) {
    return undefined;
  }
  return [
    contact.name ? `name=${contact.name}` : undefined,
    contact.id ? `inkbox_contact_id=${contact.id}` : undefined,
    contact.company ? `company=${contact.company}` : undefined,
    contact.jobTitle ? `job_title=${contact.jobTitle}` : undefined,
    contact.emails?.length ? `emails=${contact.emails.join(", ")}` : undefined,
    contact.phones?.length ? `phones=${contact.phones.join(", ")}` : undefined,
    contact.notes ? `notes=${contact.notes}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");
}

function realtimePostCallActionTool(): RealtimeVoiceTool {
  return {
    type: "function",
    name: REALTIME_POST_CALL_ACTION_TOOL_NAME,
    description:
      "Register work the main OpenClaw Inkbox agent must do after this phone call ends, such as sending an email/SMS follow-up, creating a note, or updating a contact. Use this instead of claiming you sent something yourself.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description:
            "Plain-English task for the main agent to perform after the call. Include the requested channel, recipient, and outcome.",
        },
        details: {
          type: "string",
          description:
            "Optional extra details, draft text, recipient hints, or constraints from the call.",
        },
        requestedBy: {
          type: "string",
          description: "Optional short label for who requested this action.",
        },
      },
      required: ["action"],
    },
  };
}

function buildRealtimeInstructions(
  account: ResolvedInkboxAccount,
  meta: RealtimeCallMeta,
): string {
  const config = resolveRealtimeConfig(account);
  const policyInstructions = buildRealtimeVoiceAgentConsultPolicyInstructions({
    toolPolicy: config.toolPolicy,
    consultPolicy: config.consultPolicy,
  });
  const contactInfo = renderRealtimeContactInfo(meta.contact);
  return [
    "You are the configured OpenClaw agent speaking on a live Inkbox phone call.",
    "Use natural, concise spoken replies. Keep most answers to one or two short sentences.",
    "Do not mention implementation details unless the caller asks.",
    ...renderAgentIdentityLines(meta.agentIdentity),
    meta.remotePhoneNumber ? `Caller phone number: ${meta.remotePhoneNumber}.` : undefined,
    meta.contact?.name ? `Caller contact name: ${meta.contact.name}.` : undefined,
    contactInfo
      ? `Known Inkbox contact info is already loaded: ${contactInfo}`
      : "No matching Inkbox contact record is loaded; use the phone number or a neutral greeting.",
    "Do not perform a context lookup before greeting or identifying the caller. Do not say you are waiting for context, waiting on a lookup, or checking context.",
    "For contact identity at call start, use only the Inkbox identity, phone number, and known contact info above.",
    meta.outboundContext?.purpose
      ? `This is an outbound call you placed. Purpose: ${meta.outboundContext.purpose}`
      : undefined,
    meta.outboundContext?.openingMessage
      ? `Preferred opening message: ${meta.outboundContext.openingMessage}`
      : undefined,
    meta.outboundContext?.context
      ? `Relevant outbound-call context:\n${meta.outboundContext.context}`
      : undefined,
    meta.outboundContext
      ? "For outbound calls, do not open with a generic offer to help. Start by explaining why you are calling, then ask the next specific question or give the requested update."
      : undefined,
    `If the caller asks for work to happen after the call, call ${REALTIME_POST_CALL_ACTION_TOOL_NAME}. Tell the caller the action is queued for after the call; do not claim it has already been completed.`,
    "Call openclaw_agent_consult only after the caller asks for contact edits, notes, email/SMS/call-history reads, workspace/memory/current-info, or other tool work that must happen during the call.",
    "Do not call openclaw_agent_consult just to greet, identify yourself, identify the caller, or fill call-start context.",
    config.instructions,
    policyInstructions,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildRealtimeGreeting(meta: RealtimeCallMeta): string {
  const name = meta.contact?.name?.split(/\s+/)[0] || "there";
  if (meta.outboundContext?.openingMessage) {
    return [
      `Greet ${name} briefly, then say this opening message naturally:`,
      meta.outboundContext.openingMessage,
      "Do not ask a generic how-can-I-help question.",
    ].join("\n");
  }
  if (meta.outboundContext?.purpose) {
    return [
      `Greet ${name} briefly, then immediately explain that you are calling because:`,
      meta.outboundContext.purpose,
      "Ask the next specific question or give the requested update. Do not ask a generic how-can-I-help question.",
    ].join("\n");
  }
  return `Greet ${name} in one short sentence and ask how you can help.`;
}

function buildInkboxTtsGreeting(meta: RealtimeCallMeta): string {
  const name = meta.contact?.name?.split(/\s+/)[0] || "there";
  if (meta.outboundContext?.openingMessage) {
    return `Hi ${name}. ${meta.outboundContext.openingMessage}`;
  }
  if (meta.outboundContext?.purpose) {
    return `Hi ${name}. I'm calling about ${meta.outboundContext.purpose}`;
  }
  return `Hi ${name}, how can I help?`;
}

function parseBase64AudioPayload(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const audio = Buffer.from(value, "base64");
    return audio.length > 0 ? audio : undefined;
  } catch {
    return undefined;
  }
}

function payloadMedia(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const media = record.media;
  return media && typeof media === "object" && !Array.isArray(media)
    ? (media as Record<string, unknown>)
    : undefined;
}

function payloadTimestampMs(record: Record<string, unknown>): number | undefined {
  const media = payloadMedia(record);
  const raw = media?.timestamp ?? record.timestamp_ms ?? record.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function appendRealtimeTranscript(
  entries: RealtimeTranscriptEntry[],
  entry: RealtimeTranscriptEntry,
): void {
  const text = entry.text.trim();
  if (!text) {
    return;
  }
  entries.push({ ...entry, text });
  while (entries.length > 20) {
    entries.shift();
  }
}

function renderRealtimeTranscript(entries: RealtimeTranscriptEntry[]): string {
  return entries
    .slice(-12)
    .map((entry) => `${entry.role === "assistant" ? "Agent" : "Caller"}: ${entry.text}`)
    .join("\n");
}

function resolveRealtimeProvider(opts: InkboxSessionBridgeOptions) {
  const realtime = resolveRealtimeConfig(opts.account);
  const providerConfigOverrides: Record<string, unknown> = {};
  if (realtime.model) {
    providerConfigOverrides.model = realtime.model;
  }
  if (realtime.voice) {
    providerConfigOverrides.voice = realtime.voice;
  }
  return resolveConfiguredRealtimeVoiceProvider({
    cfg: opts.cfg as any,
    configuredProviderId: realtime.provider,
    providerConfigs: realtime.providers,
    providerConfigOverrides,
    defaultModel: realtime.model,
    noRegisteredProviderMessage:
      "No realtime voice provider registered; load OpenClaw's openai plugin or configure another realtime provider.",
  });
}

function createVoiceTranscriptBuffer(params: {
  callId: string;
  coalesceMs: number;
  logger?: PluginLogger;
  dispatch: (
    segments: VoiceTranscriptSegment[],
    abortSignal: AbortSignal,
    shouldDeliverReply: () => boolean,
  ) => Promise<void>;
}) {
  let pending: VoiceTranscriptSegment[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active:
    | {
        id: number;
        segments: VoiceTranscriptSegment[];
        abortController: AbortController;
        stale: boolean;
      }
    | undefined;
  let activeSeededIntoPendingId: number | undefined;
  let nextRunId = 0;
  let chain = Promise.resolve();

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const enqueueRun = (segments: VoiceTranscriptSegment[]) => {
    chain = chain.then(async () => {
      let runSegments = segments;
      if (pending.length) {
        runSegments = [...runSegments, ...pending];
        pending = [];
        activeSeededIntoPendingId = undefined;
        clearTimer();
      }

      const abortController = new AbortController();
      const run = {
        id: ++nextRunId,
        segments: runSegments,
        abortController,
        stale: false,
      };
      active = run;
      try {
        await params.dispatch(runSegments, abortController.signal, () => {
          return active === run && !run.stale && !abortController.signal.aborted;
        });
      } catch (error) {
        if (run.stale || abortController.signal.aborted) {
          params.logger?.info?.(
            `Inkbox voice turn cancelled: call_id=${params.callId} segments=${runSegments.length}`,
          );
          return;
        }
        params.logger?.warn?.(
          `Inkbox voice turn failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (active === run) {
          active = undefined;
        }
      }
    });
    chain = chain.catch((error) => {
      params.logger?.warn?.(
        `Inkbox voice turn queue failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return chain;
  };

  const flush = async () => {
    clearTimer();
    if (!pending.length) {
      return chain;
    }
    const segments = pending;
    pending = [];
    activeSeededIntoPendingId = undefined;
    return enqueueRun(segments);
  };

  const schedule = () => {
    clearTimer();
    if (params.coalesceMs <= 0) {
      void flush();
      return;
    }
    timer = setTimeout(() => {
      void flush();
    }, params.coalesceMs);
  };

  return {
    push(segment: VoiceTranscriptSegment) {
      if (active && !active.stale) {
        active.stale = true;
        active.abortController.abort();
        if (activeSeededIntoPendingId !== active.id) {
          pending = [...active.segments, ...pending];
          activeSeededIntoPendingId = active.id;
        }
        params.logger?.info?.(
          `Inkbox voice turn superseded by newer transcript: call_id=${params.callId}`,
        );
      }
      pending.push(segment);
      schedule();
    },
    async flush() {
      await flush();
    },
    async drain() {
      await flush();
      await chain;
    },
  };
}

async function dispatchInboundTurn(
  opts: InkboxSessionBridgeOptions & {
    turn: InkboxInboundTurn;
    activeCalls: Map<string, ActiveCall>;
    dispatchAbortSignal?: AbortSignal;
    shouldDeliverReply?: () => boolean;
    deliveryOverride?: {
      deliver: (payload: unknown) => Promise<{ visibleReplySent?: boolean } | void>;
      onError?: (error: unknown) => void;
    };
    replyOptionsOverride?: Record<string, unknown>;
  },
): Promise<void> {
  const core = opts.channelRuntime;
  if (!core?.turn?.runAssembled) {
    opts.logger?.warn?.(
      "Inkbox inbound event received, but OpenClaw channelRuntime is unavailable; dropping event.",
    );
    return;
  }

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg: opts.cfg as any,
    channel: "inkbox",
    accountId: opts.account.accountId,
    peer: {
      kind: "direct" as const,
      id: opts.turn.contactKey,
    },
    runtime: core,
    sessionStore: (opts.cfg as any)?.session?.store,
  });
  const timestamp = opts.turn.timestamp ?? Date.now();
  const routeAccountId =
    (route as { accountId?: string | null }).accountId ?? opts.account.accountId;
  const baseSessionKey = route.sessionKey;
  const effectiveSessionKey =
    opts.turn.mode === "voice" ? voiceSessionKey(route.agentId, opts.turn) : baseSessionKey;
  const { storePath, body } = buildEnvelope({
    channel: "Inkbox",
    from: opts.turn.fromLabel,
    timestamp,
    body: opts.turn.body,
  });
  const ctxPayload = core.turn.buildContext({
    channel: "inkbox",
    accountId: routeAccountId,
      messageId: opts.turn.messageId,
      messageIdFull: opts.turn.messageId,
      timestamp,
      from: `inkbox:${opts.turn.mode}:${opts.turn.remoteAddress ?? opts.turn.contactKey}`,
    sender: {
      id: opts.turn.contactKey,
      name: opts.turn.contact?.name,
      displayLabel: opts.turn.fromLabel,
    },
    conversation: {
      kind: "direct",
      id: opts.turn.contactKey,
      label: opts.turn.fromLabel,
      routePeer: {
        kind: "direct",
        id: opts.turn.contactKey,
      },
    },
    route: {
      agentId: route.agentId,
      accountId: routeAccountId,
      routeSessionKey: effectiveSessionKey,
      ...(opts.turn.mode === "voice" ? { modelParentSessionKey: baseSessionKey } : {}),
    },
    reply: {
      to:
        opts.turn.mode === "voice"
          ? `inkbox-call:${callIdFromTurn(opts.turn) ?? opts.turn.contactKey}`
          : opts.turn.mode === "warmup"
            ? `inkbox-warmup:${opts.account.accountId}`
            : opts.turn.remoteAddress ?? opts.turn.contactKey,
      originatingTo:
        opts.turn.mode === "voice"
          ? `inkbox-call:${callIdFromTurn(opts.turn) ?? opts.turn.contactKey}`
          : opts.turn.mode === "warmup"
            ? `inkbox-warmup:${opts.account.accountId}`
          : opts.turn.remoteAddress ?? opts.turn.contactKey,
      replyToId: opts.turn.replyToId,
      messageThreadId: opts.turn.threadId,
    },
    message: {
      body,
      bodyForAgent: opts.turn.body,
      rawBody: opts.turn.body,
      commandBody: opts.turn.body,
      envelopeFrom: opts.turn.fromLabel,
    },
    extra: {
      CommandAuthorized: true,
      Provider: "inkbox",
      Surface: "inkbox",
      InkboxMode: opts.turn.mode,
      InkboxRemoteAddress: opts.turn.remoteAddress,
      InkboxLocalAddress: opts.turn.localAddress,
      InkboxContactId: opts.turn.contact?.id,
      MessageThreadId: opts.turn.threadId,
      InkboxVoiceReplyOnly: opts.turn.mode === "voice" ? true : undefined,
      InkboxWarmup: opts.turn.mode === "warmup" ? true : undefined,
    },
  });

  const replyOptions =
    opts.replyOptionsOverride ??
    (opts.turn.mode === "voice"
      ? {
          sourceReplyDeliveryMode: "automatic" as const,
          bootstrapContextMode: "lightweight" as const,
          fastModeOverride: true,
          thinkingLevelOverride: "minimal",
          abortSignal: opts.dispatchAbortSignal,
          skillFilter: [
            "inkbox-outbound-calling",
            "inkbox-call-review",
            "inkbox-contact-lookup",
            "inkbox-notes-memory",
            "inkbox-sms-responder",
            "inkbox-email-triage",
          ],
        }
      : undefined);
  const delivery = opts.deliveryOverride ?? {
    deliver: async (payload: unknown) => {
      const text = payloadText(payload);
      if (!text.trim()) {
        return { visibleReplySent: false };
      }
      if (opts.turn.mode === "voice" && opts.shouldDeliverReply?.() === false) {
        opts.logger?.info?.(
          `Inkbox voice reply suppressed; newer caller transcript superseded call_id=${callIdFromTurn(opts.turn) ?? "unknown"}`,
        );
        return { visibleReplySent: false };
      }
      const messageId = await deliverReply({
        turn: opts.turn,
        text,
        runtime: opts.runtime,
        activeCalls: opts.activeCalls,
        logger: opts.logger,
      });
      return {
        visibleReplySent: Boolean(messageId || opts.turn.mode === "voice"),
        ...(messageId ? { messageIds: [messageId] } : {}),
        ...(opts.turn.threadId ? { threadId: opts.turn.threadId } : {}),
        ...(opts.turn.replyToId ? { replyToId: opts.turn.replyToId } : {}),
      };
    },
    onError: (error: unknown) => {
      opts.logger?.warn?.(
        `Inkbox reply delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    },
  };
  await core.turn.runAssembled({
    cfg: opts.cfg as any,
    channel: "inkbox",
    accountId: opts.account.accountId,
    agentId: route.agentId,
    routeSessionKey: effectiveSessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: core.session.recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher:
      core.reply.dispatchReplyWithBufferedBlockDispatcher,
    ...(replyOptions ? { replyOptions } : {}),
    delivery,
    replyPipeline: {},
    record: {
      onRecordError: (error: unknown) => {
        opts.logger?.warn?.(
          `Inkbox session record failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    },
  });
}

async function runRealtimeAgentConsult(
  opts: InkboxSessionBridgeOptions & {
    activeCalls: Map<string, ActiveCall>;
    meta: RealtimeCallMeta;
    toolEvent: RealtimeVoiceToolCallEvent;
    transcript: RealtimeTranscriptEntry[];
  },
): Promise<Record<string, unknown>> {
  let requestText: string;
  try {
    requestText = buildRealtimeVoiceAgentConsultChatMessage(opts.toolEvent.args);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const recentTranscript = renderRealtimeTranscript(opts.transcript);
  const visibleText: string[] = [];
  await dispatchInboundTurn({
    ...opts,
    activeCalls: opts.activeCalls,
    replyOptionsOverride: {
      sourceReplyDeliveryMode: "automatic",
      bootstrapContextMode: "lightweight",
      fastModeOverride: true,
      thinkingLevelOverride: "minimal",
      suppressDefaultToolProgressMessages: true,
    },
    deliveryOverride: {
      deliver: async (payload: unknown) => {
        const text = payloadText(payload).trim();
        if (text) {
          visibleText.push(text);
        }
        return { visibleReplySent: false };
      },
      onError: (error: unknown) => {
        opts.logger?.warn?.(
          `Inkbox realtime consult delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    },
    turn: {
      mode: "voice",
      contactKey: opts.meta.contactKey,
      contact: opts.meta.contact,
      fromLabel: opts.meta.fromLabel,
      remoteAddress: opts.meta.remotePhoneNumber,
      body: [
        `[inkbox:voice_realtime_consult call_id=${opts.meta.callId}${renderIdentityMarker(opts.account)} | ${renderContactMarker(opts.meta.contact)}]`,
        requestText,
        recentTranscript ? `Recent live-call transcript:\n${recentTranscript}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      messageId: `call:${opts.meta.callId}:realtime-tool:${opts.toolEvent.callId}`,
      replyToId: opts.toolEvent.callId,
      threadId: opts.meta.direction === "outbound" ? undefined : `call:${opts.meta.callId}`,
      timestamp: Date.now(),
      raw: {
        event: "realtime_tool_call",
        tool: opts.toolEvent.name,
        args: opts.toolEvent.args,
      },
    },
  });

  const result = visibleText.join("\n\n").trim();
  return {
    status: "ok",
    result: result || "OpenClaw completed the consult but returned no speakable text.",
  };
}

function readPostCallStringArg(args: unknown, key: string): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }
  const value = (args as Record<string, unknown>)[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function registerRealtimePostCallAction(
  actions: RealtimePostCallAction[],
  toolEvent: RealtimeVoiceToolCallEvent,
): Record<string, unknown> {
  const action =
    readPostCallStringArg(toolEvent.args, "action") ??
    readPostCallStringArg(toolEvent.args, "task") ??
    readPostCallStringArg(toolEvent.args, "summary");
  if (!action) {
    return { error: "action required" };
  }
  const value: RealtimePostCallAction = {
    id: toolEvent.callId || toolEvent.itemId || `${Date.now()}`,
    action,
    details: readPostCallStringArg(toolEvent.args, "details"),
    requestedBy: readPostCallStringArg(toolEvent.args, "requestedBy"),
    createdAt: Date.now(),
  };
  actions.push(value);
  return {
    status: "registered",
    actionId: value.id,
    message:
      "Post-call action registered. Tell the caller it is queued for after the call, not completed yet.",
  };
}

function realtimeAgentConsultWorkingResponse(): Record<string, unknown> {
  return {
    status: "working",
    tool: REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME,
    message:
      "If you need to acknowledge the caller, say only 'One moment.' Do not mention context lookup, waiting for context, or checking context.",
  };
}

function renderPostCallActions(actions: RealtimePostCallAction[]): string {
  return actions
    .map((action, index) =>
      [
        `${index + 1}. ${action.action}`,
        action.details ? `Details: ${action.details}` : undefined,
        action.requestedBy ? `Requested by: ${action.requestedBy}` : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

async function runRealtimePostCallActions(
  opts: InkboxSessionBridgeOptions & {
    activeCalls: Map<string, ActiveCall>;
    meta: RealtimeCallMeta;
    transcript: RealtimeTranscriptEntry[];
    actions: RealtimePostCallAction[];
  },
): Promise<void> {
  if (opts.actions.length === 0) {
    return;
  }
  const recentTranscript = renderRealtimeTranscript(opts.transcript);
  const visibleText: string[] = [];
  await dispatchInboundTurn({
    ...opts,
    activeCalls: opts.activeCalls,
    replyOptionsOverride: {
      sourceReplyDeliveryMode: "automatic",
      bootstrapContextMode: "lightweight",
      fastModeOverride: true,
      thinkingLevelOverride: "minimal",
      suppressDefaultToolProgressMessages: true,
    },
    deliveryOverride: {
      deliver: async (payload: unknown) => {
        const text = payloadText(payload).trim();
        if (text) {
          visibleText.push(text);
        }
        return { visibleReplySent: false };
      },
      onError: (error: unknown) => {
        opts.logger?.warn?.(
          `Inkbox realtime post-call delivery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    },
    turn: {
      mode: "sms",
      contactKey: opts.meta.contactKey,
      contact: opts.meta.contact,
      fromLabel: opts.meta.fromLabel,
      remoteAddress: opts.meta.remotePhoneNumber,
      body: [
        `[inkbox:voice_post_call_actions call_id=${opts.meta.callId}${renderIdentityMarker(opts.account)} | ${renderContactMarker(opts.meta.contact)}]`,
        "The realtime voice call ended. Execute these post-call actions now using Inkbox tools where appropriate.",
        "Do not merely say they are impossible. If an email/SMS/note/contact update was requested and enough recipient/content info is present, perform it.",
        "Do not send a confirmation follow-up after successful work unless the caller explicitly requested one.",
        "Only if required information is missing, ask the caller for the missing information. Try SMS first; if SMS is unavailable or not opted in, try email; if email is unavailable, place a follow-up call with the question.",
        renderPostCallActions(opts.actions),
        recentTranscript ? `Recent live-call transcript:\n${recentTranscript}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
      messageId: `call:${opts.meta.callId}:post-call-actions`,
      replyToId: opts.meta.callId,
      threadId: opts.meta.direction === "outbound" ? undefined : `call:${opts.meta.callId}`,
      timestamp: Date.now(),
      raw: {
        event: "realtime_post_call_actions",
        actions: opts.actions,
      },
    },
  });
  opts.logger?.info?.(
    `Inkbox realtime post-call actions dispatched: call_id=${opts.meta.callId} actions=${opts.actions.length} captured_reply_chars=${visibleText.join("\n").length}`,
  );
}

function handleRealtimeToolCall(
  opts: InkboxSessionBridgeOptions & {
    activeCalls: Map<string, ActiveCall>;
    meta: RealtimeCallMeta;
    session: RealtimeVoiceBridgeSession;
    toolEvent: RealtimeVoiceToolCallEvent;
    transcript: RealtimeTranscriptEntry[];
    postCallActions: RealtimePostCallAction[];
  },
): void {
  const callId = opts.toolEvent.callId || opts.toolEvent.itemId;
  if (opts.toolEvent.name === REALTIME_POST_CALL_ACTION_TOOL_NAME) {
    opts.session.submitToolResult(
      callId,
      registerRealtimePostCallAction(opts.postCallActions, opts.toolEvent),
    );
    return;
  }
  if (opts.toolEvent.name !== REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME) {
    opts.session.submitToolResult(callId, {
      error: `Tool "${opts.toolEvent.name}" is not available in Inkbox realtime calls.`,
    });
    return;
  }

  const hasUserTranscript = opts.transcript.some((entry) => entry.role === "user");
  if (!hasUserTranscript) {
    opts.session.submitToolResult(callId, {
      status: "not_needed",
      result:
        "Use the already-loaded Inkbox identity, phone number, and contact metadata. Do not say you are waiting on a context lookup.",
    });
    return;
  }

  try {
    if (opts.session.bridge.supportsToolResultContinuation) {
      opts.session.submitToolResult(
        callId,
        realtimeAgentConsultWorkingResponse(),
        { willContinue: true },
      );
    }
  } catch {
    // Continuation is an optimization; the final tool result is authoritative.
  }

  void runRealtimeAgentConsult(opts)
    .then((result) => {
      opts.session.submitToolResult(callId, result);
    })
    .catch((error) => {
      opts.session.submitToolResult(callId, {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

function prewarmStateKey(account: ResolvedInkboxAccount): string {
  return `${account.accountId}:${account.config.identity ?? ""}`;
}

function resolveVoiceAgentPrewarmTtlMs(account: ResolvedInkboxAccount): number {
  const raw = account.config.voiceAgentPrewarmTtlMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : DEFAULT_VOICE_AGENT_PREWARM_TTL_MS;
}

function resolveVoiceAgentPrewarmTimeoutMs(account: ResolvedInkboxAccount): number {
  const raw = account.config.voiceAgentPrewarmTimeoutMs;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_VOICE_AGENT_PREWARM_TIMEOUT_MS;
}

export async function prewarmInkboxAgent(
  opts: InkboxSessionBridgeOptions & {
    reason?: string;
  },
): Promise<void> {
  const core = opts.channelRuntime;
  if (!core?.turn?.runAssembled || opts.account.config.voiceAgentPrewarm === false) {
    return;
  }

  const key = prewarmStateKey(opts.account);
  const state = voiceAgentPrewarmState.get(key) ?? {};
  const now = Date.now();
  const ttlMs = resolveVoiceAgentPrewarmTtlMs(opts.account);
  if (state.promise) {
    try {
      await state.promise;
    } catch {
      // The owning warmup call logs the failure; callers joining an in-flight
      // warmup should not surface an unhandled rejection.
    }
    return;
  }
  if (state.lastCompletedAt && ttlMs > 0 && now - state.lastCompletedAt < ttlMs) {
    return;
  }

  const startedAt = Date.now();
  const abortController = new AbortController();
  const timeoutMs = resolveVoiceAgentPrewarmTimeoutMs(opts.account);
  const timeout = setTimeout(() => {
    abortController.abort("inkbox voice agent prewarm timed out");
  }, timeoutMs);
  const nextState = { ...state };
  const promise = (async () => {
    const reason = opts.reason?.trim() || "gateway-start";
    opts.logger?.info?.(
      `Inkbox voice agent prewarm started: account=${opts.account.accountId} reason=${reason}`,
    );
    await dispatchInboundTurn({
      ...opts,
      activeCalls: new Map(),
      dispatchAbortSignal: abortController.signal,
      replyOptionsOverride: {
        sourceReplyDeliveryMode: "automatic",
        bootstrapContextMode: "lightweight",
        fastModeOverride: true,
        thinkingLevelOverride: "minimal",
        abortSignal: abortController.signal,
        suppressDefaultToolProgressMessages: true,
        skillFilter: ["inkbox-call-review"],
      },
      deliveryOverride: {
        deliver: async () => ({ visibleReplySent: false }),
        onError: (error: unknown) => {
          opts.logger?.warn?.(
            `Inkbox voice agent prewarm delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
      turn: {
        mode: "warmup",
        contactKey: `__inkbox_warmup__:${opts.account.accountId}`,
        fromLabel: "Inkbox voice warmup",
        body:
          `[inkbox:warmup account_id=${opts.account.accountId}${renderIdentityMarker(opts.account)} reason=${JSON.stringify(reason)}]\n` +
          `Warm up the Inkbox voice-call agent path. Reply with exactly "[SILENT]". Do not use tools and do not contact the user.`,
        messageId: `inkbox-warmup:${opts.account.accountId}:${startedAt}`,
        threadId: `inkbox-warmup:${opts.account.accountId}`,
        timestamp: startedAt,
        raw: { event: "inkbox.voice_agent_prewarm", reason },
      },
    });
    nextState.lastCompletedAt = Date.now();
    opts.logger?.info?.(
      `Inkbox voice agent prewarm completed: account=${opts.account.accountId} duration_ms=${Date.now() - startedAt}`,
    );
  })();

  nextState.promise = promise;
  voiceAgentPrewarmState.set(key, nextState);
  try {
    await promise;
  } catch (error) {
    opts.logger?.warn?.(
      `Inkbox voice agent prewarm failed: account=${opts.account.accountId} error=${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    clearTimeout(timeout);
    const current = voiceAgentPrewarmState.get(key);
    if (current?.promise === promise) {
      delete current.promise;
      voiceAgentPrewarmState.set(key, current);
    }
  }
}

async function buildMailTurn(
  runtime: InkboxRuntime,
  event: MailWebhookPayload,
): Promise<InkboxInboundTurn | null> {
  if (event.event_type !== "message.received") {
    return null;
  }
  const message = event.data.message;
  const from = message.from_address?.trim().toLowerCase();
  if (!from) {
    return null;
  }
  const webhookContact = event.data.contacts.find((entry) => entry.bucket === "from");
  const contact =
    (await hydrateContact(runtime, webhookContact
      ? { id: webhookContact.id, name: webhookContact.name }
      : undefined)) ?? (await lookupContact(runtime, "email", from));
  const contactKey = contact?.id ?? from;
  const bodyText = message.snippet || message.subject || "";
  const subjectPart = message.subject ? ` subject=${JSON.stringify(message.subject)}` : "";
  return {
    mode: "email",
    contactKey,
    contact,
    fromLabel: contact?.name ?? from,
    remoteAddress: from,
    subject: message.subject ?? undefined,
    body: `[inkbox:email from=${from}${subjectPart} | ${renderContactMarker(contact)}]\n${bodyText}`,
    messageId: message.message_id || message.id,
    replyToId: message.message_id ?? undefined,
    threadId: message.thread_id ? `email:${message.thread_id}` : undefined,
    timestamp: parseTimestamp(message.created_at ?? event.timestamp),
    raw: event,
  };
}

async function buildTextTurn(
  runtime: InkboxRuntime,
  event: TextWebhookPayload,
): Promise<InkboxInboundTurn | null> {
  if (event.event_type !== "text.received") {
    return null;
  }
  const message = event.data.text_message;
  if (message.direction && message.direction !== "inbound") {
    return null;
  }
  const remote = message.remote_phone_number?.trim();
  if (!remote) {
    return null;
  }
  const rawText = message.text ?? "";
  if (isSmsControlWord(rawText)) {
    return null;
  }
  const contact =
    (await hydrateContact(runtime, webhookContactSummary(event.data.contact))) ??
    (await lookupContact(runtime, "phone", remote));
  const contactKey = contact?.id ?? remote;
  const mediaMarkers = textMediaMarkers(message.media);
  const text = [rawText, ...mediaMarkers].filter(Boolean).join("\n");
  const groupId = (message as { group_id?: string | null }).group_id;
  return {
    mode: "sms",
    contactKey,
    contact,
    fromLabel: contact?.name ?? remote,
    remoteAddress: remote,
    localAddress: message.local_phone_number,
    body: `[inkbox:sms from=${remote} | ${renderContactMarker(contact)}]\n${text}`,
    messageId: message.id,
    replyToId: message.id,
    threadId: groupId ? `sms:${groupId}` : undefined,
    timestamp: parseTimestamp(message.created_at ?? event.timestamp),
    raw: event,
  };
}

function parseCallContext(raw: string | undefined): Record<string, unknown> {
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function headerValue(headers: ReadonlyMap<string, string>, key: string): string | undefined {
  return headers.get(key.toLowerCase()) ?? undefined;
}

function verifyCallWebSocket(
  ws: InkboxWebSocket,
  signingKey: string | undefined,
  logger?: PluginLogger,
): boolean {
  if (!signingKey) {
    return true;
  }
  const callContext = headerValue(ws.headers, "x-call-context") ?? "";
  const headers: Record<string, string> = {};
  ws.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const ok = verifyWebhook({
    payload: callContext,
    headers,
    secret: signingKey,
  });
  if (!ok) {
    logger?.warn?.("Inkbox call WebSocket signature verification failed");
  }
  return ok;
}

async function resolveCallMeta(
  opts: InkboxSessionBridgeOptions,
  ws: InkboxWebSocket,
  stashed: Map<string, Partial<InkboxInboundTurn> & { callId: string }>,
): Promise<RealtimeCallMeta> {
  const url = new URL(ws.url);
  const outboundContext = consumeOutboundCallContextFromUrl(url);
  const context = parseCallContext(headerValue(ws.headers, "x-call-context"));
  const callId =
    url.searchParams.get("call_id") ||
    String(context.call_id ?? context.id ?? "").trim() ||
    "unknown";
  const stashedMeta = stashed.get(callId);
  if (stashedMeta) {
    stashed.delete(callId);
  }
  let remotePhoneNumber =
    stashedMeta?.remoteAddress ||
    outboundContext?.toNumber ||
    (typeof context.remote_phone_number === "string" ? context.remote_phone_number : "");
  let direction = typeof context.direction === "string" ? context.direction : "";
  let agentIdentity = defaultAgentIdentityInfo(opts.account);

  try {
    const identity = await opts.runtime.getIdentity();
    agentIdentity = agentIdentityInfoFromIdentity(identity);
    const phoneNumberId = identity.phoneNumber?.id;
    if (phoneNumberId && callId !== "unknown") {
      const inkbox = await opts.runtime.getClient();
      const call = await inkbox.calls.get(phoneNumberId, callId);
      remotePhoneNumber = remotePhoneNumber || call.remotePhoneNumber;
      direction = direction || (outboundContext ? "outbound" : call.direction);
    }
  } catch (error) {
    opts.logger?.warn?.(
      `Inkbox call lookup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const contact =
    stashedMeta?.contact ??
    (remotePhoneNumber ? await lookupContact(opts.runtime, "phone", remotePhoneNumber) : undefined);
  const contactKey = stashedMeta?.contactKey || contact?.id || remotePhoneNumber || callId;
  return {
    callId,
    remotePhoneNumber,
    direction: direction || (outboundContext ? "outbound" : "inbound"),
    agentIdentity,
    contact,
    contactKey,
    fromLabel: contact?.name ?? remotePhoneNumber ?? callId,
    outboundContext,
  };
}

function createActiveCall(
  meta: RealtimeCallMeta,
  ws: InkboxWebSocket,
): ActiveCall {
  return {
    callId: meta.callId,
    contactKey: meta.contactKey,
    remotePhoneNumber: meta.remotePhoneNumber,
    ws,
    sequence: 0,
    keys: activeCallKeys({
      callId: meta.callId,
      contactKey: meta.contactKey,
      remotePhoneNumber: meta.remotePhoneNumber,
    }),
  };
}

async function runRealtimeCallWebSocket(
  opts: InkboxSessionBridgeOptions & {
    ws: InkboxWebSocket;
    meta: RealtimeCallMeta;
    active: ActiveCall;
    activeCalls: Map<string, ActiveCall>;
  },
): Promise<void> {
  const realtime = resolveRealtimeConfig(opts.account);
  const resolved = resolveRealtimeProvider(opts);
  let streamId: string | undefined;
  let closed = false;
  const transcript: RealtimeTranscriptEntry[] = [];
  const postCallActions: RealtimePostCallAction[] = [];
  const sendJson = async (payload: Record<string, unknown>) => {
    if (closed) {
      return;
    }
    await opts.ws.send(JSON.stringify(payload));
  };
  const audioPacer = new InkboxRealtimeAudioPacer(sendJson, () => streamId);
  const speechDetector = new RealtimeMulawSpeechStartDetector();
  const session = createRealtimeVoiceBridgeSession({
    provider: resolved.provider,
    cfg: opts.cfg as any,
    providerConfig: resolved.providerConfig,
    audioFormat: REALTIME_VOICE_AUDIO_FORMAT_G711_ULAW_8KHZ,
    instructions: buildRealtimeInstructions(opts.account, opts.meta),
    initialGreetingInstructions: buildRealtimeGreeting(opts.meta),
    triggerGreetingOnReady: false,
    autoRespondToAudio: true,
    interruptResponseOnInputAudio: true,
    markStrategy: "ack-immediately",
    tools: resolveRealtimeVoiceAgentConsultTools(realtime.toolPolicy, [
      realtimePostCallActionTool(),
    ]),
    audioSink: {
      isOpen: () => !closed,
      sendAudio: (audio) => {
        audioPacer.sendAudio(audio);
      },
      clearAudio: () => {
        audioPacer.clearAudio();
      },
    },
    onTranscript: (role, text, isFinal) => {
      if (isFinal) {
        appendRealtimeTranscript(transcript, { role, text });
      }
      void sendJson({
        event: "transcript",
        party: role === "user" ? "remote" : "local",
        text,
        is_final: isFinal,
      }).catch(() => {});
    },
    onEvent: (event) => {
      if (event.type === "response.done") {
        audioPacer.sendAudioDone();
      }
      if (event.type === "error") {
        opts.logger?.warn?.(
          `Inkbox realtime provider error: ${event.detail ?? "unknown error"}`,
        );
      }
    },
    onToolCall: (toolEvent, realtimeSession) => {
      handleRealtimeToolCall({
        ...opts,
        session: realtimeSession,
        toolEvent,
        transcript,
        postCallActions,
      });
    },
    onReady: () => {
      opts.logger?.info?.(
        `Inkbox realtime bridge ready: call_id=${opts.meta.callId} provider=${resolved.provider.id}`,
      );
    },
    onError: (error) => {
      opts.logger?.warn?.(`Inkbox realtime bridge error: ${error.message}`);
    },
    onClose: (reason) => {
      opts.logger?.info?.(
        `Inkbox realtime bridge closed: call_id=${opts.meta.callId} reason=${reason}`,
      );
    },
  });

  await opts.ws.accept({
    headers: [
      ["x-use-inkbox-text-to-speech", "false"],
      ["x-use-inkbox-speech-to-text", "false"],
    ],
  });

  let greetingTriggered = false;
  try {
    await session.connect();
    registerActiveCall(opts.activeCalls, opts.active);
    opts.logger?.info?.(
      `Inkbox call WebSocket open: call_id=${opts.meta.callId} contact=${opts.meta.contactKey} direction=${opts.meta.direction} mode=realtime provider=${resolved.provider.id}`,
    );

    for await (const raw of opts.ws) {
      if (typeof raw !== "string") {
        continue;
      }
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        continue;
      }

      const event = payload.event;
      if (event === "start") {
        streamId = typeof payload.stream_id === "string" ? payload.stream_id : streamId;
        if (!greetingTriggered) {
          greetingTriggered = true;
          session.triggerGreeting(buildRealtimeGreeting(opts.meta));
        }
        continue;
      }

      if (event === "media") {
        const media = payloadMedia(payload);
        const audio = parseBase64AudioPayload(media?.payload);
        if (!audio) {
          continue;
        }
        if (audioPacer.hasQueuedAudio && speechDetector.accept(audio)) {
          audioPacer.clearAudio();
          session.handleBargeIn({ audioPlaybackActive: true, force: true });
        }
        const timestampMs = payloadTimestampMs(payload);
        if (timestampMs !== undefined) {
          session.setMediaTimestamp(timestampMs);
        }
        session.sendAudio(audio);
        continue;
      }

      if (event === "barge_in") {
        audioPacer.clearAudio();
        session.handleBargeIn({ audioPlaybackActive: true, force: true });
        continue;
      }

      if (event === "stop") {
        break;
      }
    }
  } finally {
    closed = true;
    audioPacer.close();
    session.close();
    unregisterActiveCall(opts.activeCalls, opts.active);
    await opts.ws.close().catch(() => {});
    opts.logger?.info?.(`Inkbox call WebSocket closed: call_id=${opts.meta.callId}`);
    void runRealtimePostCallActions({
      ...opts,
      activeCalls: opts.activeCalls,
      transcript,
      actions: [...postCallActions],
    }).catch((error) => {
      opts.logger?.warn?.(
        `Inkbox realtime post-call actions failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }
}

export function createInkboxSessionBridge(opts: InkboxSessionBridgeOptions): InkboxSessionBridge {
  const activeCalls = new Map<string, ActiveCall>();
  const callMetaById = new Map<string, Partial<InkboxInboundTurn> & { callId: string }>();

  const handlers: InboundHandlers = {
    async onMail(event) {
      const turn = await buildMailTurn(opts.runtime, event);
      if (!turn) {
        opts.logger?.info?.(`Inkbox mail lifecycle event: ${event.event_type}`);
        return;
      }
      await dispatchInboundTurn({ ...opts, turn, activeCalls });
    },
    async onText(event) {
      const turn = await buildTextTurn(opts.runtime, event);
      if (!turn) {
        opts.logger?.info?.(`Inkbox text lifecycle event: ${event.event_type}`);
        return;
      }
      await dispatchInboundTurn({ ...opts, turn, activeCalls });
    },
    async onCall(event: PhoneIncomingCallWebhookPayload): Promise<InboundCallDecision> {
      const wsUrl = opts.getCallWebsocketUrl?.();
      if (!wsUrl) {
        opts.logger?.warn?.("Inkbox inbound call rejected; no call WebSocket URL is available.");
        return { action: "reject" };
      }
      const contact =
        (await hydrateContact(opts.runtime, webhookContactSummary(event.contact))) ??
        (await lookupContact(opts.runtime, "phone", event.remote_phone_number));
      callMetaById.set(event.id, {
        mode: "voice",
        callId: event.id,
        contact,
        contactKey: contact?.id ?? event.remote_phone_number,
        fromLabel: contact?.name ?? event.remote_phone_number,
        remoteAddress: event.remote_phone_number,
        localAddress: event.local_phone_number,
        messageId: `call:${event.id}`,
        threadId: `call:${event.id}`,
        timestamp: parseTimestamp(event.created_at),
        raw: event,
      });
      const separator = wsUrl.includes("?") ? "&" : "?";
      return { action: "answer", clientWebsocketUrl: `${wsUrl}${separator}call_id=${event.id}` };
    },
  };

  const wsHandler: InkboxWsHandler = async (ws) => {
    if (!verifyCallWebSocket(ws, opts.account.config.signingKey, opts.logger)) {
      await ws.close(1008, "invalid signature");
      return;
    }
    const meta = await resolveCallMeta(opts, ws, callMetaById);
    const active = createActiveCall(meta, ws);

    if (isVoiceRealtimeEnabled(opts.account)) {
      let realtimeUnavailable: unknown;
      try {
        resolveRealtimeProvider(opts);
      } catch (error) {
        realtimeUnavailable = error;
      }

      if (!realtimeUnavailable) {
        try {
          await runRealtimeCallWebSocket({
            ...opts,
            ws,
            meta,
            active,
            activeCalls,
          });
        } catch (error) {
          opts.logger?.warn?.(
            `Inkbox realtime call bridge failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          await ws.close(1011, "realtime bridge unavailable");
        }
        return;
      }

      if (!shouldFallbackToInkboxSttTts(opts.account)) {
        opts.logger?.warn?.(
          `Inkbox realtime call bridge unavailable: ${realtimeUnavailable instanceof Error ? realtimeUnavailable.message : String(realtimeUnavailable)}`,
        );
        await ws.close(1011, "realtime bridge unavailable");
        return;
      }
      opts.logger?.warn?.(
        `Inkbox realtime call bridge unavailable; falling back to Inkbox STT/TTS: ${realtimeUnavailable instanceof Error ? realtimeUnavailable.message : String(realtimeUnavailable)}`,
      );
    } else {
      opts.logger?.info?.(
        "Inkbox realtime call bridge disabled; using Inkbox STT/TTS. Set channels.inkbox.voiceRealtime.enabled=true to use realtime.",
      );
    }

    await ws.accept({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    registerActiveCall(activeCalls, active);
    opts.logger?.info?.(
      `Inkbox call WebSocket open: call_id=${meta.callId} contact=${meta.contactKey} direction=${meta.direction} mode=inkbox-stt-tts`,
    );
    const voiceTranscripts = createVoiceTranscriptBuffer({
      callId: meta.callId,
      coalesceMs: resolveVoiceTranscriptCoalesceMs(opts.account),
      logger: opts.logger,
      dispatch: async (segments, abortSignal, shouldDeliverReply) => {
        const turnId = lastVoiceTranscriptTurnId(segments);
        const text = mergeVoiceTranscriptSegments(segments);
        const body = [
          `[inkbox:voice_call call_id=${meta.callId}${renderIdentityMarker(opts.account)} segments=${segments.length} reply_mode=voice_tts allow_separate_followup_tools_when_caller_explicitly_asks=true | ${renderContactMarker(meta.contact)}]`,
          ...renderAgentIdentityLines(meta.agentIdentity),
          "You are on a live Inkbox phone call. Reply normally in text so the plugin speaks it over the active call. Do not substitute SMS or email for the spoken call response unless the caller explicitly asks you to send a separate follow-up/message.",
          text,
        ].join("\n");
        await dispatchInboundTurn({
          ...opts,
          activeCalls,
          dispatchAbortSignal: abortSignal,
          shouldDeliverReply,
          turn: {
            mode: "voice",
            contactKey: meta.contactKey,
            contact: meta.contact,
            fromLabel: meta.fromLabel,
            remoteAddress: meta.remotePhoneNumber,
            body,
            messageId: `call:${meta.callId}:${turnId}`,
            replyToId: turnId,
            threadId: meta.direction === "outbound" ? undefined : `call:${meta.callId}`,
            timestamp: segments[0]?.receivedAt ?? Date.now(),
            raw: { event: "transcript", segments },
          },
        });
      },
    });

    let greetingSent = false;
    try {
      for await (const raw of ws) {
        if (typeof raw !== "string") {
          continue;
        }
        let payload: Record<string, unknown>;
        try {
          const parsed = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            continue;
          }
          payload = parsed as Record<string, unknown>;
        } catch {
          continue;
        }
        const event = payload.event;
        if (!greetingSent && (event === "start" || event === "transcript")) {
          greetingSent = true;
          await sendVoiceText(active, buildInkboxTtsGreeting(meta), "greeting");
          if (event === "start") {
            continue;
          }
        }
        if (event === "stop") {
          await voiceTranscripts.drain();
          break;
        }
        if (event !== "transcript") {
          continue;
        }
        const isFinal = payload.is_final === true || payload.final === true;
        if (!isFinal) {
          continue;
        }
        const text =
          typeof payload.text === "string"
            ? payload.text.trim()
            : typeof payload.transcript === "string"
              ? payload.transcript.trim()
              : "";
        if (!text) {
          continue;
        }
        const turnId =
          typeof payload.turn_id === "string" && payload.turn_id.trim()
            ? payload.turn_id.trim()
            : `${Date.now()}`;
        voiceTranscripts.push({
          text,
          turnId,
          receivedAt: Date.now(),
        });
      }
    } finally {
      await voiceTranscripts.drain().catch((error) => {
        opts.logger?.warn?.(
          `Inkbox voice transcript drain failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      unregisterActiveCall(activeCalls, active);
      await ws.close().catch(() => {});
      opts.logger?.info?.(`Inkbox call WebSocket closed: call_id=${meta.callId}`);
    }
  };

  return { handlers, wsHandler, activeCalls };
}

export async function configureInkboxIdentityDelivery(
  opts: ConfigureIdentityDeliveryOptions,
): Promise<void> {
  const [identity, inkbox] = await Promise.all([
    opts.runtime.getIdentity(),
    opts.runtime.getClient(),
  ]);
  if (identity.mailbox?.emailAddress) {
    try {
      await inkbox.mailboxes.update(identity.mailbox.emailAddress, {
        webhookUrl: opts.webhookUrl,
      });
      opts.logger?.info?.(`Inkbox mailbox webhook set to ${opts.webhookUrl}`);
    } catch (error) {
      opts.logger?.warn?.(
        `Inkbox mailbox webhook update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (identity.phoneNumber?.id) {
    try {
      await inkbox.phoneNumbers.update(identity.phoneNumber.id, {
        incomingTextWebhookUrl: opts.webhookUrl,
        incomingCallAction: opts.callWebsocketUrl ? "auto_accept" : "webhook",
        clientWebsocketUrl: opts.callWebsocketUrl ?? null,
        incomingCallWebhookUrl: opts.callWebsocketUrl
          ? null
          : (opts.callWebhookUrl ?? opts.webhookUrl),
      });
      opts.logger?.info?.(
        `Inkbox phone webhooks set to text=${opts.webhookUrl} call=${opts.callWebsocketUrl ?? opts.callWebhookUrl ?? opts.webhookUrl}`,
      );
    } catch (error) {
      opts.logger?.warn?.(
        `Inkbox phone webhook update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
