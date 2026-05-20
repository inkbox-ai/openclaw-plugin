---
name: inkbox-onboarding
description: Use when the user is setting up the Inkbox plugin for the first time, asks "how do I connect my Inkbox account", or runs into config errors like "Inkbox plugin is not configured". Walks the user through obtaining an agent-scoped API key, configuring it, and verifying inbound delivery.
user-invocable: false
---

# Inkbox onboarding

Use this skill the first time a user enables the Inkbox plugin, or any time they hit an error like "Inkbox plugin is not configured" or "Vault is locked".

## What needs to land in config

Three fields go under `plugins.entries.inkbox.config`:

| Field | Required | What it is |
|---|---|---|
| `apiKey` | yes | An **agent-scoped** Inkbox API key (string starting with `ApiKey_...`). |
| `identity` | yes | The agent identity handle the key is bound to (lowercase, 3–63 chars, alphanum + dash). |
| `signingKey` | for inbound | The HMAC secret used to verify webhook signatures. Required if the user wants inbound email/SMS/calls. |

## Step-by-step

1. **Account.** Direct the user to https://inkbox.ai/console. If they don't have an account, the signup flow takes ~1 min and is email-verified.

2. **Identity.** In the Inkbox Console, the user creates an agent identity. This atomically provisions a mailbox at `<handle>@inkboxmail.com` and a tunnel — both ready to use.

3. **Phone (optional but recommended).** If the user wants SMS or voice, they provision a phone number on the identity. Local numbers support SMS; toll-free numbers are voice-only today.

4. **Agent-scoped key.** In the Console, the user mints an agent-scoped key bound to this identity. **Do not use admin-scoped keys with this plugin** — they work for outbound but the plugin is designed around the access patterns of agent-scoped keys.

5. **Signing key (only if inbound is wanted).** The user generates a webhook signing key. The plugin uses it to verify every inbound webhook with HMAC-SHA256 before routing.

6. **Drop the values into OpenClaw config.** Either edit `plugins.entries.inkbox.config` directly, or run the setup wizard once Phase 3 ships (`openclaw inkbox setup`).

7. **Verify.** Once configured, calling any `inkbox_*` tool will:
   - construct the SDK client
   - call `whoami()` (warns if the key isn't agent-scoped — does not block)
   - resolve the identity
   The first successful tool call is the verification.

## Inbound delivery

When `signingKey` is set, the plugin opens an **Inkbox tunnel** at `https://<identity>.inkboxwire.com` and routes inbound mail/SMS/call webhooks into the plugin. The mailbox and phone number's webhook URLs must point at this tunnel. The setup wizard (Phase 3) will wire this automatically; until then the user does it via the Inkbox Console.

If OpenClaw is hosted on a publicly reachable URL, set `publicUrl` in config to skip the tunnel and have webhooks land directly. Phase 7.

## Vault (optional, for credential tools)

If the user wants to use `inkbox_credentials_*` or `inkbox_totp_code`, two extra things:

- The vault must be initialized in the Inkbox Console (one-time, the user picks a vault key — keep it safe; recovery codes are shown once).
- The vault key must be available to the plugin in the `INKBOX_VAULT_KEY` env var (or a custom env var if `vault.keyEnvVar` is configured). The plugin never persists the key — it reads once on first credential access.

Vault tools are all **optional** and must be allowlisted via `tools.allow` before they appear.

## Common errors

| Error | Fix |
|---|---|
| `Inkbox plugin is not configured` | Set `apiKey` + `identity` in config. |
| `whoami failed: 401 Unauthorized` | API key is wrong, revoked, or has a typo. Mint a fresh one in the Console. |
| `whoami: API key is not agent-scoped` (warning, not blocking) | Outbound works, but mint an agent-scoped key for the intended access pattern. |
| `Vault is locked` | Export `INKBOX_VAULT_KEY=<the vault key>` in the shell launching OpenClaw. |
| `404` on `getIdentity` | The `identity` handle in config doesn't match the key's bound identity. |

## What this skill does NOT cover

- Phone number provisioning specifics (carrier types, geographic constraints).
- Custom email-sending-domain setup.
- Org admin operations (rule changes, opt-in registry writes, identity creation/deletion).
