// Core webhook-provider machinery: the provider interface and the registry.
//
// Every request that reaches the plugin's webhook endpoint is signed by
// whoever sent it, but each source signs differently — a different header
// name, different signed content, and a different algorithm — so there is no
// single signature to check. Each source is a WebhookProvider that knows how
// to (a) recognise its own requests from the headers and (b) verify their
// signature. matchProvider picks the provider for an incoming request by
// header presence; the webhook handler then calls provider.verify(...) with
// that source's secret. Adding a source is a new module in this directory
// plus one registerProvider call (imported from ./index.ts).

export interface WebhookVerifyInput {
  // Raw request body exactly as received — most HMAC schemes sign the raw
  // bytes, so never re-stringify parsed JSON.
  body: string;
  // Lowercase-keyed request headers.
  headers: Record<string, string>;
  // This source's signing secret or verification key.
  secret: string;
}

export interface WebhookProvider {
  // Stable source id, surfaced to the agent as source=<name>.
  name: string;
  // Signature header that fingerprints this source (compared
  // case-insensitively). Sources needing more than one header to identify
  // themselves can override matches() instead.
  providerHeader: string;
  matches?(headers: Record<string, string>): boolean;
  // Return true iff the signature is present and authentic.
  verify(input: WebhookVerifyInput): boolean;
}

// Registered providers, checked in registration order by matchProvider.
const registry: WebhookProvider[] = [];

export function registerProvider(provider: WebhookProvider): void {
  const header = provider.providerHeader.toLowerCase();
  // Match order is first-match-wins, so an overlapping header would be
  // ambiguous — fail fast at registration.
  if (header) {
    for (const existing of registry) {
      if (existing.providerHeader.toLowerCase() === header) {
        throw new Error(
          `Webhook provider header collision: ${provider.name} and ${existing.name} both claim ${provider.providerHeader}.`,
        );
      }
    }
  }
  registry.push(provider);
}

function defaultMatches(provider: WebhookProvider, headers: Record<string, string>): boolean {
  const wanted = provider.providerHeader.toLowerCase();
  if (!wanted) {
    return false;
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === wanted);
}

// Return the first registered provider that recognises the request, or
// undefined when no registered source claims it (an unknown/unverifiable
// third party).
export function matchProvider(headers: Record<string, string>): WebhookProvider | undefined {
  return registry.find((provider) =>
    provider.matches ? provider.matches(headers) : defaultMatches(provider, headers),
  );
}

// Case-insensitive header lookup shared by provider implementations.
export function headerLookup(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) {
      return value;
    }
  }
  return "";
}
