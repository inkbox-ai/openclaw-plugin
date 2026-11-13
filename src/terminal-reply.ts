import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { RemoteMcp, type RemoteToolResult } from "@inkbox/sdk/remote-mcp";
import type { InkboxRuntime } from "./client.js";
import type { NativeSource } from "./native-source.js";
import { statePaths } from "./state.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceKey = (source: NativeSource) => hash([source.replyChannel, source.replySourceId]);
const journalPath = (source: NativeSource, home: string) => join(home, "remote-replies", hash([source.identityId, source.replyRoute]));
const equal = (actual: unknown, expected: string[], email = false) => Array.isArray(actual) && actual.every(value => typeof value === "string") &&
  JSON.stringify([...new Set(actual.map(value => email ? value.toLowerCase() : value))].sort()) === JSON.stringify([...new Set(expected.map(value => email ? value.toLowerCase() : value))].sort());

export async function terminalReceipt(runtime: InkboxRuntime, source: NativeSource, home = statePaths().dir): Promise<string | undefined> {
  if (!source.replyChannel || !source.replySourceId) return;
  try { await lstat(journalPath(source, home)); } catch (error: any) { if (error.code === "ENOENT") return; throw error; }
  const client = await runtime.getClient();
  const identity = await runtime.getIdentity();
  if (identity.id !== source.identityId) throw new Error("The reply identity changed.");
  const remote = new RemoteMcp({ apiKey: client._apiKey, baseUrl: client._baseUrl, identity: identity.id, journalPath: journalPath(source, home) });
  const record = remote.terminalReplies().lookup(sourceKey(source));
  if (record?.state === "accepted") return record.acceptedId ?? undefined;
  if (record?.state === "pending" && record.submitted) throw new Error("The terminal reply is unconfirmed; automatic reply withheld.");
}

export async function terminalReply(remote: RemoteMcp, runtime: InkboxRuntime, source: NativeSource, text: string,
  validate: () => Promise<void>,
  call: (name: string, args: Record<string, unknown>, operation: string, journal: string, submit: () => Promise<void>) => Promise<RemoteToolResult>,
  home = statePaths().dir): Promise<RemoteToolResult> {
  if (!source.replyChannel || !source.replySourceId || !source.replyRoute || !text.trim() || text.length > 12000) throw new Error("A final reply requires an admitted email or direct SMS source and bounded text.");
  await validate();
  const key = sourceKey(source), operation = `terminal:${key}:${hash(text).slice(0, 32)}`, path = journalPath(source, home);
  const journal = remote.terminalReplies({ journalPath: path }), prior = journal.lookup(key);
  if (prior?.state === "accepted") return { content: [{ type: "text", text: "The final reply was already accepted." }], structuredContent: { accepted_id: prior.acceptedId } };
  let name: string, args: Record<string, unknown>, to: string[], cc: string[] = [];
  if (source.replyChannel === "email") {
    const identity = await runtime.getIdentity(), original = await identity.getMessage(source.replySourceId);
    if (identity.id !== source.identityId || original.id !== source.replySourceId || original.direction !== "inbound" || !original.replyAllRecipients) throw new Error("The original reply destination is unavailable.");
    to = original.replyAllRecipients.to; cc = original.replyAllRecipients.cc;
    name = "inkbox_email_reply"; args = { message_id: source.replySourceId, reply_all: true, approved_recipients: { to, cc, bcc: [] }, body_text: text, idempotency_key: operation };
  } else {
    to = [source.author]; name = "inkbox_text_send"; args = { to, text, idempotency_key: operation };
  }
  await validate();
  journal.reserve(key, operation, hash([name, args]));
  try {
    const result = await call(name, args, operation, path, async () => {
      await validate(); await source.beforeSend(operation);
      journal.markSubmitted(key, operation);
    });
    if (result.isError) {
      if (!journal.lookup(key)?.submitted) journal.reject(key, operation);
      return result;
    }
    const receipt = result.structuredContent;
    const accepted = source.replyChannel === "email"
      ? receipt && typeof receipt.id === "string" && receipt.direction === "outbound" && receipt.is_blocked !== true && equal(receipt.to_addresses, to, true) && equal(receipt.cc_addresses ?? [], cc, true) && equal(receipt.bcc_addresses ?? [], [], true)
      : receipt && typeof receipt.message_id === "string" && receipt.message_id.length > 0 && ["queued", "sent", "delivered"].includes(String(receipt.delivery_status)) && !receipt.error && equal(receipt.recipients, to);
    if (!accepted) throw new Error("The final reply outcome or destination is unconfirmed.");
    const id = String(source.replyChannel === "email" ? receipt!.id : receipt!.message_id);
    journal.accept(key, operation, id);
    await source.afterSend(operation, id, text);
    return result;
  } catch (error) {
    const current = journal.lookup(key);
    if (current?.state === "pending" && !current.submitted) journal.reject(key, operation);
    throw error;
  }
}
