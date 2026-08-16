import { randomUUID } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ensureStateDir, statePaths } from "./state.js";

export interface A2ARegistryData {
  task_id: string;
  context_id: string;
  state?: string;
  message_id?: string;
  caller?: {
    identity_id?: string;
    organization_id?: string;
    handle?: string;
  };
  parts?: Array<Record<string, unknown>>;
}

export interface A2ARegistryEntry {
  taskId: string;
  contextId: string;
  messageId: string;
  state: "queued" | "running" | "finalized";
  data: A2ARegistryData;
  progress?: A2AProgressJournal;
  replyIntentFenced?: boolean;
  updatedAt: number;
}

export interface A2AProgressJournal {
  startedAt: number;
  acknowledgement?: "pending" | "delivered";
  pendingAcknowledgementText?: string;
  pendingProgressText?: string;
  /** Legacy single-slot delivery state, migrated on the next journal update. */
  pendingText?: string;
  deliveredTexts: string[];
}

export type A2ARegistry = Record<string, A2ARegistryEntry>;
let writeChain: Promise<void> = Promise.resolve();

async function mutateA2ARegistry(
  mutate: (registry: A2ARegistry, now: number) => void,
): Promise<void> {
  let release!: () => void;
  const previous = writeChain;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const registry = await readA2ARegistry();
    mutate(registry, Date.now());
    const paths = statePaths();
    await ensureStateDir(paths);
    const target = a2aRegistryPath();
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await rename(tmp, target);
    await chmod(target, 0o600);
  } finally {
    release();
  }
}

export function a2aRegistryPath(): string {
  return join(statePaths().dir, "a2a-tasks.json");
}

export async function readA2ARegistry(): Promise<A2ARegistry> {
  try {
    const loaded = JSON.parse(await readFile(a2aRegistryPath(), "utf8"));
    return loaded && typeof loaded === "object" ? loaded : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeA2ARegistry(
  key: string,
  data: A2ARegistryData,
  state: A2ARegistryEntry["state"],
): Promise<void> {
  await mutateA2ARegistry((registry, now) => {
    const existing = registry[key];
    registry[key] = {
      taskId: data.task_id,
      contextId: data.context_id,
      messageId: data.message_id ?? "",
      state,
      data,
      progress: existing?.progress,
      replyIntentFenced: existing?.replyIntentFenced,
      updatedAt: now,
    };
  });
}

export async function refreshA2ARegistryData(
  key: string,
  data: A2ARegistryData,
): Promise<A2ARegistryEntry | undefined> {
  let result: A2ARegistryEntry | undefined;
  await mutateA2ARegistry((registry, now) => {
    const existing = registry[key];
    if (!existing) return;
    result = registry[key] = {
      ...existing,
      taskId: data.task_id,
      contextId: data.context_id,
      messageId: data.message_id ?? "",
      data,
      updatedAt: now,
    };
  });
  return result;
}

export async function fenceA2AReplyIntent(key: string): Promise<void> {
  await mutateA2ARegistry((registry, now) => {
    const entry = registry[key];
    if (!entry) throw new Error("A2A registry entry is missing.");
    entry.replyIntentFenced = true;
    entry.updatedAt = now;
  });
}

export async function updateA2AProgressJournal(
  key: string,
  update: (journal: A2AProgressJournal) => A2AProgressJournal,
): Promise<A2AProgressJournal> {
  let result!: A2AProgressJournal;
  await mutateA2ARegistry((registry, now) => {
    const entry = registry[key];
    if (!entry) throw new Error("A2A registry entry is missing.");
    const taskStartedAt = Object.values(registry)
      .filter((candidate) => candidate.taskId === entry.taskId)
      .map((candidate) => candidate.progress?.startedAt)
      .filter((value): value is number => typeof value === "number")
      .reduce((earliest, value) => Math.min(earliest, value), now);
    const current = entry.progress ?? {
      startedAt: taskStartedAt,
      deliveredTexts: [],
    };
    const legacyPendingText = current.pendingText;
    const legacyIsAcknowledgement =
      current.acknowledgement === "pending" &&
      legacyPendingText?.startsWith(`Task ${entry.taskId} received`);
    result = update({
      ...current,
      pendingAcknowledgementText:
        current.pendingAcknowledgementText ??
        (legacyIsAcknowledgement ? legacyPendingText : undefined),
      pendingProgressText:
        current.pendingProgressText ??
        (legacyPendingText && !legacyIsAcknowledgement ? legacyPendingText : undefined),
      pendingText: undefined,
    });
    entry.progress = {
      ...result,
      pendingAcknowledgementText: result.pendingAcknowledgementText?.slice(0, 240),
      pendingProgressText: result.pendingProgressText?.slice(0, 240),
      pendingText: undefined,
      deliveredTexts: result.deliveredTexts.slice(-20).map((text) => text.slice(0, 240)),
    };
    entry.updatedAt = now;
    result = entry.progress;
  });
  return result;
}
