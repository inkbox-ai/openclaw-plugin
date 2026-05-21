import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// Override $HOME so statePaths() lands inside a temp dir we can clean up.
let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-state-test-"));
  vi.stubEnv("HOME", tempHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

// Note: import after env stubbing so homedir() picks up the override.
async function loadState() {
  return await import("../src/state.js");
}

describe("statePaths", () => {
  it("resolves under $HOME/.openclaw/inkbox/", async () => {
    const { statePaths } = await loadState();
    const paths = statePaths();
    expect(paths.dir).toBe(join(tempHome, ".openclaw", "inkbox"));
    expect(paths.identityState).toBe(
      join(tempHome, ".openclaw", "inkbox", "identity-state.json"),
    );
  });
});

describe("readIdentityState", () => {
  it("returns null when no state file exists", async () => {
    const { readIdentityState } = await loadState();
    const state = await readIdentityState();
    expect(state).toBeNull();
  });

  it("round-trips through writeIdentityState", async () => {
    const { readIdentityState, writeIdentityState } = await loadState();
    await writeIdentityState({
      identityHandle: "sales-agent",
      emailAddress: "sales-agent@inkboxmail.com",
      phoneNumber: "+15551234567",
      tunnelPublicHost: "sales-agent.inkboxwire.com",
      savedAt: "2026-05-21T00:00:00Z",
    });
    const got = await readIdentityState();
    expect(got).toEqual({
      identityHandle: "sales-agent",
      emailAddress: "sales-agent@inkboxmail.com",
      phoneNumber: "+15551234567",
      tunnelPublicHost: "sales-agent.inkboxwire.com",
      savedAt: "2026-05-21T00:00:00Z",
    });
  });

  it("writes with 0600 permissions", async () => {
    const { writeIdentityState, statePaths } = await loadState();
    await writeIdentityState({
      identityHandle: "agent",
      emailAddress: null,
      phoneNumber: null,
      tunnelPublicHost: null,
      savedAt: "2026-05-21T00:00:00Z",
    });
    const info = await stat(statePaths().identityState);
    // Mask off the high bits; we only care about the mode bits.
    expect((info.mode & 0o777)).toBe(0o600);
  });

  it("produces JSON the test can decode independently", async () => {
    const { writeIdentityState, statePaths } = await loadState();
    await writeIdentityState({
      identityHandle: "x",
      emailAddress: null,
      phoneNumber: null,
      tunnelPublicHost: null,
      savedAt: "2026-05-21T00:00:00Z",
    });
    const raw = await readFile(statePaths().identityState, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.identityHandle).toBe("x");
  });
});
