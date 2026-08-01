import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { statePaths } from "./state.js";

export interface A2ADelegationRecord {
  identityId: string;
  origin: string;
  cardUrl: string;
  contextId?: string;
  taskId?: string;
  messageId: string;
  sessionKey?: string;
  updatedAt: number;
}

type Records = Record<string, A2ADelegationRecord>;
let writeChain: Promise<void> = Promise.resolve();

function filePath(): string {
  return join(
    process.env.INKBOX_OPENCLAW_HOME?.trim() || statePaths().dir,
    "a2a-delegations.json",
  );
}

function origin(url: string): string {
  return new URL(url).origin.toLowerCase();
}

async function read(): Promise<Records> {
  try {
    const loaded = JSON.parse(await readFile(filePath(), "utf8"));
    return loaded && typeof loaded === "object" ? loaded : {};
  } catch (error: any) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function mutate(change: (records: Records) => void): Promise<void> {
  let release!: () => void;
  const previous = writeChain;
  writeChain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const records = await read();
    change(records);
    const target = filePath();
    await mkdir(dirname(target), {
      recursive: true,
      mode: 0o700,
    });
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, {
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

export async function recordBeforeSend(input: {
  identityId: string;
  rpcUrl: string;
  cardUrl: string;
  contextId?: string;
  taskId?: string;
  messageId: string;
  sessionKey?: string;
}): Promise<string> {
  const resolvedOrigin = origin(input.rpcUrl);
  const contextKey = input.contextId ?? `pending:${input.messageId}`;
  const key = `${input.identityId}|${resolvedOrigin}|${contextKey}`;
  await mutate((records) => {
    records[key] = {
      identityId: input.identityId,
      origin: resolvedOrigin,
      cardUrl: input.cardUrl,
      contextId: input.contextId,
      taskId: input.taskId,
      messageId: input.messageId,
      sessionKey: input.sessionKey,
      updatedAt: Date.now(),
    };
  });
  return key;
}

export async function promoteAfterSend(
  pendingKey: string,
  contextId: string,
  taskId: string,
): Promise<void> {
  await mutate((records) => {
    const record = records[pendingKey];
    if (!record) return;
    delete records[pendingKey];
    record.contextId = contextId;
    record.taskId = taskId;
    record.updatedAt = Date.now();
    records[`${record.identityId}|${record.origin}|${contextId}`] = record;
  });
}

export async function findDelegationByTask(
  taskId: string,
): Promise<A2ADelegationRecord | undefined> {
  return Object.values(await read())
    .filter((record) => record.taskId === taskId)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
}
