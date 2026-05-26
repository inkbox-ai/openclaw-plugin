import {
  DEFAULT_ACCOUNT_ID,
  type ResolvedInkboxAccount,
} from "./accounts.js";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function routePart(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "" : `/${encodeURIComponent(accountId)}`;
}

export function inkboxWebhookPath(accountId: string): string {
  return `/inkbox${routePart(accountId)}/webhook`;
}

export function inkboxCallWebsocketPath(accountId: string): string {
  return `/inkbox${routePart(accountId)}/phone/media/ws`;
}

export function publicUrl(base: string, path: string): string {
  return `${trimTrailingSlash(base)}${path}`;
}

export function websocketUrl(base: string, path: string): string {
  const url = publicUrl(base, path);
  if (url.startsWith("https://")) {
    return `wss://${url.slice("https://".length)}`;
  }
  if (url.startsWith("http://")) {
    return `ws://${url.slice("http://".length)}`;
  }
  return url;
}

export function deriveConfiguredCallWebsocketUrl(
  account: ResolvedInkboxAccount,
): string | undefined {
  const explicit = nonEmptyString(account.config.callWebsocketUrl);
  if (explicit) {
    return explicit;
  }

  const configuredPublicUrl = nonEmptyString(account.config.publicUrl);
  if (configuredPublicUrl) {
    return websocketUrl(
      configuredPublicUrl,
      inkboxCallWebsocketPath(account.accountId),
    );
  }

  const tunnelName =
    nonEmptyString(account.config.tunnelName) ?? nonEmptyString(account.config.identity);
  if (!tunnelName) {
    return undefined;
  }

  return websocketUrl(
    `https://${tunnelName}.inkboxwire.com`,
    inkboxCallWebsocketPath(account.accountId),
  );
}
