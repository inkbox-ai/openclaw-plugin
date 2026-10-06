import { randomUUID } from "node:crypto";
import { revokeNativeSourceRun } from "./native-source.js";

type Owner = { sessionKey: string; marker: string; runId?: string; closed: boolean; bind(sessionKey: string, runId: string): Promise<void>; terminal(): Promise<void> };
const registry = Symbol.for("inkbox.native-owner.v1");
const state = globalThis as typeof globalThis & { [registry]?: Set<Owner> };
const owners = state[registry] ??= new Set<Owner>();
const retiredKey = Symbol.for("inkbox.retired-native-runs.v1");
const retiredState = globalThis as typeof globalThis & { [retiredKey]?: Set<string> };
const retired = retiredState[retiredKey] ??= new Set<string>();
export function guardRetiredNativeRun(_event: unknown, context: { runId?: string }) {
  if (context.runId && retired.has(context.runId)) return { block: true, blockReason: "This source turn has already ended or is being fenced. Its tools cannot act on a successor turn." };
}
export function trackNativeOwner(sessionKey: string, bind: Owner["bind"], terminal: Owner["terminal"]) {
  const owner: Owner = { sessionKey, marker: `[Inkbox durable turn: ${randomUUID()}]`, bind, terminal, closed: false };
  owners.add(owner);
  return { marker: owner.marker, close() { owner.closed = true; if (owner.runId) retired.add(owner.runId); owners.delete(owner); } };
}
export async function bindNativeOwner(event: { prompt?: string }, context: { sessionKey?: string; runId?: string }) {
  if (!context.sessionKey || !context.runId || typeof event.prompt !== "string") return;
  for (const owner of owners) if (!owner.closed && !owner.runId && owner.sessionKey === context.sessionKey && event.prompt.includes(owner.marker)) {
    // Ownership must survive a restart before native model/tool execution begins.
    owner.runId = context.runId;
    try { await owner.bind(context.sessionKey, context.runId); }
    catch {
      retired.add(context.runId);
      revokeNativeSourceRun(context.sessionKey, context.runId);
      return { outcome: "block" as const, reason: "The source turn is no longer authorized to start. Its native ownership is retained for reconciliation." };
    }
  }
}
export async function settleNativeOwner(_event: unknown, context: { sessionKey?: string; runId?: string }) {
  for (const owner of owners) if (!owner.closed && owner.sessionKey === context.sessionKey && owner.runId && owner.runId === context.runId) await owner.terminal();
}
/** A timeout, missing run, or accepted abort alone is not terminal evidence. */
export async function fenceNativeOwner(sessionKey: string, runId: string): Promise<boolean> {
  retired.add(runId);
  revokeNativeSourceRun(sessionKey, runId);
  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const options = { timeout: "6000", json: true };
    const inspect = () => callGatewayFromCli("agent.wait", options, { runId, timeoutMs: 1000 });
    const terminal = (value: Record<string, unknown>) => value.runId === runId && ["ok", "error"].includes(String(value.status)) && typeof value.endedAt === "number";
    if (terminal(await inspect())) return true;
    await callGatewayFromCli("chat.abort", options, { sessionKey, runId });
    return terminal(await inspect());
  } catch { return false; }
}
