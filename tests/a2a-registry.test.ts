import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  a2aRegistryPath,
  fenceA2AReplyIntent,
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
  it("preserves bounded independent pending state across lifecycle writes", async () => {
    const data = {
      task_id: "task-1",
      context_id: "context-1",
      message_id: "message-1",
    };
    await writeA2ARegistry("key-1", data, "queued");
    await updateA2AProgressJournal("key-1", (journal) => ({
      ...journal,
      acknowledgement: "pending",
      pendingAcknowledgementText: "a".repeat(400),
      pendingProgressText: "p".repeat(400),
      deliveredTexts: Array.from({ length: 30 }, (_, index) => `update-${index}`),
    }));
    await writeA2ARegistry("key-1", data, "running");

    const entry = (await readA2ARegistry())["key-1"];
    expect(entry.progress?.acknowledgement).toBe("pending");
    expect(entry.progress?.pendingAcknowledgementText).toBe("a".repeat(240));
    expect(entry.progress?.pendingProgressText).toBe("p".repeat(240));
    expect(entry.progress?.deliveredTexts).toHaveLength(20);
    expect(entry.progress?.deliveredTexts[0]).toBe("update-10");
    expect((await stat(a2aRegistryPath())).mode & 0o777).toBe(0o600);
  });

  it("migrates legacy pending text and preserves a reply-intent fence", async () => {
    const data = {
      task_id: "task-legacy",
      context_id: "context-legacy",
      message_id: "message-legacy",
    };
    await writeA2ARegistry("key-legacy", data, "running");
    await writeFile(a2aRegistryPath(), `${JSON.stringify({
      "key-legacy": {
        taskId: data.task_id,
        contextId: data.context_id,
        messageId: data.message_id,
        state: "running",
        data,
        progress: {
          startedAt: 1_000,
          acknowledgement: "delivered",
          pendingText: "Legacy periodic update.",
          deliveredTexts: [],
        },
        updatedAt: 1_000,
      },
    })}\n`);

    const migrated = await updateA2AProgressJournal("key-legacy", (journal) => journal);
    await fenceA2AReplyIntent("key-legacy");
    await writeA2ARegistry("key-legacy", data, "finalized");

    expect(migrated.pendingText).toBeUndefined();
    expect(migrated.pendingProgressText).toBe("Legacy periodic update.");
    expect((await readA2ARegistry())["key-legacy"]).toMatchObject({
      state: "finalized",
      replyIntentFenced: true,
    });
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
