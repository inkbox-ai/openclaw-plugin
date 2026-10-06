import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "../file-lock.js";
import { ensureStateDir, statePaths } from "../state.js";

export type IMessageOutcomeRoute = {
  scope: string;
  conversationId: string;
  sourceMessageIds?: string[];
  replyToMessageId: string | null;
  threadId: string | null;
  threadRootMessageId: string | null;
};
type Accepted = { replyToMessageId: string | null; threadId: string | null; threadRootMessageId: string | null };
export type IMessageOutcome = {
  version: 1; identityId: string; messageId: string; revision: number; failed: boolean;
  route?: IMessageOutcomeRoute; accepted?: Accepted; fallback?: IMessageOutcomeRoute; notified?: string;
};
type Intent = { value: IMessageOutcome; previousScope?: string };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (value: unknown): string | null => typeof value === "string" && value.length > 0 && value.length <= 1024 ? value : null;
const routeOf = (value: IMessageOutcome) => value.route ?? value.fallback;
const noticeKey = (value: IMessageOutcome) => hash(JSON.stringify([value.messageId, routeOf(value)]));

/** Metadata-only, per-output history. No terminal job is mutated or re-admitted. */
export function createIMessageOutcomes(accountId: string, baseUrl: string | undefined, identityId: string) {
  if (!id(identityId)) throw new Error("iMessage outcome identity is unavailable.");
  const directory = join(statePaths().dir, `imessage-outcomes-${hash(JSON.stringify([accountId, (baseUrl ?? "").replace(/\/+$/, ""), identityId]))}`);
  const locks = { stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 1000 } };
  async function read<T>(path: string): Promise<T | undefined> {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch (error: any) { if (error.code === "ENOENT") return; throw new Error("Retained iMessage outcome metadata is unreadable."); }
  }
  async function sync(path: string) { const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
  async function atomic(path: string, value: unknown) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`, file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path);
    for (let parent = dirname(path); ; parent = dirname(parent)) { await sync(parent); if (parent === statePaths().dir) break; }
  }
  async function remove(path: string) { try { await unlink(path); await sync(dirname(path)); } catch (error: any) { if (error.code !== "ENOENT") throw error; } }
  const recordPath = (key: string) => join(directory, "outputs", `${key}.json`);
  const intentPath = (key: string) => join(directory, "pending-writes", `${key}.json`);
  const indexPath = (scope: string, key: string) => join(directory, "notices", hash(scope), `${key}.json`);
  function validate(value: IMessageOutcome, key: string) {
    if (!value || value.version !== 1 || value.identityId !== identityId || !id(value.messageId) || hash(value.messageId) !== key || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.failed !== "boolean") throw new Error("Retained iMessage outcome does not match its owner.");
    for (const route of [value.route, value.fallback]) if (route && (!id(route.scope) || !id(route.conversationId))) throw new Error("Retained iMessage outcome has an invalid route.");
    return value;
  }
  async function finish(key: string) {
    const intent = await read<Intent>(intentPath(key));
    if (!intent) return;
    const value = validate(intent.value, key), current = await read<IMessageOutcome>(recordPath(key));
    if (current && validate(current, key).revision > value.revision) throw new Error("Retained iMessage outcome write is out of order.");
    await atomic(recordPath(key), value);
    const route = routeOf(value);
    if (route && value.failed && value.notified !== noticeKey(value)) await atomic(indexPath(route.scope, key), { identityId, messageId: value.messageId, scope: route.scope });
    else if (route) await remove(indexPath(route.scope, key));
    if (intent.previousScope && intent.previousScope !== route?.scope) await remove(indexPath(intent.previousScope, key));
    await remove(intentPath(key));
  }
  async function locked<T>(key: string, action: () => Promise<T>) {
    await ensureStateDir(); await mkdir(directory, { recursive: true, mode: 0o700 });
    return withFileLock(join(directory, key), locks, async () => { await finish(key); return action(); });
  }
  async function change(messageId: string, update: (value: IMessageOutcome) => void) {
    if (!id(messageId)) throw new Error("iMessage outcome requires a message ID.");
    const key = hash(messageId);
    return locked(key, async () => {
      const existing = await read<IMessageOutcome>(recordPath(key));
      const value = existing ? structuredClone(validate(existing, key)) : { version: 1 as const, identityId, messageId, revision: 0, failed: false };
      const previousScope = routeOf(value)?.scope;
      update(value); value.revision++;
      await atomic(intentPath(key), { value, previousScope }); await finish(key);
      return value;
    });
  }
  async function recover() {
    const entries = await readdir(join(directory, "pending-writes")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) if (/^[a-f0-9]{64}\.json$/.test(entry)) await locked(entry.slice(0, -5), async () => {});
  }
  return {
    directory, recover,
    async lookup(messageId: string) {
      if (!id(messageId)) return;
      const key = hash(messageId);
      const output = async () => { const value = await read<IMessageOutcome>(recordPath(key)); return value && validate(value, key); };
      // Retained intent is ownership proof even before its output rename.
      // Unknown legacy lookups must not require a writable state directory.
      return await read<Intent>(intentPath(key)) ? locked(key, output) : output();
    },
    async accepted(message: { id: string; replyToMessageId?: string | null; threadId?: string | null; threadRootMessageId?: string | null }, route: IMessageOutcomeRoute) {
      return change(message.id, (value) => {
        // First accepted ownership and nullable API ancestry remain canonical.
        if (!value.route) {
          value.route = structuredClone(route);
          value.accepted = { replyToMessageId: id(message.replyToMessageId), threadId: id(message.threadId), threadRootMessageId: id(message.threadRootMessageId) };
        }
      });
    },
    async failed(messageId: string, fallback?: IMessageOutcomeRoute) {
      return change(messageId, (value) => { value.failed = true; if (!value.fallback && fallback) value.fallback = structuredClone(fallback); });
    },
    async pending(scope: string): Promise<IMessageOutcome[]> {
      await recover();
      const entries = await readdir(join(directory, "notices", hash(scope))).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      const result: IMessageOutcome[] = [];
      for (const entry of entries) {
        if (!/^[a-f0-9]{64}\.json$/.test(entry)) continue;
        const key = entry.slice(0, -5), index = await read<{ identityId: string; messageId: string; scope: string }>(indexPath(scope, key));
        if (!index || index.identityId !== identityId || index.scope !== scope || hash(index.messageId) !== key) throw new Error("Retained iMessage notice index has an invalid owner.");
        const value = await locked(key, async () => { const saved = await read<IMessageOutcome>(recordPath(key)); return saved && validate(saved, key); });
        if (value?.failed && routeOf(value)?.scope === scope && value.notified !== noticeKey(value)) result.push(value);
        if (result.length === 64) break;
      }
      return result;
    },
    async acknowledge(values: IMessageOutcome[]) {
      for (const captured of values) await change(captured.messageId, (value) => { if (noticeKey(value) === noticeKey(captured)) value.notified = noticeKey(value); });
    },
  };
}

export function imessageFailureNotice(outcome: IMessageOutcome): string {
  const route = routeOf(outcome);
  return JSON.stringify({ type: "delivery_failure", messageId: outcome.messageId, conversationId: route?.conversationId ?? null,
    sourceMessageIds: route?.sourceMessageIds ?? [], accepted: outcome.accepted ?? null,
    notice: "Delivery status only, not a new request. Do not automatically resend or switch to an unthreaded reply." });
}
