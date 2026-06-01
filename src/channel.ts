import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-message";
import {
  DEFAULT_ACCOUNT_ID,
  INKBOX_CHANNEL_ID,
  listInkboxAccountIds,
  resolveDefaultInkboxAccountId,
  resolveInkboxAccount,
  type ResolvedInkboxAccount,
} from "./accounts.js";
import { inkboxChannelConfigSchema } from "./config-schema.js";
import { startInkboxGatewayAccount } from "./gateway.js";
import {
  normalizeInkboxTarget,
  parseInkboxTarget,
  sendInkboxChannelText,
} from "./outbound.js";

const meta = {
  id: INKBOX_CHANNEL_ID,
  label: "Inkbox",
  selectionLabel: "Inkbox (Email, SMS, Voice)",
  docsPath: "/plugins/inkbox",
  docsLabel: "inkbox",
  blurb: "Inkbox email, SMS, and voice identities.",
  order: 90,
  detailLabel: "Inkbox",
  aliases: ["email", "sms", "phone"],
  markdownCapable: false,
  exposure: {
    configured: true,
    setup: true,
    docs: true,
  },
};

const inkboxMessageAdapter = defineChannelMessageAdapter({
  id: INKBOX_CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx: any) => {
      const result = await sendInkboxChannelText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        threadId: ctx.threadId,
        replyToId: ctx.replyToId,
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [
            {
              channel: INKBOX_CHANNEL_ID,
              messageId: result.messageId,
            },
          ],
          threadId: ctx.threadId == null ? undefined : String(ctx.threadId),
          replyToId: ctx.replyToId == null ? undefined : String(ctx.replyToId),
          kind: "text",
        }),
      };
    },
  },
});

function cloneConfig(cfg: any): any {
  return JSON.parse(JSON.stringify(cfg ?? {}));
}

function readFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function readStringList(...values: unknown[]): string[] | undefined {
  const out: string[] = [];
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      out.push(value);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          out.push(entry);
        }
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function applyInkboxAccountConfig(params: {
  cfg: any;
  accountId: string;
  input: Record<string, unknown>;
}) {
  const next = cloneConfig(params.cfg);
  next.channels ??= {};
  next.channels.inkbox ??= {};
  const section = next.channels.inkbox;
  section.accounts ??= {};
  const account =
    params.accountId === DEFAULT_ACCOUNT_ID
      ? section
      : (section.accounts[params.accountId] ??= {});
  const input = params.input;
  if (typeof input.name === "string") {
    account.name = input.name;
  }
  if (typeof input.token === "string") {
    account.apiKey = input.token;
  }
  if (typeof input.secret === "string") {
    account.signingKey = input.secret;
  }
  const identity = readFirstString(input.identity, input.userId);
  if (identity) {
    account.identity = identity;
  }
  if (typeof input.baseUrl === "string") {
    account.baseUrl = input.baseUrl;
  }
  const publicUrl = readFirstString(input.publicUrl, input.webhookUrl, input.url);
  if (publicUrl) {
    account.publicUrl = publicUrl;
  }
  const tunnelName = readFirstString(input.tunnelName);
  if (tunnelName) {
    account.tunnelName = tunnelName;
  }
  const allowedRecipients = readStringList(
    input.allowedRecipients,
    input.allowedRecipient,
  );
  if (allowedRecipients) {
    account.allowedRecipients = allowedRecipients;
  }
  const allowedInboundContactIds = readStringList(
    input.allowedInboundContactIds,
    input.allowedInboundContact,
  );
  if (allowedInboundContactIds) {
    account.allowedInboundContactIds = allowedInboundContactIds;
  }
  return next;
}

export const inkboxPlugin = createChatChannelPlugin<ResolvedInkboxAccount>({
  base: {
    id: INKBOX_CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
      blockStreaming: true,
    },
    reload: {
      configPrefixes: ["channels.inkbox", "plugins.entries.inkbox.config"],
    },
    configSchema: inkboxChannelConfigSchema as any,
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }: any) =>
        applyInkboxAccountConfig({
          cfg,
          accountId,
          input: input as Record<string, unknown>,
        }),
    },
    agentPrompt: {
      messageToolCapabilities: () => [
        "Inkbox sends direct email, SMS, and voice calls from the configured agent identity.",
      ],
      messageToolHints: ({ cfg, accountId }: any) => {
        const account = resolveInkboxAccount({ cfg, accountId });
        const identity = account.config.identity;
        return [
          identity
            ? `- Inkbox account ${account.accountId} sends as identity handle \`${identity}\`. Use \`inkbox_whoami\` when you need the mailbox address, phone number, org id, or auth subtype.`
            : "- Inkbox is enabled but the identity handle is not configured; use `inkbox_whoami`/doctor output to debug before sending.",
          "- For Inkbox conversations, prefer Inkbox tools for Inkbox state: `inkbox_list_text_conversations`, `inkbox_get_text_conversation`, `inkbox_list_emails`, `inkbox_list_calls`, `inkbox_list_call_transcripts`, `inkbox_lookup_contact`, `inkbox_create_contact`, and `inkbox_create_note`.",
          "- When a user asks to save a contact, use `inkbox_lookup_contact` first; then use `inkbox_create_contact` or `inkbox_update_contact`. Use `inkbox_create_note` only for free-form memory that is not an address-book contact field.",
          "- When a user asks you to call them, use `inkbox_place_call`. Always include the call `purpose` when the user gave a reason/topic, and include `openingMessage` when you know what should be said first; the call bridge loads that context before greeting the callee. During an active voice-call turn, answer conversationally; the Inkbox bridge speaks your reply over TTS, so do not send SMS or email unless the user explicitly asks for a separate follow-up.",
        ];
      },
      inboundFormattingHints: () => ({
        text_markup: "plain",
        rules: [
          "This is an Inkbox email/SMS/voice session. Inkbox is the source of truth for mailbox, SMS conversations, call transcripts, contacts, and notes.",
          "You are the configured Inkbox agent identity for this OpenClaw account. If asked who or what you are, identify as the OpenClaw agent connected through Inkbox; do not say you have no name or identity set.",
          "Use Inkbox tools for contact and note operations. Do not fall back to workspace notes when the user asks to save Inkbox contact details.",
          "If the inbound message is an Inkbox voice-call transcript, reply normally; the plugin will speak the response on the active call with Inkbox TTS.",
          "Voice transcripts may be clipped or segmented. At the start of a call, a bare phrase like 'Are you?' is often a clipped 'Who are you?'; answer with your Inkbox/OpenClaw identity when that is the likely intent.",
          "Call inkbox_whoami if you need to confirm the active Inkbox identity before acting.",
        ],
      }),
    },
    config: {
      listAccountIds: (cfg: any) => listInkboxAccountIds(cfg),
      resolveAccount: (cfg: any, accountId: string | null | undefined) =>
        resolveInkboxAccount({
          cfg,
          accountId,
        }),
      defaultAccountId: (cfg: any) => resolveDefaultInkboxAccountId(cfg),
      isEnabled: (account: ResolvedInkboxAccount) => account.enabled,
      isConfigured: (account: ResolvedInkboxAccount) => account.configured,
      describeAccount: (account: ResolvedInkboxAccount) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        linked: account.configured,
        statusState: account.enabled
          ? account.configured
            ? "configured"
            : "not configured"
          : "disabled",
        baseUrl: account.baseUrl,
        webhookUrl: account.publicUrl,
      }),
      hasConfiguredState: ({ cfg, env }: any) =>
        listInkboxAccountIds(cfg, env).some(
          (accountId) =>
            resolveInkboxAccount({ cfg, accountId, env }).configured,
        ),
      resolveAllowFrom: ({ cfg, accountId }: any) =>
        resolveInkboxAccount({ cfg, accountId }).config.allowedInboundContactIds,
      formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> }) =>
        allowFrom.map((entry) => String(entry)),
      resolveDefaultTo: ({ cfg, accountId }: any) =>
        resolveInkboxAccount({ cfg, accountId }).defaultTo,
    },
    messaging: {
      targetPrefixes: ["inkbox", "email", "mailto", "sms", "text", "phone", "conversation"],
      normalizeTarget: normalizeInkboxTarget,
      parseExplicitTarget: ({ raw }: { raw: string }) => {
        const parsed = parseInkboxTarget(raw);
        return parsed
          ? {
              to: parsed.value,
              chatType:
                parsed.mode === "sms-conversation" ? ("group" as const) : ("direct" as const),
            }
          : null;
      },
      inferTargetChatType: ({ to }: { to: string }) =>
        parseInkboxTarget(to)?.mode === "sms-conversation"
          ? "group"
          : parseInkboxTarget(to)
            ? "direct"
            : undefined,
      targetResolver: {
        looksLikeId: (raw: string) => parseInkboxTarget(raw) !== null,
        hint: "<email:user@example.com|sms:+14155550123>",
      },
      resolveOutboundSessionRoute: ({
        cfg,
        agentId,
        accountId,
        target,
        replyToId,
        threadId,
        currentSessionKey,
      }: any) => {
        const parsed = parseInkboxTarget(target);
        if (!parsed) {
          return null;
        }
        const chatType = parsed.mode === "sms-conversation" ? "group" : "direct";
        const route = buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: INKBOX_CHANNEL_ID,
          accountId,
          peer: {
            kind: chatType,
            id: parsed.value,
          },
          chatType,
          from:
            chatType === "group"
              ? `inkbox:conversation:${parsed.value}`
              : `inkbox:${accountId ?? resolveDefaultInkboxAccountId(cfg)}`,
          to: parsed.value,
        });
        return buildThreadAwareOutboundSessionRoute({
          route,
          replyToId,
          threadId,
          currentSessionKey,
        });
      },
    },
    gateway: {
      startAccount: async (ctx: any) => {
        await startInkboxGatewayAccount(ctx as any);
      },
    },
    message: inkboxMessageAdapter,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
    },
    attachedResults: {
      channel: INKBOX_CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId, threadId, replyToId }: any) =>
        await sendInkboxChannelText({
          cfg,
          to,
          text,
          accountId,
          threadId,
          replyToId,
        }),
    },
  },
});
