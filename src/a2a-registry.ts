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
  updatedAt: number;
}

export type A2ARegistry = Record<string, A2ARegistryEntry>;
let writeChain: Promise<void> = Promise.resolve();

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
  let release!: () => void;
  const previous = writeChain;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const registry = await readA2ARegistry();
    registry[key] = {
      taskId: data.task_id,
      contextId: data.context_id,
      messageId: data.message_id ?? "",
      state,
      data,
      updatedAt: Date.now(),
    };
    const paths = statePaths();
    await ensureStateDir(paths);
    const target = a2aRegistryPath();
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
    await chmod(tmp, 0o600);
    await rename(tmp, target);
    await chmod(target, 0o600);
  } finally {
    release();
  }
}
