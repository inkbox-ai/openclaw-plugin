import { randomUUID } from "node:crypto";
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
  updatedAt: number;
}

export type HostedCallRegistry = Record<string, HostedCallRegistryEntry>;

const PROCESS_OWNER_ID = randomUUID();
let writeChain: Promise<void> = Promise.resolve();

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
    registry[hostedCallRegistryKey(entry.accountId, entry.callId)] = {
      ...entry,
      ownerId: PROCESS_OWNER_ID,
      updatedAt: now,
    };
    const bounded = Object.fromEntries(
      Object.entries(registry)
        .sort((left, right) => right[1].updatedAt - left[1].updatedAt)
        .slice(0, 1_000),
    );
    const paths = statePaths();
    await ensureStateDir(paths);
    const target = hostedCallRegistryPath();
    const temp = `${target}.${process.pid}.${now}.tmp`;
    await writeFile(temp, `${JSON.stringify(bounded, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, target);
    await chmod(target, 0o600);
  } finally {
    release();
  }
}
