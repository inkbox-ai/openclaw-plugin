import type { InkboxRuntime } from "./client.js";
import type { UnlockedVault } from "@inkbox/sdk";

export interface VaultRuntimeOptions { keyEnvVar?: string }
export interface VaultRuntime {
  list(type?: string): Promise<unknown[]>;
  getSecret(secretId: string, expectedType?: string): Promise<Record<string, unknown>>;
  getTotpCode(secretId: string): Promise<{ code: string; secondsRemaining: number }>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function createVaultRuntime(runtime: InkboxRuntime, opts: VaultRuntimeOptions = {}): VaultRuntime {
  const keyEnvVar = opts.keyEnvVar ?? "INKBOX_OPENCLAW_VAULT_KEY";
  let unlocked: Promise<UnlockedVault> | undefined;
  let owner: string | undefined;
  let ownerClient: unknown;
  async function unlock(): Promise<UnlockedVault> {
    const client = await runtime.getClient(), identity = await runtime.getIdentity();
    if (owner !== identity.id || ownerClient !== client) { unlocked = undefined; owner = identity.id; ownerClient = client; }
    if (!unlocked) {
      const key = process.env[keyEnvVar];
      if (!key) throw new Error(`Vault is locked. Set ${keyEnvVar} locally; do not send the key in chat.`);
      unlocked = (async () => {
        return client.vault.unlock(key, { identityId: identity.id });
      })().catch((error) => { unlocked = undefined; throw error; });
    }
    return unlocked;
  }
  async function permitted(secretId: string) {
    const client = await runtime.getClient(), identity = await runtime.getIdentity();
    const rules = await client.vault.listAccessRules(secretId);
    if (!rules.some((rule) => rule.identityId === identity.id && rule.vaultSecretId === secretId)) throw new Error("This identity no longer has access to the requested secret.");
  }
  function id(value: string) { if (!uuid.test(value)) throw new Error("secretId must be a UUID from inkbox_credentials_list."); return value; }
  return {
    async list(type) {
      const identity = await runtime.getIdentity();
      return (await (await runtime.getClient()).vault.listSecrets(type ? { secretType: type } : {})).filter((secret) => secret.access?.some((rule) => rule.identityId === identity.id && rule.vaultSecretId === secret.id)).map(({ id, name, secretType, description }) => ({ id, name, secretType, description }));
    },
    async getSecret(secretId, expectedType) {
      id(secretId);
      await permitted(secretId);
      const secret = await (await unlock()).getSecret(secretId);
      if (expectedType && secret.secretType !== expectedType) throw new Error(`The requested secret is not ${expectedType}.`);
      const payload = { ...secret.payload } as Record<string, unknown>;
      if (secret.secretType === "login") { payload.has_totp = payload.totp != null; delete payload.totp; }
      return payload;
    },
    async getTotpCode(secretId) { id(secretId); await permitted(secretId); return (await unlock()).getTotpCode(secretId); },
  };
}
