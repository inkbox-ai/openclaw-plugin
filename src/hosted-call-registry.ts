import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CallEndedWebhookPayload } from "@inkbox/sdk";
import { ensureStateDir, statePaths } from "./state.js";

export interface HostedCallRegistryEntry {
  accountId: string;
  callId: string;
  eventId: string;
  state: "queued" | "running" | "completed" | "failed";
  ownerId: string;
  outcome?: string;
  retryable?: boolean;
  event: CallEndedWebhookPayload;
  smsAttempts?: HostedSmsJournalEntry[];
  updatedAt: number;
}

export interface HostedSmsJournalEntry {
  phase: "initial" | "correction";
  toolCallIdHash: string;
  targetMatches: boolean;
  state: "pending" | "success" | "failed";
  errorKind?: string;
}

export type HostedCallRegistry = Record<string, HostedCallRegistryEntry>;

const PROCESS_OWNER_ID = randomUUID();
let writeChain: Promise<void> = Promise.resolve();

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

/** Persist only bounded call metadata and open actions needed for one recovery. */
export function boundedHostedCallReplayEvent(
  event: CallEndedWebhookPayload,
): CallEndedWebhookPayload {
  const source = event as any;
  const data = source.data ?? {};
  const call = data.call ?? {};
  const actions = Array.isArray(data.post_call_action_items)
    ? data.post_call_action_items.slice(0, 50).flatMap((action: any) => {
        const actionText = boundedString(action?.action, 4_000);
        if (!actionText) return [];
        return [{
          id: boundedString(action?.id, 256),
          action: actionText,
          details: boundedString(action?.details, 4_000),
          status: boundedString(action?.status, 32) ?? "open",
        }];
      })
    : [];
  const contacts = Array.isArray(data.contacts)
    ? data.contacts.slice(0, 5).flatMap((contact: any) => {
        const id = boundedString(contact?.id, 256);
        if (!id) return [];
        return [{
          id,
          name: boundedString(contact?.name, 512),
          preferred_name: boundedString(contact?.preferred_name, 512),
        }];
      })
    : [];
  return {
    id: boundedString(source.id, 256) ?? `call:${boundedString(call.id, 256) ?? "unknown"}`,
    event_type: "call.ended",
    timestamp: boundedString(source.timestamp, 128) ?? new Date().toISOString(),
    data: {
      call: {
        id: boundedString(call.id, 256) ?? "",
        mode: call.mode,
        direction: call.direction,
        status: call.status,
        local_phone_number: boundedString(call.local_phone_number, 64),
        remote_phone_number: boundedString(call.remote_phone_number, 64) ?? "",
        reason: boundedString(call.reason, 4_000),
        hangup_reason: boundedString(call.hangup_reason, 512),
      },
      outcome: boundedString(data.outcome, 128),
      contacts,
      post_call_action_items: actions,
    },
  } as unknown as CallEndedWebhookPayload;
}

function hostedCallReceiptEvent(event: CallEndedWebhookPayload): CallEndedWebhookPayload {
  const source = event as any;
  const call = source.data?.call ?? {};
  return {
    id: boundedString(source.id, 256) ?? `call:${boundedString(call.id, 256) ?? "unknown"}`,
    event_type: "call.ended",
    timestamp: boundedString(source.timestamp, 128) ?? new Date().toISOString(),
    data: {
      call: {
        id: boundedString(call.id, 256) ?? "",
        mode: call.mode,
      },
      contacts: [],
      post_call_action_items: [],
    },
  } as unknown as CallEndedWebhookPayload;
}

function hashToolCallId(value: string): string {
  return createHash("sha256").update(value || "missing").digest("hex");
}

async function mutateHostedCallRegistry(
  mutate: (registry: HostedCallRegistry, now: number) => void,
): Promise<void> {
  let release!: () => void;
  const previous = writeChain;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const now = Date.now();
    const registry = Object.fromEntries(
      Object.entries(await readHostedCallRegistry()).filter(([, value]) =>
        now - Number(value.updatedAt || 0) < 30 * 24 * 60 * 60 * 1000,
      ),
    );
    mutate(registry, now);
    const bounded = Object.fromEntries(
      Object.entries(registry)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, 1_000),
    );
    const paths = statePaths();
    await ensureStateDir(paths);
    const target = hostedCallRegistryPath();
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(bounded, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, target);
    await chmod(target, 0o600);
  } finally {
    release();
  }
}

export function hostedCallRegistryOwner(): string {
  return PROCESS_OWNER_ID;
}

export function hostedCallRegistryPath(): string {
  return join(statePaths().dir, "hosted-call-completions.json");
}

export function hostedCallRegistryKey(accountId: string, callId: string): string {
  return `${accountId}:${callId}`;
}

export async function readHostedCallRegistry(): Promise<HostedCallRegistry> {
  try {
    const loaded = JSON.parse(await readFile(hostedCallRegistryPath(), "utf8"));
    return loaded && typeof loaded === "object" && !Array.isArray(loaded) ? loaded : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeHostedCallRegistryEntry(
  entry: Omit<HostedCallRegistryEntry, "ownerId" | "updatedAt">,
): Promise<void> {
  await mutateHostedCallRegistry((registry, now) => {
    const key = hostedCallRegistryKey(entry.accountId, entry.callId);
    const existing = registry[key];
    const canReplay =
      entry.state === "queued" ||
      entry.state === "running" ||
      (entry.state === "failed" && entry.retryable === true);
    registry[key] = {
      ...entry,
      event: canReplay
        ? boundedHostedCallReplayEvent(entry.event)
        : hostedCallReceiptEvent(entry.event),
      smsAttempts: entry.smsAttempts ?? existing?.smsAttempts ?? [],
      ownerId: PROCESS_OWNER_ID,
      updatedAt: now,
    };
  });
}

export async function recordHostedSmsAttemptPending(params: {
  accountId: string;
  callId: string;
  phase: "initial" | "correction";
  toolCallId: string;
  targetMatches: boolean;
}): Promise<void> {
  await mutateHostedCallRegistry((registry, now) => {
    const key = hostedCallRegistryKey(params.accountId, params.callId);
    const existing = registry[key];
    if (!existing) throw new Error("Hosted call registry entry is missing.");
    const attempts = existing.smsAttempts ?? [];
    attempts.push({
      phase: params.phase,
      toolCallIdHash: hashToolCallId(params.toolCallId),
      targetMatches: params.targetMatches,
      state: "pending",
    });
    existing.smsAttempts = attempts.slice(0, 4);
    existing.updatedAt = now;
    existing.ownerId = PROCESS_OWNER_ID;
  });
}

export async function settleHostedSmsAttempt(params: {
  accountId: string;
  callId: string;
  phase: "initial" | "correction";
  toolCallId: string;
  state: "success" | "failed";
  errorKind?: string;
}): Promise<void> {
  await mutateHostedCallRegistry((registry, now) => {
    const key = hostedCallRegistryKey(params.accountId, params.callId);
    const existing = registry[key];
    if (!existing) throw new Error("Hosted call registry entry is missing.");
    const id = hashToolCallId(params.toolCallId);
    const attempt = [...(existing.smsAttempts ?? [])]
      .reverse()
      .find((item) => item.phase === params.phase && item.toolCallIdHash === id);
    if (!attempt || attempt.state !== "pending") {
      throw new Error("Hosted SMS pending journal entry is missing.");
    }
    attempt.state = params.state;
    attempt.errorKind = params.errorKind;
    existing.updatedAt = now;
    existing.ownerId = PROCESS_OWNER_ID;
  });
}
