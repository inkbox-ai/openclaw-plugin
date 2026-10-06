import { resolve } from "node:path";
import { withFileLock as withNativeFileLock } from "openclaw/plugin-sdk/file-lock";

const registry = Symbol.for("inkbox.file-lock-queue.v1");
const shared = globalThis as typeof globalThis & { [registry]?: Map<string, Promise<void>> };
const queues = shared[registry] ??= new Map<string, Promise<void>>();

/** Older hosts borrow held locks across async callers; serialize those callers locally. */
export function withFileLock<T>(path: string, options: Parameters<typeof withNativeFileLock>[1], action: () => Promise<T>): Promise<T> {
  const normalized = resolve(path);
  const previous = queues.get(normalized) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(() => withNativeFileLock(normalized, options, action));
  const settled = result.then(() => {}, () => {});
  queues.set(normalized, settled);
  void settled.then(() => { if (queues.get(normalized) === settled) queues.delete(normalized); });
  return result;
}
