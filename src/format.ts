// Tool results need to be plain text. JSON gives the model both structure and
// flexibility — beats hand-curated summaries that drop fields the agent might
// actually need.
export function formatJson(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

// Render a one-line header + JSON body, suitable when the tool wants to put
// the headline up top so the model sees it at a glance and the structured
// detail underneath.
export function formatWithHeader(header: string, value: unknown): string {
  return `${header}\n\n${formatJson(value)}`;
}

// Cap an async iterator at `limit` results. Used by email tools that wrap
// identity.iterEmails / iterUnreadEmails — these are unbounded by default
// and we want a hard ceiling so the agent doesn't accidentally fetch a
// mailbox's lifetime of mail.
export async function takeAsync<T>(
  iter: AsyncIterable<T>,
  limit: number,
): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}
