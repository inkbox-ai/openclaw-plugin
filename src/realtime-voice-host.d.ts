// OpenClaw 2026.9.2 publishes this runtime entry without declarations. Keep this
// consumed contract until the host restores its realtime-voice type export;
// tests/contract verifies the actual exports against the latest installed host.
declare module "openclaw/plugin-sdk/realtime-voice" {
  type AudioFormat = { encoding: "pcm16"; sampleRateHz: 24000; channels: 1 };
  export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: AudioFormat;
  export const REALTIME_VOICE_AGENT_CONSULT_TOOL_NAME: string;
  export type RealtimeVoiceTool = {
    type: "function";
    name: string;
    description: string;
    parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  };
  export type RealtimeVoiceToolCallEvent = { itemId: string; callId: string; name: string; args: unknown };
  export type RealtimeVoiceBridgeSession = {
    connect(): Promise<void>;
    close(): void;
    sendAudio(audio: Buffer): void;
    sendUserMessage(text: string): void;
    handleBargeIn(options?: { audioPlaybackActive?: boolean; force?: boolean }): void;
    setMediaTimestamp(timestamp: number): void;
    submitToolResult(callId: string, result: unknown, options?: { suppressResponse?: boolean; willContinue?: boolean }): void | Promise<void>;
    triggerGreeting(instructions?: string): void;
  };
  type ToolPolicy = "none" | "owner" | "safe-read-only";
  type Provider = { id: string };
  export function resolveConfiguredRealtimeVoiceProvider(params: {
    cfg?: unknown;
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
    providerConfigOverrides?: Record<string, unknown>;
    defaultModel?: string;
    noRegisteredProviderMessage?: string;
  }): { provider: Provider; providerConfig: Record<string, unknown> };
  export function resolveRealtimeVoiceAgentConsultToolPolicy(value: unknown, fallback: ToolPolicy): ToolPolicy;
  export function resolveRealtimeVoiceAgentConsultTools(policy: ToolPolicy, tools?: RealtimeVoiceTool[]): RealtimeVoiceTool[];
  export function buildRealtimeVoiceAgentConsultChatMessage(args: unknown): string;
  export function buildRealtimeVoiceAgentConsultPolicyInstructions(config: { toolPolicy: ToolPolicy; consultPolicy?: "auto" | "substantive" | "always" }): string | undefined;
  export function createRealtimeVoiceBridgeSession(params: {
    provider: Provider;
    cfg?: unknown;
    providerConfig: Record<string, unknown>;
    audioFormat?: AudioFormat;
    instructions?: string;
    initialGreetingInstructions?: string;
    triggerGreetingOnReady?: boolean;
    autoRespondToAudio?: boolean;
    interruptResponseOnInputAudio?: boolean;
    markStrategy?: "transport" | "ack-immediately" | "ignore";
    tools?: RealtimeVoiceTool[];
    audioSink: { isOpen(): boolean; sendAudio(audio: Buffer): void; clearAudio(): void };
    onTranscript?(role: "user" | "assistant", text: string, isFinal: boolean): void;
    onEvent?(event: { direction: "client" | "server"; type: string; detail?: string }): void;
    onToolCall?(event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession): void | Promise<void>;
    onReady?(session: RealtimeVoiceBridgeSession): void;
    onError?(error: Error): void;
    onClose?(reason: "completed" | "error"): void;
  }): RealtimeVoiceBridgeSession;
}
