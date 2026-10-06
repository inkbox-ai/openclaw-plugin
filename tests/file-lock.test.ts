import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const observed = vi.hoisted(() => ({ acquire: vi.fn(), failure: undefined as Error | undefined }));
vi.mock("openclaw/plugin-sdk/file-lock", async (original) => {
  const native = await original<typeof import("openclaw/plugin-sdk/file-lock")>();
  return { ...native, withFileLock: async (...args: Parameters<typeof native.withFileLock>) => {
    observed.acquire(args[0], args[1]);
    if (observed.failure) { const error = observed.failure; observed.failure = undefined; throw error; }
    return native.withFileLock(...args);
  } };
});
import { withFileLock } from "../src/file-lock.js";
const options = { stale: 60_000, retries: { retries: 10, factor: 1.5, minTimeout: 20, maxTimeout: 1000 } };
const gate = () => { let open!: () => void; const promise = new Promise<void>((resolve) => { open = resolve; }); return { promise, open }; };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "inkbox-local-lock-")); observed.acquire.mockClear(); observed.failure = undefined; });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("serializes normalized paths through native release without poisoning or deleting a newer waiter", async () => {
  const path = join(dir, "record"), firstEntered = gate(), firstRelease = gate(), secondEntered = gate(), secondRelease = gate();
  const error = new Error("synthetic callback failure"), thirdEntered = vi.fn();
  const first = withFileLock(path, options, async () => { expect((await stat(`${path}.lock`)).isFile()).toBe(true); firstEntered.open(); await firstRelease.promise; throw error; });
  const rejected = expect(first).rejects.toBe(error);
  await firstEntered.promise;
  let second: Promise<string> | undefined, third: Promise<string> | undefined;
  try {
    second = withFileLock(`${dir}/unused/../record`, options, async () => { secondEntered.open(); await secondRelease.promise; return "second"; });
    await Promise.resolve(); await Promise.resolve();
    expect(observed.acquire).toHaveBeenCalledTimes(1); expect(observed.acquire).toHaveBeenCalledWith(path, options);
    firstRelease.open(); await rejected; await secondEntered.promise;
    third = withFileLock(path, options, async () => { thirdEntered(); return "third"; });
    await Promise.resolve(); await Promise.resolve();
    expect(observed.acquire).toHaveBeenCalledTimes(2); expect(thirdEntered).not.toHaveBeenCalled();
    secondRelease.open(); expect(await second).toBe("second"); expect(await third).toBe("third");
    expect(observed.acquire).toHaveBeenCalledTimes(3); await expect(stat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally { firstRelease.open(); secondRelease.open(); await Promise.allSettled([first, second, third]); }
});

it("allows independent paths to acquire native locks concurrently", async () => {
  const firstEntered = gate(), secondEntered = gate(), release = gate();
  const first = withFileLock(join(dir, "first"), options, async () => { firstEntered.open(); await release.promise; return 1; });
  await firstEntered.promise;
  let second: Promise<number> | undefined;
  try {
    second = withFileLock(join(dir, "second"), options, async () => { secondEntered.open(); await release.promise; return 2; });
    await secondEntered.promise; expect(observed.acquire).toHaveBeenCalledTimes(2);
    release.open(); expect(await Promise.all([first, second])).toEqual([1, 2]);
  } finally { release.open(); await Promise.allSettled([first, second]); }
});

it("shares serialization across separate module graphs", async () => {
  const path = join(dir, "record"), entered = gate(), release = gate(), later = vi.fn();
  const first = withFileLock(path, options, async () => { entered.open(); await release.promise; }); await entered.promise;
  let second: Promise<string> | undefined;
  try {
    vi.resetModules(); const other = await import("../src/file-lock.js");
    second = other.withFileLock(path, options, async () => { later(); return "second graph"; });
    await Promise.resolve(); await Promise.resolve();
    expect(observed.acquire).toHaveBeenCalledTimes(1); expect(later).not.toHaveBeenCalled();
    release.open(); await first; expect(await second).toBe("second graph"); expect(later).toHaveBeenCalledOnce();
  } finally { release.open(); await Promise.allSettled([first, second]); }
});

it("preserves native acquisition errors and releases the queue for a later caller", async () => {
  const error = Object.assign(new Error("synthetic native lock error"), { code: "file_lock_timeout" }); observed.failure = error;
  const path = join(dir, "record"), firstAction = vi.fn();
  const first = withFileLock(path, options, firstAction), second = withFileLock(path, options, async () => "recovered");
  await expect(first).rejects.toBe(error); expect(await second).toBe("recovered"); expect(firstAction).not.toHaveBeenCalled();
  expect(observed.acquire).toHaveBeenCalledTimes(2);
});
