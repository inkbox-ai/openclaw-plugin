import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hostedCallRegistryPath,
  readHostedCallRegistry,
  recordHostedSmsAttemptPending,
  settleHostedSmsAttempt,
  writeHostedCallRegistryEntry,
} from "../src/hosted-call-registry.js";

let tempHome: string;

function eventFixture(): any {
  return {
    id: "evt-call-1",
    event_type: "call.ended",
    timestamp: "2026-08-01T00:00:00Z",
    secret_unneeded_field: "must-not-persist",
    data: {
      outcome: "completed",
      call: {
        id: "call-1",
        mode: "hosted_agent",
        direction: "outbound",
        status: "completed",
        local_phone_number: "+15550002222",
        remote_phone_number: "+15550001111",
        reason: "release check",
      },
      contacts: [{ id: "contact-1", name: "Alex", private_blob: "omit-me" }],
      post_call_action_items: Array.from({ length: 60 }, (_, index) => ({
        id: `action-${index}`,
        action: `Text Alex marker-${index}`,
        details: "x".repeat(5_000),
        status: "open",
      })),
      transcript: {
        entries: Array.from({ length: 510 }, (_, index) => ({
          party: "remote",
          text: `segment-${index}-${"x".repeat(5_000)}`,
        })),
      },
    },
  };
}

beforeEach(async () => {
  tempHome = await mkdtemp(join(tmpdir(), "inkbox-hosted-registry-"));
  vi.stubEnv("HOME", tempHome);
  const stateDir = join(tempHome, ".openclaw", "inkbox");
  await mkdir(stateDir, { recursive: true, mode: 0o777 });
  await chmod(stateDir, 0o777);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tempHome, { recursive: true, force: true });
});

describe("hosted call durable registry", () => {
  it("bounds replay data and reasserts private file and directory modes", async () => {
    await writeHostedCallRegistryEntry({
      accountId: "default",
      callId: "call-1",
      eventId: "evt-call-1",
      state: "queued",
      event: eventFixture(),
    });

    const raw = await readFile(hostedCallRegistryPath(), "utf8");
    const entry = Object.values(await readHostedCallRegistry())[0] as any;
    expect(raw).not.toContain("must-not-persist");
    expect(raw).not.toContain("omit-me");
    expect(raw).not.toContain("segment-0-");
    expect(entry.event.data.post_call_action_items).toHaveLength(50);
    expect(entry.event.data.post_call_action_items[0].details).toHaveLength(4_000);
    expect(entry.event.data.transcript).toBeUndefined();
    expect((await stat(hostedCallRegistryPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(tempHome, ".openclaw", "inkbox"))).mode & 0o777).toBe(0o700);
  });

  it("journals pending before settlement without raw tool IDs or message bodies", async () => {
    await writeHostedCallRegistryEntry({
      accountId: "default",
      callId: "call-1",
      eventId: "evt-call-1",
      state: "running",
      event: eventFixture(),
    });
    await recordHostedSmsAttemptPending({
      accountId: "default",
      callId: "call-1",
      phase: "initial",
      toolCallId: "raw-tool-id-secret",
      targetMatches: true,
    });

    let raw = await readFile(hostedCallRegistryPath(), "utf8");
    let entry = Object.values(await readHostedCallRegistry())[0] as any;
    expect(entry.smsAttempts).toMatchObject([
      { phase: "initial", targetMatches: true, state: "pending" },
    ]);
    expect(raw).not.toContain("raw-tool-id-secret");

    await settleHostedSmsAttempt({
      accountId: "default",
      callId: "call-1",
      phase: "initial",
      toolCallId: "raw-tool-id-secret",
      state: "success",
    });
    raw = await readFile(hostedCallRegistryPath(), "utf8");
    entry = Object.values(await readHostedCallRegistry())[0] as any;
    expect(entry.smsAttempts[0].state).toBe("success");
    expect(raw).not.toContain("raw-tool-id-secret");
  });

  it.each([
    { state: "completed" as const, retryable: undefined },
    { state: "failed" as const, retryable: false },
  ])("discards replay content for $state receipts", async ({ state, retryable }) => {
    await writeHostedCallRegistryEntry({
      accountId: "default",
      callId: "call-1",
      eventId: "evt-call-1",
      state,
      retryable,
      outcome: "settled",
      event: eventFixture(),
      smsAttempts: [
        {
          phase: "initial",
          toolCallIdHash: "safe-hash",
          targetMatches: true,
          state: "success",
        },
      ],
    });

    const raw = await readFile(hostedCallRegistryPath(), "utf8");
    const entry = Object.values(await readHostedCallRegistry())[0] as any;
    expect(entry.event.data.call).toEqual({ id: "call-1", mode: "hosted_agent" });
    expect(entry.event.data.contacts).toEqual([]);
    expect(entry.event.data.post_call_action_items).toEqual([]);
    expect(entry.smsAttempts).toMatchObject([{ state: "success" }]);
    expect(raw).not.toContain("+15550001111");
    expect(raw).not.toContain("release check");
    expect(raw).not.toContain("Text Alex");
    expect(raw).not.toContain("segment-0-");
  });
});
