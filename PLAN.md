# Inkbox OpenClaw Plugin — Build Plan

> Status: living document. Tick boxes as work lands. Reorder freely.

## TL;DR

Ship `@inkbox/openclaw-plugin` as an OpenClaw plugin (no fork) that lets an agent send and receive **email**, **SMS**, and **calls** under its own Inkbox identity, manage its **contacts** and **notes**, and use its **vault credentials**. Scope is **agent-scoped only** — the plugin treats the identity as the unit of identity. Admin/org-wide capabilities (creating identities, flipping filter modes, managing domains, writing org-level opt-ins) are explicitly **out of scope** for now.

## Vision

When the user installs this plugin and runs `openclaw inkbox setup`, their agent comes online with a working mailbox, a working phone number, and inbound webhooks already routing into OpenClaw sessions. From there:

- The agent can read its inbox, reply on threads, send SMS, place calls, and pull TOTP codes from its vault as natural agent actions.
- Inbound emails, SMS, and incoming calls land as OpenClaw channel events — same session model as Telegram/Slack/Discord.
- "Conversations flow" — a contact who emails today and texts tomorrow shows up as the same session, keyed by contact UUID.

## User Prerequisites

The plugin docs should treat OpenClaw itself as an explicit prerequisite, not an implied dependency. Point users to [openclaw.ai](https://openclaw.ai/) and the [OpenClaw install docs](https://docs.openclaw.ai/install/index), then show the recommended installer:

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
openclaw --version
```

For users who already manage Node globally, document the supported npm path:

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
```

## Architecture

### Plugin, not fork

OpenClaw has a first-class plugin SDK (`docs/plugins/`). Everything we need — tool registration, HTTP routes, CLI subcommands, channel plugin shape, setup entries — is documented surface. **We do not fork OpenClaw.** Contrast with the Hermes Agent fork at `inkbox-powered-hermes-agent/`, which had to bake Inkbox into core because Hermes lacked equivalent plugin hooks.

### Plugin shape: channel plugin, agent-scoped

Two shapes are possible:

| Shape | Pros | Cons |
|---|---|---|
| **Tool plugin** (`definePluginEntry`) | Simple, fastest to ship | Inbound webhook events don't naturally become sessions — would have to fake it |
| **Channel plugin** (`defineChannelPluginEntry`) | Inbound emails/SMS/calls become real OpenClaw sessions; matches Telegram/Discord/Slack shape | More moving parts (channel config, runtime setter, ingress contract) |

**Decision: start as tool plugin (Phase 0–1), promote to channel plugin in Phase 2** when we wire inbound. The Telegram plugin at `/home/ec2-user/repos/openclaw/extensions/telegram/` is the template — copy its file layout (`channel-plugin-api.ts`, `runtime-setter-api.ts`, `setup-entry.ts`, `configured-state.ts`).

### Agent-scoped focus

The plugin authenticates with an **agent-scoped API key** (`AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED`). This narrows the API surface dramatically and keeps the agent honest:

- ✅ Send/read its own email, SMS, calls
- ✅ Manage its own phone number (provision/release)
- ✅ Use vault credentials it has access to via grants
- ✅ Read contacts and notes it has access to via grants
- ❌ Create / list / delete other identities
- ❌ Flip filter modes on mailboxes or phone numbers
- ❌ Manage domains
- ❌ Write SMS opt-in registry programmatically
- ❌ Grant/revoke contact or note access (the human admin does this in the Inkbox Console)

This separation matches Inkbox's own auth model (`AUTH_SUBTYPE_API_KEY_ADMIN_SCOPED` vs `AGENT_SCOPED`). The wizard creates an agent-scoped key and the runtime refuses to construct an admin client.

### Inbound delivery: tunnel-first

Most OpenClaw users run on a laptop without a public URL. We default to opening an **Inkbox tunnel** (`@inkbox/sdk/tunnels/connect`) from inside the plugin runtime — the tunnel terminates at `https://{identity}.inkboxwire.com` and forwards into our in-process Fetch handler. The mailbox/phone webhook URLs and the call WebSocket URL all point at the tunnel. Users with a public URL can override via `publicUrl` in config and skip the tunnel.

---

## Phase Roadmap

- [x] **Phase 0** — Scaffold (initial commit)
- [x] **Phase 1** — Outbound tools: `send_email` ✅, `send_sms` ✅, `forward_email` ✅, `place_call` ✅ (caller-provided WS until in-plugin bridge lands)
- [~] **Phase 2** — Inbound: tunnel ✅, webhook signature verify ✅, dedup ✅, event dispatch ✅, channel plugin promotion ⏳
- [~] **Phase 3** — Setup wizard: CLI scaffold ✅, doctor ✅ (now surfaces cached state), whoami ✅, interactive setup ✅ (3-branch flow minus self-signup which still directs to web Console)
- [x] **Phase 4** — Read/lifecycle tools: 22 tools across email reads, SMS reads, call reads, contacts, notes
- [x] **Phase 5** — Vault + credentials + TOTP — 5 optional tools, env-var unlock
- [x] **Phase 6** — Bundled skills: email triage ✅, SMS responder ✅, onboarding ✅, call handler ✅, contact lookup ✅, credential use ✅
- [x] **Phase 7** — Polish: outbound allowlist ✅, inbound contact allowlist ✅, whoami ✅, rate_status ✅, publicUrl override ✅, SMS batching ✅
- [ ] **Phase 8** — Publish: ClawHub primary, npm secondary, GitHub release

---

## Phase 1 — Outbound tools

**Goal:** the agent can send email, send SMS, and place outbound calls. No inbound yet. Manual config (no wizard yet).

### Tools to register

| Tool | Required? | Underlying SDK | Notes |
|---|---|---|---|
| `inkbox_send_email` ✅ | required | `identity.sendEmail({to, subject, bodyText?, bodyHtml?, cc?, bcc?, inReplyToMessageId?, attachments?})` | Wired in `src/tools/send-email.ts` |
| `inkbox_send_sms` ✅ | required | `identity.sendText({to, text})` | Wired in `src/tools/send-sms.ts` |
| `inkbox_forward_email` ✅ | optional | `identity.forwardEmail(messageId, {to?, cc?, bcc?, mode?, subject?, bodyText?, bodyHtml?, includeOriginalAttachments?, replyTo?})` | Wired in `src/tools/forward-email.ts` |
| `inkbox_place_call` | optional | `identity.placeCall({toNumber, clientWebsocketUrl})` | Deferred to Phase 2 — needs WS endpoint |

### Behavior to get right

- ✅ **Lazy SDK client.** `src/client.ts:createInkboxRuntime()` constructs `new Inkbox(...)` and resolves the identity on first tool call, cached after that.
- ✅ **whoami check on first construction.** Warns (does not block) when key isn't agent-scoped — covers `AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED` and `_UNCLAIMED`.
- ✅ **Error mapping.** `src/errors.ts:mapInkboxError()` translates `InkboxAPIError` into agent-friendly tool errors. Specific 403 codes handled: `sender_sms_pending`, `recipient_not_opted_in`, `recipient_opted_out`. 404/409/422 carry through with their detail.
- ✅ **No vendor names in messages.** Error strings reference only "carriers" / "Inkbox" — no upstream vendor.

### Tests

- [ ] Unit: each tool's parameter schema accepts/rejects expected shapes
- [ ] Unit: SDK client is constructed lazily (mock `Inkbox`)
- [ ] Unit: tool result includes message id + recipient summary
- [ ] Integration (staging API key): roundtrip email send → message appears in mailbox

---

## Phase 2 — Inbound: tunnel + webhook + channel plugin promotion

**Goal:** inbound email/SMS/call events open OpenClaw sessions. Outbound replies in those sessions go through Phase 1 tools.

### Sub-phase 2a — Tunnel + HTTP handler

- [x] Add `@inkbox/sdk/tunnels/connect` — dynamic import in `src/inbound/tunnel.ts` keeps it out of the main require graph (POSIX-only subpath).
- [x] On plugin activation, open tunnel via `startInbound()` in `src/inbound/index.ts`. Fire-and-forget so outbound stays available even if the tunnel doesn't come up.
- [x] Fetch-API handler in `src/inbound/tunnel.ts` reads body + lowercase headers, defers to the pure `handleInkboxWebhook()` in `src/inbound/handler.ts`.
- [x] Pure handler verifies required headers (`x-inkbox-request-id`, `x-inkbox-signature`, `x-inkbox-timestamp`), checks dedup, calls `verifyWebhook()` from `@inkbox/sdk`, parses JSON, dispatches.
- [x] Dedup in `src/inbound/dedup.ts` — bounded set (10k entries default) with LRU eviction. Replays short-circuit before HMAC.
- [ ] `publicUrl` config override path (skip tunnel for hosted OpenClaw) — Phase 7.

### Sub-phase 2b — Event dispatch

- [x] Discrimination in `src/inbound/dispatch.ts`: mail/text envelopes split on `event_type` prefix; flat call payload routes to `onCall` with default-reject.
- [x] `InboundHandlers` interface with `onMail`, `onText`, `onCall` — caller wires the actual session logic.

| Event | Handler |
|---|---|
| `message.received` (mail) | Open or merge session keyed by contact UUID (`data.contacts[0].id`); enqueue inbound turn with subject + body — wires up in 2c |
| `message.sent`, `message.delivered`, `message.bounced`, `message.failed`, `message.forwarded` | Telemetry only — surface in session metadata if session is open |
| `text.received` | Open or merge session keyed by contact UUID; enqueue inbound turn with text — wires up in 2c |
| `text.sent`, `text.delivered`, `text.delivery_failed`, `text.delivery_unconfirmed` | Telemetry only |
| `PhoneIncomingCallWebhookPayload` (flat, sync) | Decide `auto_accept` (return WS URL) vs `reject` based on allowlist + agent availability; if accept, register the WS handler for the call audio bridge — wires up in 2c |

### Sub-phase 2c — Channel plugin promotion

- [ ] Switch from `definePluginEntry` → `defineChannelPluginEntry`
- [ ] New files modeled on `extensions/telegram/`:
  - `channel-plugin-api.ts` — exports `inkboxPlugin`
  - `runtime-setter-api.ts` — exports `setInkboxRuntime`
  - `configured-state.ts` — exports `hasInkboxConfiguredState`
  - `setup-entry.ts` — exports the setup flow (lives here, called from Phase 3 CLI)
  - `secret-contract-api.ts` — declares which config keys are secrets (`apiKey`, `signingKey`)
- [ ] Update `openclaw.plugin.json` with `channel` block:
  ```json
  "channel": {
    "id": "inkbox",
    "label": "Inkbox",
    "selectionLabel": "Inkbox (email + SMS + voice)",
    "markdownCapable": true,
    "configuredState": { "specifier": "./configured-state", "exportName": "hasInkboxConfiguredState" }
  }
  ```
- [ ] Session merge key: `contact.id` from webhook payload, falling back to the bare email/phone if no contact resolution.

### Tests

- [ ] HMAC verification test vectors (lift from inkbox SDK tests)
- [ ] Dedup: same `x-inkbox-request-id` twice → handler runs once
- [ ] Channel: inbound email + inbound SMS from same contact UUID merge into one session
- [ ] Call: accept path returns `{action: "answer", clientWebsocketUrl}`; reject path returns `{action: "reject"}`

---

## Phase 3 — Setup wizard: `openclaw inkbox setup`

**Goal:** zero-to-running in one command. Mirrors the three-branch flow already proven in the Hermes fork's `_setup_inkbox()` (at `inkbox-powered-hermes-agent/hermes_cli/setup.py:1971`).

### CLI registration

- [ ] `api.registerCli(registrar => registrar.command("inkbox").command("setup").action(...))`
- [ ] Subcommands:
  - `openclaw inkbox setup` — full guided flow
  - `openclaw inkbox doctor` — print resolved config, whoami, tunnel status, webhook URLs
  - `openclaw inkbox whoami` — short status

### Setup flow branches

```
┌─ Detect existing config ─────────────────────────────────┐
│ apiKey in config?                                        │
│   yes → call whoami() → branch on authSubtype            │
│   no  → ask: "Do you have an Inkbox account?"            │
│            yes → branch B (existing key)                 │
│            no  → branch A (self-signup)                  │
└──────────────────────────────────────────────────────────┘

Branch A — Self-signup (no key yet)
  1. Prompt email → Inkbox.signup({email})
  2. Wait for verify code → Inkbox.verifySignup(apiKey, {code})
  3. Identity handle prompt
  4. Inkbox.createIdentity(handle)  ← admin-scoped key from signup
  5. Mint agent-scoped key: inkbox.apiKeys.create({scopedIdentityId})
  6. Discard admin key. Persist agent-scoped key.

Branch B — Existing agent-scoped key
  1. Read identity from whoami.keyId → fetch identity record
  2. Confirm handle, mailbox address, phone status
  3. Offer phone provision if missing
  4. Generate signing key via inkbox.createSigningKey()
  5. Update mailbox + phone webhook URLs to tunnel URL
```

### What gets persisted

| Where | Field |
|---|---|
| `plugins.entries.inkbox.config.apiKey` | agent-scoped key |
| `plugins.entries.inkbox.config.identity` | handle |
| `plugins.entries.inkbox.config.signingKey` | webhook HMAC secret |
| `~/.openclaw/inkbox/identity-state.json` | resolved email/phone/publicUrl cache |
| `~/.openclaw/inkbox/tunnel/` | tunnel state dir (private key etc.) |

### Tests

- [ ] Mock signup flow end-to-end
- [ ] Re-run idempotent: running setup twice doesn't corrupt config or rotate keys
- [ ] Doctor: detects missing signing key, missing webhook URLs, expired tunnel cert

---

## Phase 4 — Read & lifecycle tools

**Goal:** agent can introspect its own inbox, conversations, and call history. Plus read access-granted contacts and notes.

### Email reads

| Tool | SDK | Optional? |
|---|---|---|
| `inkbox_list_unread_emails` | `identity.iterUnreadEmails()` capped at `limit` param | required |
| `inkbox_list_emails` | `identity.iterEmails({direction?, limit})` | required |
| `inkbox_get_email` | `identity.getMessage(messageId)` | required |
| `inkbox_get_email_thread` | `identity.getThread(threadId)` | required |
| `inkbox_mark_emails_read` | `identity.markEmailsRead(ids)` | optional |

### SMS reads

| Tool | SDK | Optional? |
|---|---|---|
| `inkbox_list_text_conversations` | `identity.listTextConversations({limit?, offset?})` | required |
| `inkbox_get_text_conversation` | `identity.getTextConversation(phone, {limit?, offset?})` | required |
| `inkbox_list_texts` | `identity.listTexts({limit?, offset?, isRead?})` | optional |
| `inkbox_get_text` | `identity.getText(textId)` | optional |
| `inkbox_mark_text_read` | `identity.markTextRead(textId)` | optional |
| `inkbox_mark_text_conversation_read` | `identity.markTextConversationRead(phone)` | optional |

### Call reads

| Tool | SDK | Optional? |
|---|---|---|
| `inkbox_list_calls` | `identity.listCalls({limit?, offset?})` | required |
| `inkbox_list_call_transcripts` | `identity.listTranscripts(callId)` | required |

### Contacts (access-scoped reads)

The agent reads contacts it has access to via grants set by an admin in the Inkbox Console. We do **not** expose grant management here — that stays admin-only.

| Tool | SDK | Optional? |
|---|---|---|
| `inkbox_lookup_contact` | `inkbox.contacts.lookup({email?, phone?, emailDomain?, emailContains?, phoneContains?})` | required |
| `inkbox_get_contact` | `inkbox.contacts.get(contactId)` | required |
| `inkbox_list_contacts` | `inkbox.contacts.list({q?, order?, limit?, offset?})` | required |
| `inkbox_export_contact_vcard` | `inkbox.contacts.vcards.export(contactId)` | optional |

> Note: with an agent-scoped key, the SDK already filters list/lookup/get results to contacts the agent has access to. We don't need to re-implement the filter.

### Notes (access-scoped)

| Tool | SDK | Optional? |
|---|---|---|
| `inkbox_list_notes` | `inkbox.notes.list({q?, identityId?, order?, limit?})` (omit `identityId` to get caller's own) | required |
| `inkbox_get_note` | `inkbox.notes.get(noteId)` | required |
| `inkbox_create_note` | `inkbox.notes.create({title?, body})` | required |
| `inkbox_update_note` | `inkbox.notes.update(noteId, {title?, body?})` | optional |
| `inkbox_delete_note` | `inkbox.notes.delete(noteId)` | optional |

### Tests

- [ ] List tools respect `limit` and don't fetch unbounded
- [ ] Iterators (`iterEmails`) wrapped to materialize at most `limit` results before returning
- [ ] Contact/note tools surface "access not granted" cleanly on 403

---

## Phase 5 — Vault, credentials, TOTP

**Goal:** agent can use credentials its identity has been granted access to. Vault unlock is sensitive — gate carefully.

### Tools

| Tool | Required? | SDK | Notes |
|---|---|---|---|
| `inkbox_credentials_list` | optional | `creds.list()` after vault unlock | Returns metadata only — no plaintext payloads |
| `inkbox_credentials_get_login` | optional | `creds.getLogin(secretId)` | Plaintext payload — gate behind explicit user opt-in |
| `inkbox_credentials_get_api_key` | optional | `creds.getApiKey(secretId)` | Same |
| `inkbox_credentials_get_ssh_key` | optional | `creds.getSshKey(secretId)` | Same |
| `inkbox_totp_code` | optional | `identity.getTotpCode(secretId)` | Returns `{code, secondsRemaining}` |

### Vault unlock model

- Vault unlock requires a **vault key** (passphrase). We do NOT persist this; it must be passed at session start.
- Two ways to pass:
  1. Env var `INKBOX_VAULT_KEY` — read once at first vault-touching tool call
  2. Interactive prompt via `api.registerInteractiveHandler` — preferred for human-driven sessions
- Cache the unlocked vault for the process lifetime; refresh on `identity.refresh()`.
- **All credential tools are optional** (`{ optional: true }`) — must be explicitly opted into via `tools: { allow: [...] }`.

### Doctor checks

- [ ] `openclaw inkbox doctor` reports: vault initialized? unlocked? recoverable?
- [ ] Surfaces vault status without exposing key material

### Tests

- [ ] Unlock failure (bad key) → clean error, no partial state
- [ ] `creds.list()` returns metadata only, never payloads
- [ ] TOTP code matches expected RFC 6238 output for a known seed

---

## Phase 6 — Bundled skills

OpenClaw skills are markdown files that scope agent behavior for a domain. Ship a small set covering the common patterns. Skills live alongside the plugin (or in a sibling `skills/` directory — TBD based on OpenClaw skill packaging convention).

| Skill | Trigger | Purpose |
|---|---|---|
| `inkbox-email-triage` | "check email", "what's in my inbox", inbound `message.received` event | Walks: list unread → categorize → reply/archive/forward |
| `inkbox-sms-responder` | "text X", inbound `text.received` event | Conversational SMS reply, conversation-history-aware |
| `inkbox-outbound-calling` | "call X", "place a call to Y" | Place calls from the configured Inkbox phone number |
| `inkbox-call-review` | "what happened on the call", "show transcripts" | Review call history and transcript segments |
| `inkbox-contact-lookup` | "who is X", "find email for Y" | Lookup-first; surfaces vcard + notes if access-granted |
| `inkbox-contact-rules` | "block/allow this sender/number" | Manage mailbox and phone contact rules |
| `inkbox-identity-access` | "share this contact/note with identity X" | Manage contact/note access grants |
| `inkbox-credential-use` | "log into X", "I need the TOTP for Y" | Gates plaintext credential access with explicit confirmation |
| `inkbox-outreach-sequence` | "follow up with X over 3 days" | Multi-step outbound (email + SMS) with delay scheduling |

### Skill authoring rules

- Read `/home/ec2-user/repos/inkbox/skills/inkbox-ts/SKILL.md` for the canonical SDK usage model — that's the source of truth for tool semantics.
- Each skill cites `inkbox_*` tools by exact name so the agent can find them in `tools.allow`.
- Skills are `user-invocable: false` by default (they auto-trigger on context) unless they're explicitly user-facing.
- No vendor names. No "soft-delete" / "tombstone" language. Use "admin API key or manage from the Inkbox Console" not "Clerk JWT" (per project policy).

---

## Phase 7 — Polish

### Allowlist / safety

- [ ] `config.allowedRecipients` — array of `+E164` or `email` strings; outbound tools reject any recipient not on the list when set
- [ ] `config.allowedInboundContactIds` — only open sessions for contacts on this list; others get an auto-reject/auto-ignore
- [x] Phone/mailbox readiness fields surfaced from `inkbox_whoami`; actual rate caps remain attached to send/place-call responses.

### Idempotency & dedup

- [ ] `x-inkbox-request-id` LRU sized to 10k entries
- [ ] Outbound retries use `Idempotency-Key` (TBD on SDK support)

### Batching

- [ ] SMS fragment batching window (port `INKBOX_SMS_TEXT_BATCH_DELAY_SECONDS` knob from Hermes adapter)
- [ ] Email iteration capped at `limit` to avoid runaway scans

### Diagnostics

- [x] Structured `openclaw doctor` checks under `inkbox/*` for:
  - whoami returns agent-scoped key
  - required config presence
  - identity lookup
  - phone/SMS readiness
  - cached state freshness
  - tunnel config conflicts
- [ ] `openclaw inkbox doctor` parity with the structured checks for tunnel/webhook deep validation
- [ ] vault status (if vault tools enabled)
- [ ] Verbose log mode that NEVER prints `apiKey`, `signingKey`, or vault keys

### Misc

- [ ] Channel-plugin `configuredState` returns `true` only when `apiKey` + `identity` + (`signingKey` if inbound enabled) are present
- [ ] Setup wizard regenerates signing key safely (asks before overwriting)

---

## Phase 8 — Publish

- [ ] Hit `pluginApi` compatibility per `openclaw.plugin.json` — verify against the openclaw version in `/home/ec2-user/repos/openclaw/package.json`
- [ ] CI: typecheck + unit tests on push
- [ ] `npm run build` → `dist/` artifact
- [ ] **ClawHub publish (primary):**
  ```
  clawhub package publish inkbox/openclaw-plugin --dry-run
  clawhub package publish inkbox/openclaw-plugin
  ```
- [ ] **npm publish (secondary):**
  ```
  npm publish --access public  # @inkbox/openclaw-plugin
  ```
- [ ] GitHub release with changelog
- [ ] Update the inkbox website docs (`website/docs/`) with an "OpenClaw" page that points at `clawhub:inkbox/openclaw-plugin`
- [ ] Don't forget the no-attribution-footer rule on any PR descriptions

---

## Reference appendices

### A. Full tool registry (target state)

Grouped by phase. ✱ = optional (user must opt-in via `tools: { allow: [...] }`).

**Phase 1 — Outbound**
- `inkbox_send_email`
- `inkbox_send_sms`
- `inkbox_forward_email` ✱
- `inkbox_place_call` ✱

**Phase 4 — Reads**
- `inkbox_list_unread_emails`
- `inkbox_list_emails`
- `inkbox_get_email`
- `inkbox_get_email_thread`
- `inkbox_mark_emails_read` ✱
- `inkbox_list_text_conversations`
- `inkbox_get_text_conversation`
- `inkbox_list_texts` ✱
- `inkbox_get_text` ✱
- `inkbox_mark_text_read` ✱
- `inkbox_mark_text_conversation_read` ✱
- `inkbox_list_calls`
- `inkbox_list_call_transcripts`
- `inkbox_lookup_contact`
- `inkbox_get_contact`
- `inkbox_list_contacts`
- `inkbox_create_contact`
- `inkbox_update_contact` ✱
- `inkbox_delete_contact` ✱
- `inkbox_export_contact_vcard` ✱
- `inkbox_list_notes`
- `inkbox_get_note`
- `inkbox_create_note`
- `inkbox_update_note` ✱
- `inkbox_delete_note` ✱

**Phase 5 — Vault**
- `inkbox_credentials_list` ✱
- `inkbox_credentials_get_login` ✱
- `inkbox_credentials_get_api_key` ✱
- `inkbox_credentials_get_ssh_key` ✱
- `inkbox_totp_code` ✱

**Phase 7 — Diagnostics**
- `inkbox_whoami` ✱

**Contact rules + access grants**
- `inkbox_list_mail_contact_rules` ✱
- `inkbox_create_mail_contact_rule` ✱
- `inkbox_update_mail_contact_rule` ✱
- `inkbox_delete_mail_contact_rule` ✱
- `inkbox_list_phone_contact_rules` ✱
- `inkbox_create_phone_contact_rule` ✱
- `inkbox_update_phone_contact_rule` ✱
- `inkbox_delete_phone_contact_rule` ✱
- `inkbox_list_contact_access` ✱
- `inkbox_grant_contact_access` ✱
- `inkbox_revoke_contact_access` ✱
- `inkbox_list_note_access` ✱
- `inkbox_grant_note_access` ✱
- `inkbox_revoke_note_access` ✱

### B. Configuration reference (target state)

```jsonc
{
  "plugins": {
    "entries": {
      "inkbox": {
        "config": {
          "apiKey": "ApiKey_xxxxxxxxxxxx",     // required, agent-scoped
          "identity": "my-agent",               // required, lowercase 3-63
          "signingKey": "whsec_xxx",            // required for inbound
          "baseUrl": "https://inkbox.ai",       // optional, default prod

          "publicUrl": null,                    // optional; null → use Inkbox tunnel
          "tunnelName": null,                   // optional; defaults to identity
          "requireSignature": true,             // default true; disable only for local debugging

          "allowedRecipients": null,            // optional; null = no allowlist
          "allowedInboundContactIds": null,

          "sms": {
            "batchDelayMs": 0,                  // off by default
            "batchMaxMessages": 8,
            "batchMaxChars": 4000
          },

          "vault": {
            "enabled": false,                   // off by default; opt-in for credential tools
            "keyEnvVar": "INKBOX_VAULT_KEY"
          }
        }
      }
    }
  }
}
```

### C. Webhook event taxonomy (what we route on)

Reference: `/home/ec2-user/repos/inkbox/skills/inkbox-ts/SKILL.md:761-771`.

| Source URL | Events | Envelope shape | What we do |
|---|---|---|---|
| `mailbox.webhookUrl` | `message.received/sent/forwarded/delivered/bounced/failed` | envelope: `event_type` + `data` | route `received` → session ingress; others → telemetry |
| `phoneNumber.incomingTextWebhookUrl` | `text.received/sent/delivered/delivery_failed/delivery_unconfirmed` | envelope | route `received` → session ingress; others → telemetry |
| `phoneNumber.incomingCallWebhookUrl` | (flat) inbound call | flat `PhoneIncomingCallWebhookPayload` | sync response `{action: "answer", clientWebsocketUrl}` or `{action: "reject"}` |
| `phoneNumber.clientWebsocketUrl` | WS audio for accepted call | binary frames | bridge to OpenClaw realtime |

### D. Errors we surface specifically

| Error | Source | Message to agent |
|---|---|---|
| `InkboxAPIError` 403 `sender_sms_pending` | sendText | "Your number is still propagating to carriers (10–15 min). Try again shortly." |
| `InkboxAPIError` 403 `recipient_not_opted_in` | sendText | "Recipient hasn't opted in. Ask them to text START to your number first." |
| `InkboxAPIError` 403 `recipient_opted_out` | sendText | "Recipient has opted out." |
| `InkboxAPIError` 409 rate cap | sendText/placeCall | Include `rateLimit` from response if present |
| Vault not unlocked | credential tools | "Vault is locked. Set `INKBOX_VAULT_KEY` env var or run `openclaw inkbox unlock`." |
| Mailbox missing | sendEmail | "Identity has no mailbox. Run `openclaw inkbox setup`." |
| Phone missing | sendText/placeCall | "Identity has no phone number. Run `openclaw inkbox setup` and provision one." |

### E. Open questions / decisions to revisit

- [ ] **Channel plugin or stay tool plugin?** Decision is "promote in Phase 2," but verify OpenClaw channel-plugin contract supports our 3-modality (email/SMS/voice) merge model before committing.
- [ ] **Tunnel vs public URL default.** Tunnel-first is the user-friendly default. Some deploys (containerized OpenClaw on a public host) won't want a tunnel. Auto-detect or explicit config?
- [ ] **Single agent identity per plugin instance, or many?** Phase 1–7 assume one. Multi-identity is a Phase 9 thing if ever.
- [ ] **Skill packaging.** OpenClaw's `skills/` directory in the main repo vs. ClawHub-published skills — figure out which path the bundled skills take.
- [ ] **Realtime voice bridge.** OpenClaw's realtime audio surface for `placeCall` — needs investigation. Might block Phase 2c.
- [ ] **Reading mailbox webhook config.** Can an agent-scoped key update its own mailbox.webhookUrl? Or does the wizard need admin briefly to set webhook? (`mailboxes.update` is admin-only per the skill doc, but the *initial* mailbox is created by `createIdentity` and may take the webhook there.) Verify before Phase 3.

### F. Files we'll create

```
openclaw-plugin/
├── index.ts                       # Phase 1 (exists)
├── openclaw.plugin.json           # Phase 1 (exists) → expanded in Phase 2c
├── package.json                   # exists
├── tsconfig.json                  # exists
├── PLAN.md                        # this file
├── README.md                      # exists → expand each phase
├── src/
│   ├── client.ts                  # Phase 1 — lazy Inkbox client + whoami check
│   ├── errors.ts                  # Phase 1 — map InkboxAPIError to tool errors
│   ├── tools/
│   │   ├── send-email.ts          # Phase 1
│   │   ├── send-sms.ts            # Phase 1
│   │   ├── forward-email.ts       # Phase 1
│   │   ├── place-call.ts          # Phase 1 → wired in Phase 2
│   │   ├── reads-email.ts         # Phase 4
│   │   ├── reads-sms.ts           # Phase 4
│   │   ├── reads-calls.ts         # Phase 4
│   │   ├── contacts.ts            # Phase 4
│   │   ├── notes.ts               # Phase 4
│   │   ├── contact-rules.ts       # Phase 7
│   │   ├── access.ts              # Phase 7
│   │   └── vault.ts               # Phase 5
│   ├── inbound/
│   │   ├── tunnel.ts              # Phase 2a
│   │   ├── handler.ts             # Phase 2a — Fetch handler + HMAC verify
│   │   ├── dispatch.ts            # Phase 2b — event routing
│   │   └── dedup.ts               # Phase 2a — request-id LRU
│   ├── channel/                   # Phase 2c
│   │   ├── channel-plugin-api.ts
│   │   ├── runtime-setter-api.ts
│   │   ├── configured-state.ts
│   │   ├── secret-contract-api.ts
│   │   └── setup-entry.ts
│   ├── cli/
│   │   ├── setup.ts               # Phase 3
│   │   ├── doctor.ts              # Phase 3
│   │   └── whoami.ts              # Phase 3
│   ├── health.ts                  # Phase 7 — openclaw doctor checks
│   └── state.ts                   # Phase 3 — ~/.openclaw/inkbox/identity-state.json
├── skills/                        # Phase 6
│   ├── inkbox-email-triage/SKILL.md
│   ├── inkbox-sms-responder/SKILL.md
│   ├── inkbox-outbound-calling/SKILL.md
│   ├── inkbox-call-review/SKILL.md
│   ├── inkbox-contact-lookup/SKILL.md
│   ├── inkbox-contact-rules/SKILL.md
│   ├── inkbox-identity-access/SKILL.md
│   ├── inkbox-credential-use/SKILL.md
│   ├── inkbox-troubleshooting/SKILL.md
│   └── inkbox-outreach-sequence/SKILL.md
└── tests/
    ├── tools/                     # one file per tool group
    ├── inbound/
    │   ├── hmac.test.ts
    │   ├── dedup.test.ts
    │   └── dispatch.test.ts
    └── cli/
        └── setup.test.ts
```

### G. Source-of-truth pointers

- Inkbox TS SDK reference: `/home/ec2-user/repos/inkbox/skills/inkbox-ts/SKILL.md`
- Inkbox TS SDK source: `/home/ec2-user/repos/inkbox/sdk/typescript/src/`
- OpenClaw plugin docs: `/home/ec2-user/repos/openclaw/docs/plugins/`
- OpenClaw channel-plugin template: `/home/ec2-user/repos/openclaw/extensions/telegram/`
- Hermes integration to learn from (NOT to copy code, just patterns): `/home/ec2-user/repos/inkbox-powered-hermes-agent/gateway/platforms/inkbox.py`, `/home/ec2-user/repos/inkbox-powered-hermes-agent/hermes_cli/setup.py:1971`
