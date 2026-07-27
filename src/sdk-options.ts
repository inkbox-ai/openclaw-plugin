import { createRequire } from "node:module";

export interface InkboxClientOptions {
  apiKey: string;
  baseUrl?: string;
  userAgentPrefix?: string;
}

const USER_AGENT_NAME = "inkbox-openclaw";

// Read at runtime rather than hardcoded so the token can't drift from the
// package version. `tsc` emits to dist/, so ../package.json resolves from
// both the build output and the source tree.
function pluginVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

let cachedUserAgent: string | undefined;

/** Identifies this plugin ahead of the SDK's own `User-Agent` token. */
export function pluginUserAgent(): string {
  cachedUserAgent ??= `${USER_AGENT_NAME}/${pluginVersion()}`;
  return cachedUserAgent;
}

export function inkboxBaseUrlOptions(baseUrl: string | undefined): { baseUrl?: string } {
  const normalized = baseUrl?.trim();
  return normalized ? { baseUrl: normalized } : {};
}

export function inkboxClientOptions(
  apiKey: string,
  baseUrl: string | undefined,
): InkboxClientOptions {
  return {
    apiKey,
    userAgentPrefix: pluginUserAgent(),
    ...inkboxBaseUrlOptions(baseUrl),
  };
}
