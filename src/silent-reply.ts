/** The host recognizes NO_REPLY; accept old Inkbox prompts at the boundary too. */
export function isInkboxSilentReply(text: string): boolean {
  const normalized = text.trim().toUpperCase();
  return normalized === "NO_REPLY" || normalized === "[SILENT]";
}

/** Preserve ambient group silence without changing the user's stored policy. */
export function withInkboxGroupSilenceDefault<T>(cfg: T): T {
  const config = cfg as Record<string, any>;
  if (config.surfaces?.inkbox?.silentReply?.group !== undefined ||
      config.agents?.defaults?.silentReply?.group !== undefined) return cfg;
  return {
    ...config,
    surfaces: {
      ...config.surfaces,
      inkbox: {
        ...config.surfaces?.inkbox,
        silentReply: { ...config.surfaces?.inkbox?.silentReply, group: "allow" },
      },
    },
  } as T;
}

/** Tell the host this was intentionally suppressed, not a failed delivery. */
export function transformInkboxReplyPayload<T extends {
  text?: string;
  media?: unknown;
  mediaUrl?: string;
  mediaUrls?: string[];
}>(payload: T): T | null {
  // A silence marker must not discard a requested attachment.
  if (payload.media || payload.mediaUrl || payload.mediaUrls?.length) return payload;
  return typeof payload.text === "string" && isInkboxSilentReply(payload.text)
    ? null
    : payload;
}
