# @inkbox/openclaw-plugin

[Inkbox](https://inkbox.ai) plugin for [OpenClaw](https://openclaw.ai). Gives the agent a working mailbox, phone number, and contact/note/credential access under an Inkbox agent identity — outbound and inbound — without forking OpenClaw.

> **Status:** all outbound tools, inbound webhook delivery (tunnel + HMAC), reads, vault, and 6 bundled skills shipped. **Not yet:** channel-plugin promotion (inbound sessions), interactive setup wizard, SMS batching, ClawHub publish. See [PLAN.md](./PLAN.md) for the full roadmap.

## Install (development)

```bash
git clone https://github.com/inkbox-ai/openclaw-plugin.git
cd openclaw-plugin
npm install
openclaw plugins install --link ./
```

Edits to `index.ts` and `src/**` are picked up on the next session reload — no reinstall needed.

## Configure

Set `plugins.entries.inkbox.config` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "inkbox": {
        "config": {
          "apiKey": "ApiKey_xxxxxxxxxxxx",
          "identity": "my-agent-handle",
          "signingKey": "whsec_xxxxxxxxxxxx"
        }
      }
    }
  }
}
```

| Field | Required | Default | Description |
|---|---|---|---|
| `apiKey` | yes | — | Agent-scoped Inkbox API key. Mint one in the [Inkbox Console](https://inkbox.ai/console). |
| `identity` | yes | — | Agent identity handle (3–63 lowercase alphanum/dash). |
| `signingKey` | for inbound | — | Webhook HMAC secret. Required to receive inbound email/SMS/calls. |
| `baseUrl` | no | `https://inkbox.ai` | Override API base URL. |
| `tunnelName` | no | identity handle | Override the Inkbox tunnel name. |
| `publicUrl` | no | — | If set, skip the tunnel and assume webhooks land here. |
| `allowedRecipients` | no | — | Outbound allowlist. Empty = no filtering. |
| `allowedInboundContactIds` | no | — | Inbound allowlist by contact UUID. Empty = no filtering. |
| `vault.keyEnvVar` | no | `INKBOX_VAULT_KEY` | Env var the vault unlock key is read from. |

## Tools

**Outbound** — required by default:
- `inkbox_send_email`, `inkbox_send_sms`

**Outbound** — optional, opt-in via `tools.allow`:
- `inkbox_forward_email`

**Read / lifecycle** (email, SMS, voice, contacts, notes) — required by default unless noted optional:
- Email: `inkbox_list_unread_emails`, `inkbox_list_emails`, `inkbox_get_email`, `inkbox_get_email_thread`, `inkbox_mark_emails_read` *(opt)*
- SMS: `inkbox_list_text_conversations`, `inkbox_get_text_conversation`, `inkbox_list_texts` *(opt)*, `inkbox_get_text` *(opt)*, `inkbox_mark_text_read` *(opt)*, `inkbox_mark_text_conversation_read` *(opt)*
- Voice: `inkbox_list_calls`, `inkbox_list_call_transcripts`
- Contacts: `inkbox_lookup_contact`, `inkbox_get_contact`, `inkbox_list_contacts`, `inkbox_export_contact_vcard` *(opt)*
- Notes: `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note`, `inkbox_update_note` *(opt)*, `inkbox_delete_note` *(opt)*

**Vault** — all optional, gate plaintext access:
- `inkbox_credentials_list`, `inkbox_credentials_get_login`, `inkbox_credentials_get_api_key`, `inkbox_credentials_get_ssh_key`, `inkbox_totp_code`

**Diagnostic** — optional:
- `inkbox_whoami`

Enable in OpenClaw config:

```json5
{
  tools: { allow: ["inkbox"] }  // allow every required tool from this plugin
}
```

To enable optional tools, list them by name (`tools: { allow: ["inkbox", "inkbox_forward_email", "inkbox_totp_code"] }`).

## CLI

```
openclaw inkbox doctor    # diagnose config + connection
openclaw inkbox whoami    # one-line auth/identity summary
openclaw inkbox setup     # interactive wizard (stub — prints manual flow)
```

`doctor` and `whoami` read `INKBOX_API_KEY` / `INKBOX_IDENTITY` / `INKBOX_BASE_URL` / `INKBOX_SIGNING_KEY` from env.

## Bundled skills

Six SKILL.md files under `skills/`:

| Skill | Triggers when… |
|---|---|
| `inkbox-onboarding` | first-time setup, "Inkbox plugin is not configured" |
| `inkbox-email-triage` | checking email, processing unread, replying on threads |
| `inkbox-sms-responder` | sending or replying to SMS |
| `inkbox-call-handler` | reviewing call history or transcripts |
| `inkbox-contact-lookup` | "who is X" / resolving names to contacts |
| `inkbox-credential-use` | "log into X" / fetching a TOTP code |

Each skill ends with a pointer to `https://inkbox.ai/llms.txt` and `https://inkbox.ai/docs/all.md` as a raw-docs fallback when behavior questions go past what's bundled.

## Architecture

- **Plugin, not fork.** OpenClaw's plugin SDK does everything we need (`registerTool`, `registerHttpRoute`, `registerCli`).
- **Agent-scoped.** Authenticates with an agent-scoped Inkbox API key. Admin operations are deliberately not exposed.
- **Tunnel-first inbound.** When `signingKey` is set, opens an Inkbox tunnel at `https://<identity>.inkboxwire.com` and routes inbound webhooks into an in-process HMAC-verified handler with dedup. `publicUrl` config skips the tunnel for hosted deployments.
- **Lazy SDK client.** The Inkbox SDK is constructed on first tool call, never at registration.
- **Allowlists.** Optional outbound recipient allowlist and inbound contact-id allowlist for stricter deployments.

See [PLAN.md](./PLAN.md) for the full architecture write-up and 8-phase roadmap.

## Roadmap (what's still ahead)

- Channel-plugin promotion so inbound webhook events become real OpenClaw sessions
- Interactive `openclaw inkbox setup` wizard (port of the 3-branch Hermes Agent flow)
- `inkbox_rate_status` tool + SMS fragment batching window
- `inkbox_place_call` outbound voice (needs WS audio bridge)
- ClawHub publishing (`clawhub:inkbox/openclaw-plugin`)
- Test suite for HMAC verify, dedup, allowlists, async iterator caps, vault unlock paths

## License

MIT — see [LICENSE](./LICENSE).
