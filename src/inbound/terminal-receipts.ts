import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

type Kind = "sources" | "deliveries" | "engaged";
export type ReceiptIndex = { kind: Kind; key: string };
export type TerminalJob = { identityId: string; state: string; event: Record<string, any>; outboundIds?: string[]; toolSends?: Record<string, { messageId?: string }> };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Called only under the owning journal lock; receipts are never expired. */
export function createTerminalReceipts<T extends TerminalJob>(directory: string, indexes: (job: T) => ReceiptIndex[]) {
  async function read(path: string): Promise<any | undefined> {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error: any) {
      if (error.code === "ENOENT") return undefined;
      throw new Error("A terminal receipt is unreadable; retained delivery proof must be repaired before continuing.");
    }
  }
  async function syncDirectory(path: string) {
    const file = await open(path, "r");
    try { await file.sync(); } finally { await file.close(); }
  }
  async function atomic(namespace: string, name: string, value: unknown) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = join(directory, namespace);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const temporary = join(parent, `${name}.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, join(parent, `${name}.json`));
    await syncDirectory(parent);
    await syncDirectory(directory);
    await syncDirectory(dirname(directory));
  }
  async function event(id: string): Promise<T | undefined> {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid terminal receipt reference.");
    const value = await read(join(directory, "events", `${id}.json`));
    if (value === undefined) return;
    if (!value || value.version !== 1 || value.id !== id || value.job?.state !== "done" || typeof value.job.identityId !== "string" || typeof value.job.event?.id !== "string" || digest(`${value.job.identityId}:${value.job.event.id}`) !== id) throw new Error("A terminal receipt does not match its recorded source.");
    return value.job as T;
  }
  async function lookup(kind: Kind, key: string): Promise<T | undefined> {
    const value = await read(join(directory, kind, `${digest(key)}.json`));
    if (value === undefined) return;
    if (!value || value.version !== 1 || value.kind !== kind || value.key !== key || typeof value.receipt !== "string") throw new Error("A terminal receipt index is invalid.");
    const job = await event(value.receipt);
    if (!job || !indexes(job).some((index) => index.kind === kind && index.key === key)) throw new Error("A terminal receipt index does not match its source proof.");
    return job;
  }
  async function store(id: string, job: T) {
    const existing = await event(id);
    if (job.state !== "done" || digest(`${job.identityId}:${job.event.id}`) !== id) throw new Error("Only exact terminal sources can be archived.");
    if (existing && (JSON.stringify(existing.event) !== JSON.stringify(job.event) || existing.outboundIds?.some((value) => !job.outboundIds?.includes(value)) || Object.entries(existing.toolSends ?? {}).some(([key, value]) => value.messageId && job.toolSends?.[key]?.messageId !== value.messageId))) throw new Error("Terminal receipt migration conflicts with retained source or send proof.");
    await atomic("events", id, { version: 1, id, job });
    for (const index of indexes(job)) {
      // The original completed source remains canonical when another event
      // reports the same source or a repeated accepted outbound message.
      if (await lookup(index.kind, index.key)) continue;
      await atomic(index.kind, digest(index.key), { version: 1, ...index, receipt: id });
    }
  }
  return { event, lookup, store };
}
