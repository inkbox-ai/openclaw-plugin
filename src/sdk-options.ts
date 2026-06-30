export interface InkboxClientOptions {
  apiKey: string;
  baseUrl?: string;
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
    ...inkboxBaseUrlOptions(baseUrl),
  };
}
