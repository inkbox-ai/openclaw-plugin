import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { expect, it } from "vitest";

it("holds the native sidecar lock and releases it after a failed callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inkbox-lock-contract-"));
  const file = join(dir, "journal.json");
  const options = { stale: 60_000, retries: { retries: 1, factor: 1, minTimeout: 1, maxTimeout: 1 } };
  try {
    await expect(withFileLock(file, options, async () => {
      expect((await stat(`${file}.lock`)).isFile()).toBe(true);
      throw new Error("callback failed");
    })).rejects.toThrow("callback failed");
    expect(await withFileLock(file, options, async () => "released")).toBe("released");
    await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
