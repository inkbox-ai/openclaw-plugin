import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ dir: "" }));
vi.mock("../src/state.js", async () => {
  const fs = await import("node:fs/promises");
  return { statePaths: () => ({ dir: state.dir }), ensureStateDir: () => fs.mkdir(state.dir, { recursive: true, mode: 0o700 }) };
});
import * as hosted from "../src/hosted-call-registry.js";
import * as delegations from "../src/a2a-delegations.js";

beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "inkbox-runtime-graphs-")); vi.stubEnv("INKBOX_OPENCLAW_HOME", state.dir); });
afterEach(async () => { vi.unstubAllEnvs(); await rm(state.dir, { recursive: true, force: true }); });

function entry(callId: string): Parameters<typeof hosted.writeHostedCallRegistryEntry>[0] {
  return { accountId: "default", callId, eventId: `event-${callId}`, state: "running", event: { id: `event-${callId}`, event_type: "call.ended", data: { call: { id: callId, mode: "hosted_agent" } } } as any };
}

it("keeps one process owner when a prepared tool journals a gateway-owned call", async () => {
  await hosted.writeHostedCallRegistryEntry(entry("shared-call"));
  const originalOwner = hosted.hostedCallRegistryOwner();
  vi.resetModules();
  const tool = await import("../src/hosted-call-registry.js");
  await tool.recordHostedSmsAttemptPending({ accountId: "default", callId: "shared-call", phase: "initial", toolCallId: "synthetic-tool", targetMatches: true });
  expect(tool.hostedCallRegistryOwner()).toBe(originalOwner);
  expect((await hosted.readHostedCallRegistry())["default:shared-call"].ownerId).toBe(originalOwner);
});

it("does not lose concurrent hosted call writes from separate module graphs", async () => {
  vi.resetModules();
  const tool = await import("../src/hosted-call-registry.js");
  const ids = Array.from({ length: 20 }, (_, index) => `call-${index}`);
  await Promise.all(ids.map((id, index) => (index % 2 ? tool : hosted).writeHostedCallRegistryEntry(entry(id))));
  expect(Object.keys(await hosted.readHostedCallRegistry()).sort()).toEqual(ids.map((id) => `default:${id}`).sort());
});

it("does not lose concurrent delegation fences from separate prepared tool graphs", async () => {
  vi.resetModules();
  const other = await import("../src/a2a-delegations.js");
  const ids = Array.from({ length: 20 }, (_, index) => `message-${index}`);
  const keys = await Promise.all(ids.map((messageId, index) => (index % 2 ? other : delegations).recordBeforeSend({ identityId: "synthetic-agent", rpcUrl: "https://example.test/rpc", cardUrl: "https://example.test/card", messageId })));
  const saved = JSON.parse(await readFile(join(state.dir, "a2a-delegations.json"), "utf8"));
  expect(Object.keys(saved).sort()).toEqual(keys.sort());
});
