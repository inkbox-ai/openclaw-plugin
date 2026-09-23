import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { ensureStateDir, statePaths } from "../state.js";

type Entry = { id: string; body: string };

/** Durable background input. Reading does not consume it before a host turn succeeds. */
export function contextBuffer(namespace: string) {
  const path = join(statePaths().dir, `group-context-${createHash("sha256").update(namespace).digest("hex")}.json`);
  async function update(fn: (entries: Entry[]) => Entry[]): Promise<Entry[]> {
    await ensureStateDir();
    return withFileLock(path, { stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 1000 } }, async () => {
      let entries: Entry[];
      try { entries = JSON.parse(await readFile(path, "utf8")); }
      catch (error: any) { if (error.code !== "ENOENT") throw error; entries = []; }
      const next = fn(entries);
      if (Buffer.byteLength(JSON.stringify(next)) > 128 * 1024) throw new Error("Group background context exceeds the input limit.");
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
    async snapshot() { return update((entries) => entries); },
    async acknowledge(entries: Entry[]) { const ids = new Set(entries.map((entry) => entry.id)); await update((current) => current.filter((entry) => !ids.has(entry.id))); },
  };
}
