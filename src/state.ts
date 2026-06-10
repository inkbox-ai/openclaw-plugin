import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";

// Plugin-local state persisted across sessions. Captures the resolved
// identity properties so non-gateway processes (the CLI, future doctor
// commands, status displays) can read them without re-fetching the API.
//
// NOTE: never store secrets here. apiKey and signingKey live in OpenClaw's
// config or the operator's secret store; this file holds discovery info only.
export interface InkboxIdentityState {
  identityHandle: string;
  emailAddress: string | null;
  phoneNumber: string | null;
  // Optional so state files written before iMessage support still parse.
  imessageEnabled?: boolean;
  tunnelPublicHost: string | null;
  savedAt: string;
}

export interface StatePaths {
  dir: string;
  identityState: string;
}

// Resolves the state directory under $HOME (~/.openclaw/inkbox). Pure —
// does not touch disk; call ensureStateDir() before writing.
export function statePaths(): StatePaths {
  const dir = join(homedir(), ".openclaw", "inkbox");
  return { dir, identityState: join(dir, "identity-state.json") };
}

export async function ensureStateDir(paths: StatePaths = statePaths()): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
}

export async function readIdentityState(): Promise<InkboxIdentityState | null> {
  const paths = statePaths();
  try {
    const buf = await readFile(paths.identityState, "utf8");
    return JSON.parse(buf) as InkboxIdentityState;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function writeIdentityState(state: InkboxIdentityState): Promise<void> {
  const paths = statePaths();
  await ensureStateDir(paths);
  const tmp = `${paths.identityState}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  // 0600 because the file path itself can leak the identity handle (e.g.
  // shoulder-surfing of `ls ~/.openclaw/inkbox/`). State contents aren't
  // secret but this matches the dir mode.
  await chmod(tmp, 0o600);
  await rename(tmp, paths.identityState);
  await chmod(paths.identityState, 0o600);
}
