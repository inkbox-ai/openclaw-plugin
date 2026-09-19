import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const control = vi.hoisted(() => ({
  dir: "",
  beforeWrite: undefined as undefined | ((data: string) => Promise<void>),
}));

vi.mock("../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return {
    statePaths: () => ({ dir: control.dir }),
    ensureStateDir: () => fs.mkdir(control.dir, { recursive: true }),
  };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await control.beforeWrite?.(String(args[1]));
      return fs.writeFile(...args);
    },
  };
});

afterEach(async () => {
  control.beforeWrite = undefined;
  if (control.dir) await rm(control.dir, { recursive: true, force: true });
});

it("does not restore running state when a reloaded tool journal finishes after completion", async () => {
  control.dir = await mkdtemp(join(tmpdir(), "inkbox-hosted-reload-"));
  const session = await import("../src/hosted-call-registry.js");
  const entry = {
    accountId: "default",
    callId: "call-reload",
    eventId: "event-reload",
    state: "running" as const,
    event: {
      id: "event-reload", event_type: "call.ended",
      data: { call: { id: "call-reload", mode: "hosted_agent" } },
    } as any,
  };
  await session.writeHostedCallRegistryEntry(entry);
  const attempt = {
    accountId: entry.accountId, callId: entry.callId,
    phase: "initial" as const, toolCallId: "tool-reload",
  };
  await session.recordHostedSmsAttemptPending({ ...attempt, targetMatches: true });

  vi.resetModules();
  const tools = await import("../src/hosted-call-registry.js");
  let release!: () => void;
  let reached!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const writing = new Promise<void>((resolve) => { reached = resolve; });
  control.beforeWrite = async (data) => {
    const row = JSON.parse(data)["default:call-reload"];
    if (row?.state === "running" && row.smsAttempts?.[0]?.state === "success") {
      reached();
      await held;
    }
  };
  const settlement = tools.settleHostedSmsAttempt({ ...attempt, state: "success" });
  await writing;
  const completion = session.writeHostedCallRegistryEntry({
    ...entry, state: "completed", outcome: "success",
  });
  // The host may finish dispatch while the non-blocking after-tool hook is
  // still writing. Give that completion a chance to race the held journal.
  try {
    await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 100))]);
  } finally {
    release();
  }
  await Promise.all([settlement, completion]);
  const final = (await session.readHostedCallRegistry())["default:call-reload"];
  expect(final.state).toBe("completed");
  expect(final.outcome).toBe("success");
  expect(final.smsAttempts).toMatchObject([{ state: "success", targetMatches: true }]);
});
