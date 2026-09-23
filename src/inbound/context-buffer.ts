import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { ensureStateDir, statePaths } from "../state.js";

type Entry = { id: string; body: string; omitted?: number };
const MAX_BYTES = 128 * 1024;

/** Durable background input. Reading does not consume it before a host turn succeeds. */
export function contextBuffer(namespace: string, options: { retainLatest?: boolean } = {}) {
  const path = join(statePaths().dir, `group-context-${createHash("sha256").update(namespace).digest("hex")}.json`);
  async function update(fn: (entries: Entry[]) => Entry[]): Promise<Entry[]> {
    await ensureStateDir();
    return withFileLock(path, { stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 1000 } }, async () => {
      let entries: Entry[];
      try { entries = JSON.parse(await readFile(path, "utf8")); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; entries = []; }
      let next = fn(entries);
      if (options.retainLatest && Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) {
        let omitted = next.reduce((sum, entry) => sum + (entry.omitted ?? 0), 0);
        next = next.filter((entry) => !entry.omitted);
        while (next.length > 1 && Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES - 1024) { next.shift(); omitted++; }
        if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES - 1024) {
          next = next.map((entry) => ({ ...entry, body: `${entry.body.slice(0, 16_000)}\n[This oversized background message was truncated by the context retention limit.]` }));
        }
        if (omitted) next.unshift({ id: "background-context-retention-notice", omitted, body: `[${omitted} older background message(s) were omitted by the context retention limit; the following entries are the most recent context.]` });
      }
      if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES) throw new Error("Group background context exceeds the input limit.");
      const temporary = `${path}.${randomUUID()}.tmp`;
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(statePaths().dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return entries;
    });
  }
  return {
    async append(entry: Entry) { await update((entries) => entries.some((item) => item.id === entry.id) ? entries : [...entries, entry]); },
    async snapshot(): Promise<Entry[]> {
      try { return JSON.parse(await readFile(path, "utf8")); }
      catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
    },
    async replace(entry: Entry, replacement: Entry): Promise<boolean> {
      let replaced = false;
      await update((entries) => entries.map((item) => {
        if (item.id !== entry.id || item.body !== entry.body) return item;
        replaced = true; return replacement;
      }));
      return replaced;
    },
    async acknowledge(entries: Entry[]) { const captured = new Map(entries.map((entry) => [entry.id, entry.body])); await update((current) => current.filter((entry) => captured.get(entry.id) !== entry.body)); },
  };
}
