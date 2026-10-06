import { afterEach, describe, expect, it, vi } from "vitest";
import { Inkbox } from "@inkbox/sdk";
import { createVaultRuntime } from "../src/vault.js";
import { registerVaultTools } from "../src/tools/vault.js";
const secretId = "11111111-1111-4111-8111-111111111111", identityId = "22222222-2222-4222-8222-222222222222";
const access = [{ identityId, vaultSecretId: secretId }];
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function fixture() {
  const getSecret = vi.fn(async () => ({ secretType: "login", payload: { username: "synthetic", password: "one", totp: { secret: "do-not-expose" } } }));
  const getTotpCode = vi.fn(async () => ({ code: "123456", secondsRemaining: 10 }));
  const vault = { listSecrets: vi.fn(async () => [{ id: secretId, name: "Synthetic", secretType: "login", access, payload: "never listed", encryptedPayload: "never listed" }]), listAccessRules: vi.fn(async () => access), unlock: vi.fn(async () => ({ getSecret, getTotpCode })) };
  const client = { vault }, runtime = { getClient: async () => client, getIdentity: async () => ({ id: identityId }) };
  return { vault, getSecret, getTotpCode, helper: createVaultRuntime(runtime as any), runtime };
}
describe("selective Vault read semantics", () => {
  it("lists only configured identity metadata without unlocking or reading any payload", async () => {
    const f = fixture(); f.vault.listSecrets.mockResolvedValue([{ id: secretId, name: "Synthetic", secretType: "login", access }, { id: "other", name: "Hidden", secretType: "login", access: [] }] as any);
    expect(await f.helper.list()).toEqual([{ id: secretId, name: "Synthetic", secretType: "login", description: undefined }]);
    expect(f.vault.unlock).not.toHaveBeenCalled(); expect(f.getSecret).not.toHaveBeenCalled();
  });
  it("freshly checks access and reads each secret without returning the TOTP seed", async () => {
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "synthetic-local-key"); const f = fixture();
    expect(await f.helper.getSecret(secretId, "login")).toEqual({ username: "synthetic", password: "one", has_totp: true });
    f.getSecret.mockResolvedValue({ secretType: "login", payload: { password: "rotated" } } as any);
    expect(await f.helper.getSecret(secretId, "login")).toEqual({ password: "rotated", has_totp: false });
    expect(f.vault.unlock).toHaveBeenCalledTimes(1); expect(f.getSecret).toHaveBeenCalledTimes(2); expect(f.vault.listAccessRules).toHaveBeenCalledTimes(4);
    f.vault.listAccessRules.mockResolvedValue([]);
    await expect(f.helper.getSecret(secretId)).rejects.toThrow("no longer has access"); expect(f.getSecret).toHaveBeenCalledTimes(2);
    await expect(f.helper.getTotpCode(secretId)).rejects.toThrow("no longer has access"); expect(f.getTotpCode).not.toHaveBeenCalled();
  });
  it("requests a current code on every call and resets failed unlocks", async () => {
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "synthetic-local-key"); const f = fixture();
    f.vault.unlock.mockRejectedValueOnce(new Error("locked"));
    await expect(f.helper.getTotpCode(secretId)).rejects.toThrow("locked");
    expect(await f.helper.getTotpCode(secretId)).toEqual({ code: "123456", secondsRemaining: 10 });
    f.getTotpCode.mockResolvedValue({ code: "654321", secondsRemaining: 29 });
    expect(await f.helper.getTotpCode(secretId)).toEqual({ code: "654321", secondsRemaining: 29 });
    expect(f.vault.unlock).toHaveBeenCalledTimes(2); expect(f.getTotpCode).toHaveBeenCalledTimes(2);
  });
  it("does not reuse cached unlock after local key removal or a rejected key rotation", async () => {
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "first-key"); const f = fixture(); await f.helper.getSecret(secretId);
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "wrong-rotated-key"); f.vault.unlock.mockRejectedValueOnce(new Error("key rejected"));
    await expect(f.helper.getSecret(secretId)).rejects.toThrow("key rejected"); expect(f.getSecret).toHaveBeenCalledTimes(1);
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "valid-rotated-key"); await f.helper.getSecret(secretId); expect(f.vault.unlock).toHaveBeenCalledTimes(3);
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", ""); await expect(f.helper.getTotpCode(secretId)).rejects.toThrow("Vault is locked"); expect(f.getTotpCode).not.toHaveBeenCalled();
    expect(await f.helper.list()).toHaveLength(1);
  });
  it.each(["plaintext", "code"])("withholds an in-flight %s result when the local key is revoked", async (kind) => {
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "first-key"); const f = fixture();
    if (kind === "plaintext") f.getSecret.mockImplementation(async () => { vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", ""); return { secretType: "login", payload: { password: "must-not-return" } } as any; });
    else f.getTotpCode.mockImplementation(async () => { vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "different-key"); return { code: "000001", secondsRemaining: 30 }; });
    await expect(kind === "plaintext" ? f.helper.getSecret(secretId) : f.helper.getTotpCode(secretId)).rejects.toThrow(/Vault is locked|key changed/);
  });
  it.each(["plaintext", "code"])("withholds %s if an administrative-key grant is revoked during the SDK read", async (kind) => {
    vi.stubEnv("INKBOX_OPENCLAW_VAULT_KEY", "local-key"); const f = fixture();
    if (kind === "plaintext") f.getSecret.mockImplementation(async () => { f.vault.listAccessRules.mockResolvedValue([]); return { secretType: "login", payload: { password: "must-not-return" } } as any; });
    else f.getTotpCode.mockImplementation(async () => { f.vault.listAccessRules.mockResolvedValue([]); return { code: "000001", secondsRemaining: 30 }; });
    await expect(kind === "plaintext" ? f.helper.getSecret(secretId) : f.helper.getTotpCode(secretId)).rejects.toThrow("no longer has access");
    expect(f.vault.listAccessRules).toHaveBeenCalledTimes(2);
  });
  it("retains explicit optional tool gates, including generic retrieval", () => {
    const f = fixture(), registrations: any[] = [];
    registerVaultTools({ registerTool: (tool: any, options: any) => registrations.push({ tool, options }) }, f.runtime as any, f.helper);
    expect(registrations.length).toBe(6); expect(registrations.every((r) => r.options.optional === true)).toBe(true);
    expect(registrations.map((r) => r.tool.name)).toContain("inkbox_credentials_get_secret");
  });
  it("uses actual published SDK metadata transport while locked", async () => {
    vi.stubEnv("INKBOX_VAULT_KEY", ""); delete process.env.INKBOX_VAULT_KEY;
    const fetch = vi.fn(async () => new Response(JSON.stringify([{ id: secretId, name: "Synthetic", secret_type: "login", access: [{ id: "rule", identity_id: identityId, vault_secret_id: secretId, created_at: "2026-01-01" }], created_at: "2026-01-01", updated_at: "2026-01-01" }]), { headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    const sdk = new Inkbox({ apiKey: "synthetic-key", baseUrl: "https://sdk.test" });
    const helper = createVaultRuntime({ getClient: async () => sdk, getIdentity: async () => ({ id: identityId }) } as any);
    expect(await helper.list()).toEqual([{ id: secretId, name: "Synthetic", secretType: "login", description: undefined }]);
    expect(fetch).toHaveBeenCalledTimes(1); expect(String(fetch.mock.calls[0]?.[0])).toContain("/vault/secrets");
  });
});
