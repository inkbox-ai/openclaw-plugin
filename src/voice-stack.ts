import type { InkboxPluginConfig } from "./client.js";

export const PHONE_VOICE_STACKS = [
  "inkbox_voice_ai",
  "openai_realtime",
  "inkbox_tts_stt",
] as const;

export type PhoneVoiceStack = (typeof PHONE_VOICE_STACKS)[number];
export type VoiceAiAuthorityMode = "contact_scoped" | "yolo";
export type OutboundVoicemailDetection = "enabled" | "disabled";

export function isPhoneVoiceStack(value: unknown): value is PhoneVoiceStack {
  return typeof value === "string" && PHONE_VOICE_STACKS.includes(value as PhoneVoiceStack);
}

export function resolvePhoneVoiceStack(
  config: Partial<InkboxPluginConfig>,
): PhoneVoiceStack | undefined {
  return isPhoneVoiceStack(config.voiceStack) ? config.voiceStack : undefined;
}

export function resolveVoicemailDetection(
  config: Partial<InkboxPluginConfig>,
): OutboundVoicemailDetection {
  return config.voicemailDetection === "disabled" ? "disabled" : "enabled";
}
