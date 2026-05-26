const VOICE_BLOCKED_OUTBOUND_TOOLS = new Set([
  "inkbox_send_sms",
  "inkbox_send_email",
  "inkbox_forward_email",
]);

type ActiveVoiceTurn = {
  callId?: string;
  startedAt: number;
  deliveredFinalReplies: Set<string>;
  deliverFinalReply?: (text: string) => Promise<void> | void;
};

const activeVoiceTurnsBySession = new Map<string, ActiveVoiceTurn>();

export function markInkboxVoiceTurnActive(
  sessionKey: string | undefined,
  metadata: {
    callId?: string;
    deliverFinalReply?: (text: string) => Promise<void> | void;
  } = {},
): () => void {
  if (!sessionKey) {
    return () => {};
  }
  const active: ActiveVoiceTurn = {
    callId: metadata.callId,
    startedAt: Date.now(),
    deliveredFinalReplies: new Set(),
    deliverFinalReply: metadata.deliverFinalReply,
  };
  activeVoiceTurnsBySession.set(sessionKey, active);
  return () => {
    if (activeVoiceTurnsBySession.get(sessionKey) === active) {
      activeVoiceTurnsBySession.delete(sessionKey);
    }
  };
}

export function getActiveInkboxVoiceTurn(
  sessionKey: string | undefined,
): ActiveVoiceTurn | undefined {
  return sessionKey ? activeVoiceTurnsBySession.get(sessionKey) : undefined;
}

export function shouldBlockInkboxOutboundToolDuringVoice(
  toolName: string | undefined,
  sessionKey: string | undefined,
): boolean {
  return Boolean(
    toolName &&
      VOICE_BLOCKED_OUTBOUND_TOOLS.has(toolName) &&
      getActiveInkboxVoiceTurn(sessionKey),
  );
}

function finalReplyText(event: any): string {
  if (typeof event?.lastAssistantMessage === "string") {
    return event.lastAssistantMessage.trim();
  }
  if (Array.isArray(event?.assistantTexts)) {
    return event.assistantTexts
      .filter((entry: unknown): entry is string => typeof entry === "string")
      .join("\n")
      .trim();
  }
  return "";
}

export async function deliverInkboxVoiceFinalReply(
  sessionKey: string | undefined,
  text: string,
): Promise<boolean> {
  const active = getActiveInkboxVoiceTurn(sessionKey);
  const normalized = text.trim();
  if (!active?.deliverFinalReply || !normalized || normalized.toUpperCase() === "[SILENT]") {
    return false;
  }
  if (active.deliveredFinalReplies.has(normalized)) {
    return true;
  }
  active.deliveredFinalReplies.add(normalized);
  await active.deliverFinalReply(normalized);
  return true;
}

export function registerInkboxVoiceToolGuard(api: any): void {
  api.registerHook?.(
    "before_tool_call",
    (event: any, ctx: any) => {
      if (!shouldBlockInkboxOutboundToolDuringVoice(event?.toolName, ctx?.sessionKey)) {
        return undefined;
      }
      return {
        block: true,
        blockReason:
          "Inkbox voice call is active. Do not use SMS or email tools for the voice-call response; reply normally so the Inkbox bridge speaks it over TTS. Send a separate follow-up only after the voice turn has ended.",
      };
    },
    {
      name: "inkbox-voice-outbound-tool-guard",
      description: "Blocks Inkbox SMS/email tools while an active voice-call turn is being spoken by TTS.",
    },
  );

  api.registerHook?.(
    "before_agent_finalize",
    async (event: any, ctx: any) => {
      await deliverInkboxVoiceFinalReply(ctx?.sessionKey ?? event?.sessionKey, finalReplyText(event));
      return undefined;
    },
    {
      name: "inkbox-voice-final-reply-tts",
      description: "Speaks final assistant replies over the active Inkbox call WebSocket.",
    },
  );
}
