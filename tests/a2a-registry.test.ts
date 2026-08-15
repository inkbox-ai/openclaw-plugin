import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  a2aRegistryPath,
  readA2ARegistry,
  updateA2AProgressJournal,
  writeA2ARegistry,
} from "../src/a2a-registry.js";

let tempHome: string;

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-a2a-registry-"));
  vi.stubEnv("HOME", tempHome);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("A2A durable progress journal", () => {
  it("preserves bounded pending and delivered state across lifecycle writes", async () => {
    const data = {
      task_id: "task-1",
      context_id: "context-1",
      message_id: "message-1",
    };
    await writeA2ARegistry("key-1", data, "queued");
    await updateA2AProgressJournal("key-1", (journal) => ({
      ...journal,
      acknowledgement: "pending",
      pendingText: "x".repeat(400),
      deliveredTexts: Array.from({ length: 30 }, (_, index) => `update-${index}`),
    }));
    await writeA2ARegistry("key-1", data, "running");

    const entry = (await readA2ARegistry())["key-1"];
    expect(entry.progress?.acknowledgement).toBe("pending");
    expect(entry.progress?.pendingText).toHaveLength(240);
    expect(entry.progress?.deliveredTexts).toHaveLength(20);
    expect(entry.progress?.deliveredTexts[0]).toBe("update-10");
    expect((await stat(a2aRegistryPath())).mode & 0o777).toBe(0o600);
  });

  it("keeps elapsed progress time across caller follow-up messages", async () => {
    const first = {
      task_id: "task-1",
      context_id: "context-1",
      message_id: "message-1",
    };
    await writeA2ARegistry("key-1", first, "running");
    await updateA2AProgressJournal("key-1", (journal) => ({
      ...journal,
      startedAt: 1_000,
    }));
    await writeA2ARegistry("key-2", { ...first, message_id: "message-2" }, "running");
    const followUp = await updateA2AProgressJournal("key-2", (journal) => journal);

    expect(followUp.startedAt).toBe(1_000);
  });
});
