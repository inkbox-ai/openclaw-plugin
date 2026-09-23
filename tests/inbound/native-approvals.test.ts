import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ dir: "", resolve: vi.fn() }));
vi.mock("../../src/state.js", async () => ({ statePaths: () => ({ dir: state.dir }), ensureStateDir: () => import("node:fs/promises").then((fs) => fs.mkdir(state.dir, { recursive: true })) }));
vi.mock("openclaw/plugin-sdk/approval-handler-runtime", async (original) => ({ ...await original<any>(), resolveApprovalOverGateway: state.resolve }));
import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import { bindNativeApprovalTurnToRun, ensureNativeApprovalContext, inkboxApprovalCapability, resolveNativeApproval, trackNativeApprovalTurn } from "../../src/inbound/native-approvals.js";
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "native-approval-")); state.resolve.mockReset(); });
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }); });
function setup() {
  const contexts = new Map<string, unknown>();
  const core = { runtimeContexts: { get: ({ capability }: any) => contexts.get(capability), register: ({ capability, context }: any) => { contexts.set(capability, context); return { dispose: () => contexts.delete(capability) }; } } };
  const controller = new AbortController();
  const context = ensureNativeApprovalContext(core, "default", controller.signal)!;
  const binding = { accountId: "default", scope: "group-one", author: "+15555550100", channel: "phone", to: "sms:group-one", sessionKey: "agent:main:group-one", marker: "first-turn-marker", deliver: vi.fn(async () => {}) };
  return { core, context, binding, controller };
}
const id = "11111111-1111-4111-8111-111111111111";
function request(sessionKey: string, runId?: string) { return { id, createdAtMs: Date.now(), expiresAtMs: Date.now() + 60_000, request: { command: "echo synthetic", ask: "always", unavailableDecisions: ["allow-always"], sessionKey, runId, turnSourceChannel: "inkbox", turnSourceAccountId: "default", turnSourceTo: "sms:group-one" } }; }
it("delivers a queued turn's approval only to its original run and rejects wrong scope, sender, and decision", async () => {
  const s = setup(); const release = trackNativeApprovalTurn(s.core, s.binding);
  bindNativeApprovalTurnToRun(s.core, ["default"], { prompt: s.binding.marker }, { sessionKey: s.binding.sessionKey, runId: "first-run" });
  const later = { ...s.binding, author: "+15555550200", marker: "second-turn-marker", deliver: vi.fn(async () => {}) };
  const releaseLater = trackNativeApprovalTurn(s.core, later);
  bindNativeApprovalTurnToRun(s.core, ["default"], { prompt: later.marker }, { sessionKey: later.sessionKey, runId: "second-run" });
  const handler = await createChannelApprovalHandlerFromCapability({ capability: inkboxApprovalCapability, cfg: {}, channel: "inkbox", channelLabel: "Inkbox", accountId: "default", label: "native-contract", clientDisplayName: "Synthetic", context: s.context });
  try {
    await handler!.handleRequested(request(s.binding.sessionKey, "first-run"));
    expect(s.binding.deliver).toHaveBeenCalledTimes(1); expect(later.deliver).not.toHaveBeenCalled();
    for (const owner of [{ ...s.binding, author: later.author }, { ...s.binding, scope: "different-activation" }]) expect(await resolveNativeApproval(owner, `/approve ${id} allow-once`, {})).toBe(false);
    expect(await resolveNativeApproval(s.binding, `/approve ${id} allow-always`, {})).toBe(false);
    expect(state.resolve).not.toHaveBeenCalled();
    expect(await resolveNativeApproval(s.binding, `/approve ${id} allow-once`, {})).toBe(true);
    expect(state.resolve).toHaveBeenCalledTimes(1);
    expect(state.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolveMethod: "exec" }));
    release(); releaseLater(); expect(s.context.bindings.size).toBe(0);
    trackNativeApprovalTurn(s.core, later); s.controller.abort(); expect(s.context.bindings.size).toBe(0);
  } finally { release(); releaseLater(); await handler!.stop(); }
});
it("does not leave an actionable approval after its prompt send fails", async () => {
  const s = setup(); s.binding.deliver.mockRejectedValue(new Error("send failed"));
  const release = trackNativeApprovalTurn(s.core, s.binding);
  const handler = await createChannelApprovalHandlerFromCapability({ capability: inkboxApprovalCapability, cfg: {}, channel: "inkbox", channelLabel: "Inkbox", accountId: "default", label: "native-contract", clientDisplayName: "Synthetic", context: s.context });
  try {
    await handler!.handleRequested(request(s.binding.sessionKey));
    expect(await resolveNativeApproval(s.binding, `/approve ${id} allow-once`, {})).toBe(false);
    expect(state.resolve).not.toHaveBeenCalled();
  } finally { release(); await handler!.stop(); }
});

it("does not attach a stale run's request to a newer sole binding", async () => {
  const s = setup(); const release = trackNativeApprovalTurn(s.core, s.binding);
  bindNativeApprovalTurnToRun(s.core, ["default"], { prompt: s.binding.marker }, { sessionKey: s.binding.sessionKey, runId: "current-run" });
  const handler = await createChannelApprovalHandlerFromCapability({ capability: inkboxApprovalCapability, cfg: {}, channel: "inkbox", channelLabel: "Inkbox", accountId: "default", label: "native-contract", clientDisplayName: "Synthetic", context: s.context });
  try {
    await handler!.handleRequested(request(s.binding.sessionKey, "stale-run"));
    expect(s.binding.deliver).not.toHaveBeenCalled();
    expect(await resolveNativeApproval(s.binding, `/approve ${id} allow-once`, {})).toBe(false);
  } finally { release(); await handler!.stop(); }
});
