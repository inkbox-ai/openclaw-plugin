# @inkbox/openclaw-plugin

[Inkbox](https://inkbox.ai) channel plugin for [OpenClaw](https://openclaw.ai). It gives an OpenClaw agent its own Inkbox identity: mailbox, phone number, SMS, voice calls, contacts, notes, contact rules, identity access, and optional credential vault access without forking OpenClaw.

Status: outbound tools, read tools, bundled skills, setup wizard, doctor checks, SMS batching, inbound email/SMS/voice, realtime phone calls, post-call actions, and package-included skills are implemented. ClawHub publishing is still pending.

## Prerequisites

- An installed OpenClaw agent, `2026.5.19` or newer. Start at [openclaw.ai](https://openclaw.ai/) or follow the [OpenClaw install docs](https://docs.openclaw.ai/install/index).
- The recommended OpenClaw installer for macOS, Linux, or WSL2:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw --version
```

If you already manage Node yourself, the OpenClaw docs also support:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

- An Inkbox account or API key. `openclaw inkbox setup` can guide a new agent identity through signup/setup.

## Quick Start

Run these from the plugin checkout after the OpenClaw prerequisite above is installed:

```bash
git clone https://github.com/inkbox-ai/openclaw-plugin.git
cd openclaw-plugin
npm install
npm run build
openclaw --version
openclaw plugins install -l ./
```

Authenticate OpenClaw with any model provider the agent should use:

```bash
openclaw configure --section model
```

Configure Inkbox:

```bash
openclaw inkbox setup
openclaw inkbox doctor
```

The setup wizard writes `channels.inkbox` into the active OpenClaw profile and adds the Inkbox tool group to the profile's tool policy.


Start the gateway:

```bash
openclaw gateway run --allow-unconfigured --force --verbose --compact
```

Keep that process running. On startup the plugin opens an Inkbox tunnel, sets mailbox and phone webhooks, and routes inbound email, SMS, and calls into OpenClaw sessions.

## Setup Wizard

`openclaw inkbox setup` walks the current OpenClaw profile through Inkbox configuration:

1. Authenticates to Inkbox or uses the API key already present in config.
2. Resolves or creates the Inkbox agent identity for this OpenClaw agent.
3. Stores an agent-scoped API key, the identity handle, and webhook signing key in `channels.inkbox`.
4. Optionally provisions a phone number and prints the final mailbox/phone summary.

If setup provisions a new local phone number, it waits for SMS `START` opt-in before finishing. It also seeds `~/.openclaw/inkbox/identity-state.json` so `openclaw inkbox doctor` can show useful channel state.

Inkbox reachability is controlled server-side with mailbox and phone contact rules in the Inkbox Console. The plugin does not create a second local inbound allowlist unless you explicitly set `allowedInboundContactIds`.

## Manual Config

Preferred config shape:

```json
{
  "channels": {
    "inkbox": {
      "apiKey": "ApiKey_xxxxxxxxxxxx",
      "identity": "my-agent-handle",
      "signingKey": "whsec_xxxxxxxxxxxx"
    }
  },
  "tools": {
    "allow": ["inkbox"]
  }
}
```

Equivalent config commands:

```bash
openclaw config set channels.inkbox.enabled true --strict-json
openclaw config set channels.inkbox.apiKey "ApiKey_xxxxxxxxxxxx"
openclaw config set channels.inkbox.identity "my-agent-handle"
openclaw config set channels.inkbox.signingKey "whsec_xxxxxxxxxxxx"
openclaw config set tools.allow '["inkbox"]' --strict-json
openclaw config validate
```

Env vars are also supported by the plugin and CLI:

```bash
export INKBOX_API_KEY="ApiKey_xxxxxxxxxxxx"
export INKBOX_IDENTITY="my-agent-handle"
export INKBOX_SIGNING_KEY="whsec_xxxxxxxxxxxx"
export INKBOX_BASE_URL="https://inkbox.ai"
```

Legacy plugin-scoped config under `plugins.entries.inkbox.config` still works, but new installs should use `channels.inkbox`.

## Optional Tools

`"inkbox"` in `tools.allow` enables the required tools. Optional tools must be listed by name.

Common full-access smoke allowlist, excluding vault plaintext tools:

```bash
openclaw config set tools.allow '[
  "inkbox",
  "inkbox_forward_email",
  "inkbox_place_call",
  "inkbox_mark_emails_read",
  "inkbox_list_texts",
  "inkbox_get_text",
  "inkbox_mark_text_read",
  "inkbox_mark_text_conversation_read",
  "inkbox_update_contact",
  "inkbox_delete_contact",
  "inkbox_export_contact_vcard",
  "inkbox_update_note",
  "inkbox_delete_note",
  "inkbox_list_mail_contact_rules",
  "inkbox_create_mail_contact_rule",
  "inkbox_update_mail_contact_rule",
  "inkbox_delete_mail_contact_rule",
  "inkbox_list_phone_contact_rules",
  "inkbox_create_phone_contact_rule",
  "inkbox_update_phone_contact_rule",
  "inkbox_delete_phone_contact_rule",
  "inkbox_list_contact_access",
  "inkbox_grant_contact_access",
  "inkbox_revoke_contact_access",
  "inkbox_list_note_access",
  "inkbox_grant_note_access",
  "inkbox_revoke_note_access",
  "inkbox_whoami"
]' --strict-json
```

Add vault tools only when the identity has vault access and the gateway environment has the vault unlock key:

```bash
export INKBOX_VAULT_KEY="..."
openclaw config set tools.allow '[
  "inkbox",
  "inkbox_credentials_list",
  "inkbox_credentials_get_login",
  "inkbox_credentials_get_api_key",
  "inkbox_credentials_get_ssh_key",
  "inkbox_totp_code"
]' --strict-json
```

## Realtime Calls

Default calls use Inkbox STT/TTS. To use raw Inkbox call media through an OpenClaw realtime voice provider, first configure a realtime-capable provider. For OpenAI Realtime, use either an OpenAI API key in the gateway environment or an OpenClaw auth profile that the OpenAI provider can use.

```bash
export OPENAI_API_KEY="sk-..."
openclaw configure --section model
openclaw config set channels.inkbox.voiceRealtime.enabled true --strict-json
openclaw config set channels.inkbox.voiceRealtime.provider openai
openclaw config set channels.inkbox.voiceRealtime.model gpt-realtime
openclaw config set channels.inkbox.voiceRealtime.voice cedar
openclaw config set channels.inkbox.voiceRealtime.toolPolicy owner
openclaw config set channels.inkbox.voiceRealtime.consultPolicy substantive
openclaw gateway run --allow-unconfigured --force --verbose --compact
```

Realtime calls receive the agent's Inkbox handle, mailbox, phone number, caller contact metadata, and outbound-call purpose before greeting. If realtime auth/provider config is unavailable, calls fall back to Inkbox STT/TTS unless `voiceRealtime.fallbackToInkboxSttTts` is set to `false`.

Disable realtime:

```bash
openclaw config set channels.inkbox.voiceRealtime.enabled false --strict-json
```

## CLI

```bash
openclaw inkbox setup
openclaw inkbox doctor
openclaw inkbox whoami
openclaw doctor
openclaw status
```

Useful OpenClaw commands while iterating:

```bash
openclaw config file
openclaw config get channels.inkbox
openclaw config validate
openclaw plugins list
openclaw skills list
openclaw logs
```

Optional provider-specific auth examples:

```bash
openclaw models auth login --provider openai --set-default
openclaw models auth login --provider openai-codex --set-default
```

## Smoke Test

After the gateway prints `[gateway] ready`, `[inkbox] tunnel open`, mailbox webhook set, and phone webhook set:

1. Run `openclaw inkbox doctor`.
2. Text `START` to the agent's Inkbox phone number from every phone the agent should text.
3. Send the agent an SMS and verify it replies in the same SMS thread.
4. Send the agent an email and verify it replies from its Inkbox mailbox.
5. Call the agent phone number and ask for its handle, email, and phone.
6. Ask during a call for a post-call SMS or email follow-up, then verify it sends after hangup.
7. Ask the agent to save a contact and an Inkbox note, then ask it to read them back.

## Config Reference

| Field | Required | Default | Description |
|---|---|---|---|
| `apiKey` | yes | - | Agent-scoped Inkbox API key. Admin keys are accepted by setup only so it can mint an agent-scoped key. |
| `identity` | yes | - | Inkbox agent identity handle. |
| `signingKey` | inbound | - | Webhook HMAC secret. Required for inbound email/SMS/calls. |
| `baseUrl` | no | `https://inkbox.ai` | Override Inkbox API base URL. |
| `tunnelName` | no | identity handle | Override Inkbox tunnel name. |
| `publicUrl` | no | - | Public OpenClaw URL. If omitted, the plugin opens an Inkbox tunnel. |
| `allowedRecipients` | no | - | Outbound recipient allowlist. Empty means no local outbound filtering. |
| `allowedInboundContactIds` | no | - | Optional local inbound allowlist by Inkbox contact UUID. Empty means Inkbox contact rules decide reachability. |
| `sms.batchDelayMs` | no | `0` | Inbound SMS fragment batching window. |
| `voiceTranscriptCoalesceMs` | no | plugin default | Non-realtime voice transcript coalescing window. |
| `voiceAgentPrewarm` | no | plugin default | Prewarm the voice path when the gateway starts. |
| `voiceRealtime.enabled` | no | `false` | Use raw phone media with an OpenClaw realtime voice provider. |
| `voiceRealtime.provider` | no | runtime default | Realtime provider id, for example `openai`. |
| `voiceRealtime.model` | no | provider default | Realtime model override, for example `gpt-realtime`. |
| `voiceRealtime.voice` | no | provider default | Realtime voice name. |
| `voiceRealtime.toolPolicy` | no | `owner` | Tool policy for realtime `openclaw_agent_consult`. |
| `voiceRealtime.consultPolicy` | no | `substantive` | When realtime calls should consult the main OpenClaw agent. |
| `voiceRealtime.fallbackToInkboxSttTts` | no | `true` | Fall back to Inkbox STT/TTS when realtime is unavailable. |
| `vault.keyEnvVar` | no | `INKBOX_VAULT_KEY` | Env var containing the vault unlock key. |

## Tools

Required by default:

- Outbound: `inkbox_send_email`, `inkbox_send_sms`
- Email reads: `inkbox_list_unread_emails`, `inkbox_list_emails`, `inkbox_get_email`, `inkbox_get_email_thread`
- SMS reads: `inkbox_list_text_conversations`, `inkbox_get_text_conversation`
- Voice reads: `inkbox_list_calls`, `inkbox_list_call_transcripts`
- Contacts: `inkbox_lookup_contact`, `inkbox_get_contact`, `inkbox_list_contacts`, `inkbox_create_contact`
- Notes: `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note`

Optional:

- Outbound: `inkbox_forward_email`, `inkbox_place_call`
- Lifecycle: `inkbox_mark_emails_read`, `inkbox_list_texts`, `inkbox_get_text`, `inkbox_mark_text_read`, `inkbox_mark_text_conversation_read`
- Contacts: `inkbox_update_contact`, `inkbox_delete_contact`, `inkbox_export_contact_vcard`
- Notes: `inkbox_update_note`, `inkbox_delete_note`
- Contact rules: `inkbox_list_mail_contact_rules`, `inkbox_create_mail_contact_rule`, `inkbox_update_mail_contact_rule`, `inkbox_delete_mail_contact_rule`, `inkbox_list_phone_contact_rules`, `inkbox_create_phone_contact_rule`, `inkbox_update_phone_contact_rule`, `inkbox_delete_phone_contact_rule`
- Identity access: `inkbox_list_contact_access`, `inkbox_grant_contact_access`, `inkbox_revoke_contact_access`, `inkbox_list_note_access`, `inkbox_grant_note_access`, `inkbox_revoke_note_access`
- Vault: `inkbox_credentials_list`, `inkbox_credentials_get_login`, `inkbox_credentials_get_api_key`, `inkbox_credentials_get_ssh_key`, `inkbox_totp_code`
- Diagnostic: `inkbox_whoami`

## Bundled Skills

The package includes all `skills/*/SKILL.md` files in npm tarballs.

| Skill | Trigger |
|---|---|
| `inkbox-troubleshooting` | Runtime/config errors, failed tools, readiness issues |
| `inkbox-email-triage` | Checking or replying to Inkbox email |
| `inkbox-sms-responder` | Sending, replying to, or triaging SMS |
| `inkbox-outbound-calling` | Placing calls to numbers or contacts |
| `inkbox-call-review` | Reviewing calls and transcripts |
| `inkbox-contact-lookup` | Resolving, creating, or updating contacts |
| `inkbox-contact-rules` | Managing mail/phone allow and block rules |
| `inkbox-identity-access` | Granting/revoking contact or note visibility |
| `inkbox-notes-memory` | Saving, retrieving, or updating Inkbox notes |
| `inkbox-credential-use` | Fetching vault credentials or TOTP codes |
| `inkbox-outreach-sequence` | Multi-step outreach over email/SMS |

## Development Commands

```bash
npm run typecheck
npm test
npm run build
npm_config_cache=/tmp/npm-cache npm pack --dry-run
```

## Architecture Notes

- Plugin, not fork: uses OpenClaw plugin SDK, channel gateway, tools, HTTP routes, CLI, and bundled skills.
- Agent-scoped: runtime should use an Inkbox agent-scoped API key.
- Tunnel-first inbound: with a signing key, gateway opens an Inkbox tunnel and patches mailbox/phone webhooks.
- Voice: Inkbox STT/TTS fallback path and realtime raw-media path both route through the same call WebSocket.
- Post-call actions: realtime calls can register work for the main OpenClaw agent after hangup.
- Identity-aware calls: call prompts include agent handle/mailbox/phone/tunnel and known caller contact metadata.

See [PLAN.md](./PLAN.md) for the longer architecture history and roadmap.

## License

MIT - see [LICENSE](./LICENSE).
