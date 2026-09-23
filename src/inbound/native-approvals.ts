import { createHash } from "node:crypto";
import { join } from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { ensureStateDir, statePaths } from "../state.js";
import { createChannelApprovalNativeRuntimeAdapter, resolveApprovalOverGateway, type ChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { contextBuffer } from "./context-buffer.js";
import { sameAuthor } from "./reply-policy.js";

type ApprovalKind = "exec" | "plugin";
type Decision = "allow-once" | "allow-always" | "deny";
export type NativeApprovalOwner = { scope: string; author: string; channel: string; accountId: string };
export type NativeApprovalBinding = NativeApprovalOwner & {
  to: string; threadId?: string; sessionKey: string; marker: string; runId?: string;
  deliver(text: string): Promise<void>;
  ready?(): Promise<void>;
};
type RecordValue = { author: string; kind: ApprovalKind; expiresAt: number; decisions: string[]; resolutionPending?: boolean };
type NativeEntry = { binding: NativeApprovalBinding; id: string };
type NativeContext = { bindings: Map<string, NativeApprovalBinding[]>; accountId: string };
const capability = "approval.native";

export function nativeApprovalScope(account: { accountId: string; config: { baseUrl?: string; identity?: string } }, route: string): string {
  return JSON.stringify(["approvals", account.accountId, account.config.baseUrl ?? "", account.config.identity, route]);
}
function registry(params: { context?: unknown }): NativeContext | undefined {
  const context = params.context as NativeContext | undefined;
  return context?.bindings instanceof Map ? context : undefined;
}
function find(params: { context?: unknown; request: any }): NativeApprovalBinding | undefined {
  const context = registry(params);
  const request = params.request.request;
  if (!context || request.turnSourceChannel !== "inkbox" || (request.turnSourceAccountId && request.turnSourceAccountId !== context.accountId)) return undefined;
  const bindings = context.bindings.get(request.sessionKey) ?? [];
  return request.runId ? bindings.find((binding) => binding.runId === request.runId) : (bindings.length === 1 ? bindings[0] : undefined);
}
export function ensureNativeApprovalContext(core: any, accountId: string, abortSignal?: AbortSignal): NativeContext | undefined {
  if (!core?.runtimeContexts?.register || !core.runtimeContexts.get) return undefined;
  const key = { channelId: "inkbox", accountId, capability };
  const old = core.runtimeContexts.get(key) as NativeContext | undefined;
  const context = old?.bindings instanceof Map ? old : { bindings: new Map<string, NativeApprovalBinding[]>(), accountId };
  if (!old || abortSignal) registerChannelRuntimeContext({ channelRuntime: core, ...key, context, abortSignal });
  abortSignal?.addEventListener("abort", () => context.bindings.clear(), { once: true });
  return context;
}
export function trackNativeApprovalTurn(core: any, binding: NativeApprovalBinding): () => void {
  const context = ensureNativeApprovalContext(core, binding.accountId);
  context?.bindings.set(binding.sessionKey, [...(context.bindings.get(binding.sessionKey) ?? []), binding]);
  return () => {
    if (!context) return;
    const remaining = (context.bindings.get(binding.sessionKey) ?? []).filter((entry) => entry !== binding);
    if (remaining.length) context.bindings.set(binding.sessionKey, remaining); else context.bindings.delete(binding.sessionKey);
  };
}
export function bindNativeApprovalTurnToRun(core: any, accountIds: string[], event: { prompt?: string }, run: { sessionKey?: string; runId?: string }): void {
  if (!run.sessionKey || !run.runId || typeof event.prompt !== "string") return;
  for (const accountId of accountIds) {
    const context = core?.runtimeContexts?.get?.({ channelId: "inkbox", accountId, capability }) as NativeContext | undefined;
    for (const binding of context?.bindings.get(run.sessionKey) ?? []) if (!binding.runId && event.prompt.includes(binding.marker)) binding.runId = run.runId;
  }
}
async function clear(entry: NativeEntry): Promise<void> {
  const buffer = contextBuffer(entry.binding.scope);
  await buffer.acknowledge((await buffer.snapshot()).filter((item) => item.id === entry.id));
}
export async function resolveNativeApproval(owner: NativeApprovalOwner, raw: string, cfg: unknown, beforeResolve?: () => Promise<boolean>): Promise<boolean> {
  const match = /^\/approve\s+(\S+)\s+(allow-once|allow-always|deny)\s*$/i.exec(raw.trim());
  if (!match) return false;
  await ensureStateDir();
  const lock = join(statePaths().dir, `approval-resolution-${createHash("sha256").update(JSON.stringify([owner.scope, match[1]])).digest("hex")}`);
  return withFileLock(lock, { stale: 120_000, retries: { retries: 40, factor: 1.4, minTimeout: 20, maxTimeout: 1000 } }, async () => {
    const buffer = contextBuffer(owner.scope);
    const entry = (await buffer.snapshot()).find((item) => item.id === match[1]);
    if (!entry) return false;
    let record: RecordValue;
    try { record = JSON.parse(entry.body); } catch { return false; }
    if (record.resolutionPending || !["exec", "plugin"].includes(record.kind) || record.expiresAt <= Date.now() || !sameAuthor(owner.channel, record.author, owner.author) || !record.decisions.includes(match[2]!.toLowerCase())) return false;
    if (beforeResolve && !await beforeResolve()) return false;
    const claimed = { ...entry, body: JSON.stringify({ ...record, resolutionPending: true }) };
    // The native lifecycle may have settled the approval during local validation.
    if (!await buffer.replace(entry, claimed)) return true;
    const resolution = { cfg: cfg as any, approvalId: entry.id, decision: match[2]!.toLowerCase() as Decision,
      resolveMethod: record.kind, clientDisplayName: "Inkbox conversation approval" };
    // Older hosts treat an explicit exec method as their default exec resolver.
    // Keep the persisted claim on an uncertain RPC outcome; never replay it.
    await resolveApprovalOverGateway(resolution as unknown as Parameters<typeof resolveApprovalOverGateway>[0]);
    await buffer.acknowledge([claimed]);
    return true;
  });
}

export const inkboxApprovalCapability = {
  native: {
    describeDeliveryCapabilities: ({ request }: any) => ({ enabled: request.request.turnSourceChannel === "inkbox", preferredSurface: "origin" as const, supportsOriginSurface: true, supportsApproverDmSurface: false }),
    resolveOriginTarget: ({ request }: any) => request.request.turnSourceTo ? { to: request.request.turnSourceTo, threadId: request.request.turnSourceThreadId } : null,
  },
  nativeRuntime: createChannelApprovalNativeRuntimeAdapter<string, NativeApprovalBinding, NativeEntry>({
    eventKinds: ["exec", "plugin"],
    availability: { isConfigured: (params) => Boolean(registry(params)), shouldHandle: (params) => Boolean(find(params)) },
    presentation: {
      buildPendingPayload: ({ view }) => [view.title, view.description, "commandText" in view ? view.commandText : undefined, ...view.actions.map((action) => action.command)].filter(Boolean).join("\n"),
      buildResolvedResult: async ({ entry }) => { await clear(entry); return { kind: "leave" }; },
      buildExpiredResult: async ({ entry }) => { await clear(entry); return { kind: "leave" }; },
    },
    transport: {
      prepareTarget: (params) => { const binding = find(params); return binding ? { dedupeKey: `${params.request.id}:${binding.sessionKey}`, target: binding } : null; },
      deliverPending: async (params) => {
        const binding = params.preparedTarget;
        if (find(params) !== binding) return null;
        await binding.deliver(params.pendingPayload);
        const buffer = contextBuffer(binding.scope);
        const entries = await buffer.snapshot();
        await buffer.acknowledge(entries.filter((entry) => { try { return JSON.parse(entry.body).expiresAt <= Date.now(); } catch { return false; } }));
        const record: RecordValue = { author: binding.author, kind: params.approvalKind as ApprovalKind, expiresAt: params.request.expiresAtMs, decisions: params.view.actions.flatMap((action) => "decision" in action ? [action.decision] : []) };
        await buffer.append({ id: params.request.id, body: JSON.stringify(record) });
        await binding.ready?.();
        return { binding, id: params.request.id };
      },
    },
    interactions: { cancelDelivered: async ({ entry }) => clear(entry), unbindPending: async ({ entry }) => clear(entry), bindPending: () => true },
  }) as unknown as ChannelApprovalNativeRuntimeAdapter,
};
