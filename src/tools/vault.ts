import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import type { VaultRuntime } from "../vault.js";
import { runTool, toolText } from "../errors.js";
import { formatJson, formatWithHeader } from "../format.js";

// Credential and TOTP tools. ALL marked optional — the user must explicitly
// allow them via `tools.allow`. Plaintext payloads are deliberately gated
// behind separate per-type get_* tools, so the agent can't accidentally
// surface secrets just by listing.
export function registerVaultTools(
  api: any,
  runtime: InkboxRuntime,
  vault: VaultRuntime,
): void {
  api.registerTool(
    {
      name: "inkbox_credentials_list",
      description:
        "List credentials this identity has access to. Returns metadata only (id, name, secretType) — never plaintext. To read a secret's contents, call inkbox_credentials_get_login / _get_api_key / _get_ssh_key.",
      parameters: Type.Object({
        type: Type.Optional(
          Type.Union(
            [
              Type.Literal("login"),
              Type.Literal("api_key"),
              Type.Literal("key_pair"),
              Type.Literal("ssh_key"),
              Type.Literal("other"),
            ],
            { description: "Filter by secret type. Omit for all types." },
          ),
        ),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const creds = await vault.getCredentials();
          // The SDK surface has typed convenience lists; fall back to
          // creds.list() when no filter is set.
          let items: any[];
          switch (params.type) {
            case "login":
              items = creds.listLogins();
              break;
            case "api_key":
              items = creds.listApiKeys();
              break;
            case "key_pair":
              items = creds.listKeyPairs();
              break;
            case "ssh_key":
              items = creds.listSshKeys();
              break;
            default:
              items = creds.list();
              break;
          }
          // Strip the decrypted payload so listing never leaks plaintext.
          const safe = items.map((c) => ({
            id: c.id,
            name: c.name,
            secretType: c.secretType,
            description: c.description,
          }));
          return toolText(
            formatWithHeader(`Returned ${safe.length} credential(s).`, safe),
          );
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_credentials_get_login",
      description:
        "Fetch a login credential (username + password + optional URL) by secret UUID. Returns plaintext — only call when you actually need the credentials to act.",
      parameters: Type.Object({
        secretId: Type.String({ description: "UUID of the login secret." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const creds = await vault.getCredentials();
          const login = creds.getLogin(params.secretId);
          return toolText(formatJson(login));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_credentials_get_api_key",
      description:
        "Fetch an API-key credential by secret UUID. Returns plaintext apiKey + optional endpoint/notes.",
      parameters: Type.Object({
        secretId: Type.String({ description: "UUID of the API-key secret." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const creds = await vault.getCredentials();
          const apiKey = creds.getApiKey(params.secretId);
          return toolText(formatJson(apiKey));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_credentials_get_ssh_key",
      description:
        "Fetch an SSH key credential by secret UUID. Returns plaintext private key + optional public key, fingerprint, and passphrase.",
      parameters: Type.Object({
        secretId: Type.String({ description: "UUID of the SSH-key secret." }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          const creds = await vault.getCredentials();
          const sshKey = creds.getSshKey(params.secretId);
          return toolText(formatJson(sshKey));
        });
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "inkbox_totp_code",
      description:
        "Generate a current TOTP code for a login credential that has TOTP configured. Returns the 6-digit code plus seconds remaining until expiry.",
      parameters: Type.Object({
        secretId: Type.String({
          description: "UUID of the login secret whose TOTP code is wanted.",
        }),
      }),
      async execute(_id: string, params: any) {
        return runTool(async () => {
          // Ensure the vault is unlocked first — getTotpCode requires it.
          await vault.getCredentials();
          const identity = await runtime.getIdentity();
          const code = await identity.getTotpCode(params.secretId);
          return toolText(
            `TOTP code for secret ${params.secretId}: ${code.code} (expires in ${code.secondsRemaining}s)`,
          );
        });
      },
    },
    { optional: true },
  );
}
