const VOICE_BLOCKED_OUTBOUND_TOOLS = new Set([
  "inkbox_send_sms",
  "inkbox_send_email",
  "inkbox_forward_email",
]);

type ActiveVoiceTurn = {
  callId?: string;
  startedAt: number;
};

const activeVoiceTurnsBySession = new Map<string, ActiveVoiceTurn>();

export function markInkboxVoiceTurnActive(
  sessionKey: string | undefined,
  metadata: {
    callId?: string;
  } = {},
): () => void {
  if (!sessionKey) {
    return () => {};
  }
  const active: ActiveVoiceTurn = {
    callId: metadata.callId,
    startedAt: Date.now(),
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
}
