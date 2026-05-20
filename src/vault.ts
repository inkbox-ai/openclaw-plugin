import type { InkboxRuntime } from "./client.js";

const DEFAULT_KEY_ENV_VAR = "INKBOX_VAULT_KEY";

export interface VaultRuntimeOptions {
  // Override the env var the unlock key is read from. Defaults to
  // INKBOX_VAULT_KEY. Never persisted — read at unlock time, then forgotten.
  keyEnvVar?: string;
}

// The credentials helper returned by identity.getCredentials(). We keep the
// type loose (`any`) because the SDK's surface is fluent and the agent-facing
// shape only uses a small subset (list / listLogins / listApiKeys /
// listSshKeys / getLogin / getApiKey / getSshKey).
export interface VaultRuntime {
  // Unlocks the vault on first call using the env-var key, then returns the
  // Credentials helper. Cached after first success.
  getCredentials(): Promise<any>;
}

export function createVaultRuntime(
  runtime: InkboxRuntime,
  opts: VaultRuntimeOptions = {},
): VaultRuntime {
  const keyEnvVar = opts.keyEnvVar ?? DEFAULT_KEY_ENV_VAR;
  let unlocked: Promise<any> | null = null;

  async function ensureUnlocked(): Promise<any> {
    if (!unlocked) {
      const key = process.env[keyEnvVar];
      if (!key) {
        throw new Error(
          `Vault is locked. Set the ${keyEnvVar} environment variable to the vault unlock key.`,
        );
      }
      unlocked = (async () => {
        // The vault state is stored on the client after unlock — subsequent
        // identity.getCredentials() calls reuse it.
        const inkbox = await runtime.getClient();
        await inkbox.vault.unlock(key);
        const identity = await runtime.getIdentity();
        return identity.getCredentials();
      })().catch((e) => {
        // Reset so a fresh call can retry (e.g. after the user fixes the key).
        unlocked = null;
        throw e;
      });
    }
    return unlocked;
  }

  return {
    getCredentials: ensureUnlocked,
  };
}
