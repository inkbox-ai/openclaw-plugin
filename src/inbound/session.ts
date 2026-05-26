import { verifyWebhook } from "@inkbox/sdk";
import type {
  Contact,
  MailWebhookPayload,
  PhoneIncomingCallWebhookPayload,
  TextWebhookPayload,
} from "@inkbox/sdk";
import type { InkboxWebSocket, InkboxWsHandler } from "@inkbox/sdk/tunnels/connect";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import type { InkboxRuntime, PluginLogger } from "../client.js";
import type { ResolvedInkboxAccount } from "../accounts.js";
import type { InboundCallDecision, InboundHandlers } from "./dispatch.js";
import { markInkboxVoiceTurnActive } from "../voice-guard.js";

type ChannelRuntime = any;

type InboundMode = "email" | "sms" | "voice";

type ContactSummary = {
  id?: string;
  name?: string;
  emails?: string[];
  phones?: string[];
  company?: string | null;
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

function parseTimestamp(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : undefined;
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
  if (contact.emails?.length) {
    parts.push(`contact_emails=${contact.emails.join(",")}`);
  }
  if (contact.phones?.length) {
    parts.push(`contact_phones=${contact.phones.join(",")}`);
  }
  return parts.join(" ");
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
  },
): Promise<string | undefined> {
  const text = params.text.trim();
  if (!text || text.toUpperCase() === "[SILENT]") {
    return undefined;
  }
  if (params.turn.mode === "voice") {
    const call = findActiveCall(params.activeCalls, params.turn);
    if (!call) {
      return undefined;
    }
    const turnId = params.turn.replyToId ?? params.turn.messageId;
    await sendVoiceText(call, text, turnId);
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

async function dispatchInboundTurn(
  opts: InkboxSessionBridgeOptions & {
    turn: InkboxInboundTurn;
    activeCalls: Map<string, ActiveCall>;
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
      routeSessionKey: route.sessionKey,
    },
    reply: {
      to:
        opts.turn.mode === "voice"
          ? `inkbox-call:${callIdFromTurn(opts.turn) ?? opts.turn.contactKey}`
          : opts.turn.remoteAddress ?? opts.turn.contactKey,
      originatingTo:
        opts.turn.mode === "voice"
          ? `inkbox-call:${callIdFromTurn(opts.turn) ?? opts.turn.contactKey}`
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
    },
  });

  const clearVoiceGuard =
    opts.turn.mode === "voice"
      ? markInkboxVoiceTurnActive(route.sessionKey, {
          callId: callIdFromTurn(opts.turn),
          deliverFinalReply: async (text) => {
            await deliverReply({
              turn: opts.turn,
              text,
              runtime: opts.runtime,
              activeCalls: opts.activeCalls,
            });
          },
        })
      : undefined;
  try {
    await core.turn.runAssembled({
      cfg: opts.cfg as any,
      channel: "inkbox",
      accountId: opts.account.accountId,
      agentId: route.agentId,
      routeSessionKey: route.sessionKey,
      storePath,
      ctxPayload,
      recordInboundSession: core.session.recordInboundSession,
      dispatchReplyWithBufferedBlockDispatcher:
        core.reply.dispatchReplyWithBufferedBlockDispatcher,
      delivery: {
        deliver: async (payload: unknown) => {
          const text = payloadText(payload);
          if (!text.trim()) {
            return { visibleReplySent: false };
          }
          const messageId = await deliverReply({
            turn: opts.turn,
            text,
            runtime: opts.runtime,
            activeCalls: opts.activeCalls,
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
      },
      replyPipeline: {},
      record: {
        onRecordError: (error: unknown) => {
          opts.logger?.warn?.(
            `Inkbox session record failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
    });
  } finally {
    clearVoiceGuard?.();
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
) {
  const url = new URL(ws.url);
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
    (typeof context.remote_phone_number === "string" ? context.remote_phone_number : "");
  let direction = typeof context.direction === "string" ? context.direction : "";

  try {
    const identity = await opts.runtime.getIdentity();
    const phoneNumberId = identity.phoneNumber?.id;
    if (phoneNumberId && callId !== "unknown") {
      const inkbox = await opts.runtime.getClient();
      const call = await inkbox.calls.get(phoneNumberId, callId);
      remotePhoneNumber = remotePhoneNumber || call.remotePhoneNumber;
      direction = direction || call.direction;
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
    direction: direction || "inbound",
    contact,
    contactKey,
    fromLabel: contact?.name ?? remotePhoneNumber ?? callId,
  };
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
    await ws.accept({
      headers: [
        ["x-use-inkbox-text-to-speech", "true"],
        ["x-use-inkbox-speech-to-text", "true"],
      ],
    });
    const meta = await resolveCallMeta(opts, ws, callMetaById);
    const active: ActiveCall = {
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
    registerActiveCall(activeCalls, active);
    opts.logger?.info?.(
      `Inkbox call WebSocket open: call_id=${meta.callId} contact=${meta.contactKey} direction=${meta.direction}`,
    );

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
          const name = meta.contact?.name?.split(/\s+/)[0] || "there";
          await sendVoiceText(active, `Hi ${name}, how can I help?`, "greeting");
          if (event === "start") {
            continue;
          }
        }
        if (event === "stop") {
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
        await sendVoiceText(active, "I heard you. One moment.", `${turnId}:ack`);
        const body = `[inkbox:voice_call call_id=${meta.callId} | ${renderContactMarker(meta.contact)}]\n${text}`;
        await dispatchInboundTurn({
          ...opts,
          activeCalls,
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
            timestamp: Date.now(),
            raw: payload,
          },
        });
      }
    } finally {
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
