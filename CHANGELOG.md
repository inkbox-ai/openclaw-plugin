# Changelog

All notable changes to the Inkbox OpenClaw plugin are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.2.6] - 2026-07-28

### Added

- Setup now finishes by bringing the gateway up. It detects the host gateway
  service and offers to restart a running one, launch an installed-but-stopped
  one, or install and launch a service when none exists — each defaulting to
  yes. The wizard writes `channels.inkbox` straight to the config file, so a
  gateway that was already running kept serving the old settings until someone
  restarted it by hand.

### Changed

- Dropped the mid-flow restart hint from the iMessage walkthrough and the
  unconditional `openclaw gateway run` sign-off; the closing step covers both.
- The post-install liveness check polls instead of probing once, and an
  unconfirmed install no longer tells the operator to start a gateway that may
  already be up.
- Setup closes on a status banner naming the Inkbox identity and the health
  command when the gateway ends up live, instead of a to-do list with nothing
  left to do.

## [0.2.5] - 2026-07-27

### Added

- The plugin now identifies itself and its version to the API as a `User-Agent` prefix (`inkbox-openclaw/<version> inkbox-typescript/<sdk version>`), using the SDK's existing `userAgentPrefix` option. The version is read from `package.json` at runtime so the token cannot drift.

### Added

- Identity-bound A2A 1.0 tools for sending, checking, waiting on, and replying
  to remote tasks. A2A writes use the existing outbound recipient allowlist.
- Durable inbound A2A task serving with isolated context sessions, restart
  recovery, cancellation, and context-gated complete, ask, and fail intents.
- Filterable, cursor-paginated A2A task and message history for both requester
  and worker identities.

### Changed

- Version realigned to 0.2.5, the shared number across the Inkbox plugin fleet, so a version answers "which fleet release is this" rather than a per-repo count.
- Raised the Inkbox SDK dependency floor to 0.5.6 for the plugin and live CI.
- Removed contact access tools because contacts are organization-wide. Note access tools remain identity-scoped.

### Fixed

- Inbound email turns use the full body carried on `message.received` instead of the 200-char snippet, so the agent no longer sees long emails cut off mid-sentence. A body too large to ship whole arrives with a notice giving the character counts and the message id to fetch for the remainder. Payloads carrying no body (replays, events predating the field) still fall back to the snippet.

## [0.2.2] - 2026-07-10

### Added

- Outbound delivery-failure feedback loop: undelivered outbound messages (SMS/iMessage/email) now wake the agent to fix and resend, across both the synchronous send-rejection surface and the asynchronous delivery-failure webhooks (`text.delivery_failed` / `imessage.delivery_failed` / `message.bounced` / `message.failed`). Hard-capped at 3 sends per logical reply via a shared budget that resets on a fresh inbound, a delivered receipt, or a 30-minute TTL; webhook replays are deduped. Raises the `@inkbox/sdk` floor to 0.4.20.
- Realtime voice: direct read-only contact tools (`inkbox_lookup_contact`, `inkbox_list_contacts`) are exposed straight to the realtime model, so common "who is this?" / "what email is on file?" questions answer in one SDK round-trip instead of a full `consult_agent` loop. Results are dispatched off the audio pump and trimmed for speech (≤5 cards, ≤3 emails/phones each, notes clipped to 200 chars); writes still route through `consult_agent`/post-call actions. A single-source `MAIN_AGENT_CAPABILITIES` map now renders the spoken consult capability list so it can't drift, plus guardrails routing quick contact questions to the direct tools and forbidding recital of third-party details to unrecognized callers. Mirrors the Hermes plugin (hermes-agent-plugin#33); first step toward realtime/contact parity across the fleet (#29-equivalent).

### Fixed

- Realtime voice: an in-call `consult_agent` (which runs the full main agent loop off the audio path) is now bounded by a 300s timeout backstop. If the agent loop never returns, the bridge submits a graceful spoken fallback ("couldn't get an answer right now… follow up after the call") as the tool result instead of leaving the model waiting on dead air. Mirrors the Hermes plugin's `consult_timeout_s` (hermes-agent-plugin#4); addresses the long-running-tool-call-blocks-mid-call class of issues (#9).

## [0.2.1] - 2026-07-03

### Added

- Shared iMessage-line calling: `inkbox_place_call` accepts `origination` (`dedicated_number` / `shared_imessage_number`), auto-resolves it to the only available line or — when both lines exist — to the current conversation's channel, echoes it in the result, and turns the shared-line `no_shared_connection` rejection into a plain-language error with the dedicated-number fallback spelled out.
- `inkbox_whoami` now reports a `lines` block labelling the dedicated phone line vs the shared iMessage line (the shared line's number is managed by Inkbox and never shown).
- Realtime voice instructions name the two lines when iMessage is enabled, so the spoken agent describes its dedicated number vs the shared iMessage line correctly and never states a number for the shared line.
- External webhook injection (default off, `channels.inkbox.externalEvents`): a webhook-provider registry classifies inbound requests by signature header before auth (Inkbox HMAC, GitHub `X-Hub-Signature-256`, secrets via `INKBOX_WEBHOOK_SECRET_<NAME>`), and unknown-but-opted-in events wake the agent on a fresh per-event thread with a verified/unverified directive instead of being dropped. Verified registered providers deliver regardless of the flag — configuring that source's secret is its opt-in; the flag gates only unverified/unknown senders and Inkbox-signed payloads with no known event shape.
- Setup wizard: standalone dedicated-number step decoupled from identity creation — prints "Already provisioned" when a number exists and falls back to an Inkbox paid-tiers pricing pointer (plus the raw error) when provisioning is refused.

### Changed

- Inbound-call config is identity-scoped: the gateway and setup wizard call `identity.setIncomingCallAction(...)` (one row covers the dedicated number and the shared iMessage line, so shared-line-only identities can take calls too), keeping the number-scoped `phoneNumbers.update` only as a legacy-SDK fallback; health checks and `inkbox_whoami` read the config via `identity.getIncomingCallAction()`.
- Setup wizard walks channels iMessage-first (its intro notes voice calls ride the same shared line), then the dedicated-number step, and offers realtime calling whenever the identity has a number or iMessage enabled.
- `@inkbox/sdk` pin gained an upper bound: `>=0.4.15 <1.0.0` (manifest and CI installs).

## [0.2.0] - 2026-06-10

### Added

- Full iMessage support (requires `@inkbox/sdk >= 0.4.7`):
  - Setup-wizard step that enables iMessage on the identity and walks the user through connecting an iPhone via the Inkbox iMessage router (polls for the first inbound message, replies with a welcome, marks the thread read).
  - Identity-owned `imessage.*` webhook subscription (inbound, the outbound delivery lifecycle, and tapback reactions; lifecycle events are logged without waking the agent).
  - Inbound tapbacks dispatched as agent turns with a reply-or-`[SILENT]` response policy; a typing indicator pulses while the agent composes an iMessage reply (and on inbound `question` tapbacks).
  - Inbound iMessage routed into the same contact-keyed session as email/SMS/voice, tagged `[inkbox:imessage …]`, with replies targeting the conversation id and `imessage:<conversation-id>` outbound targets for agent-initiated sends.
  - Inbound iMessage fragment batching sharing the SMS `sms.batchDelayMs` settings.
  - Tools: `inkbox_send_imessage`, `inkbox_list_imessage_conversations`, `inkbox_get_imessage_conversation`, plus optional `inkbox_imessage_triage_number`, `inkbox_list_imessage_assignments`, `inkbox_send_imessage_reaction`, and `inkbox_mark_imessage_conversation_read`.
  - Bundled `inkbox-imessage-responder` skill covering the connect model, recipient-first rule, released-connection handling, and tapback etiquette.
- Inbound HTTP `publicUrl` override path (skip the Inkbox tunnel when OpenClaw is already publicly reachable).
- `inkbox_place_call` outbound voice tool (caller provides `clientWebsocketUrl` until the in-plugin audio bridge lands).
- `inkbox-outreach-sequence` skill covering multi-step outreach over email + SMS.
- Interactive `openclaw inkbox setup` flow using Inkbox signup, identity discovery/creation, phone provisioning, SMS START opt-in polling, and signing-key handling.
- Structured `openclaw doctor` health checks under `inkbox/*`.
- Mail/phone contact-rule tools plus contact/note identity-access grant tools.
- Realtime phone-call tools for editing/deleting queued post-call actions and two-step hangup.

### Fixed

- The `inkbox-email-triage` skill no longer tells the agent to answer the inbound email it is currently handling via `inkbox_send_email` — that produced a double reply (the tool-sent answer plus the plugin's automatic delivery of the agent's final message into the same thread). The skill now explains the automatic threaded reply, reserves `inkbox_send_email` for new mail / other recipients / queue triage, and documents `[SILENT]` for email.

### Changed

- Migrated to `@inkbox/sdk` 0.4.15's identity-centered phone API: call lookups no longer pass a phone-number id (`calls.get(callId)`), and the SDK pin moved from `>=0.4.10 <0.4.15` to `>=0.4.15`.
- npm package name changed to `@inkbox/inkbox` so the unscoped package name matches the OpenClaw manifest id `inkbox`.
- README and project docs now call out OpenClaw itself as a prerequisite, with links to the OpenClaw homepage/install docs and the installer/npm commands.
- `inkbox_whoami` now includes the useful readiness fields that were previously split into `inkbox_rate_status`; the redundant `inkbox_rate_status` tool was removed.
- `inkbox-onboarding` was re-scoped as `inkbox-troubleshooting`.
- `inkbox-call-handler` was split into `inkbox-outbound-calling` and `inkbox-call-review`, with active voice-reply rules carried in the call turn itself.

## [0.1.0] - 2026-05-20

Initial scaffold and feature-complete agent-scoped tool surface, minus channel-plugin promotion and interactive setup wizard.

### Added

  - Tool plugin entry (`index.ts`) registering 30 agent tools:
  - Outbound: `inkbox_send_email`, `inkbox_send_sms`, `inkbox_forward_email` (opt).
  - Email reads: `inkbox_list_unread_emails`, `inkbox_list_emails`, `inkbox_get_email`, `inkbox_get_email_thread`, `inkbox_mark_emails_read` (opt).
  - SMS reads: `inkbox_list_text_conversations`, `inkbox_get_text_conversation`, `inkbox_list_texts` (opt), `inkbox_get_text` (opt), `inkbox_mark_text_read` (opt), `inkbox_mark_text_conversation_read` (opt).
  - Call reads: `inkbox_list_calls`, `inkbox_list_call_transcripts`.
  - Contacts: `inkbox_lookup_contact`, `inkbox_get_contact`, `inkbox_list_contacts`, `inkbox_create_contact`, `inkbox_update_contact`, `inkbox_delete_contact`.
  - Notes: `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note`, `inkbox_update_note` (opt), `inkbox_delete_note` (opt).
  - Vault: `inkbox_credentials_list` (opt), `inkbox_credentials_get_login` (opt), `inkbox_credentials_get_api_key` (opt), `inkbox_credentials_get_ssh_key` (opt), `inkbox_totp_code` (opt).
  - Diagnostic: `inkbox_whoami` (opt).
- Inbound webhook delivery via Inkbox tunnel (`@inkbox/sdk/tunnels/connect`) with HMAC-SHA256 verification, request-id dedup with in-flight suppression, 10k committed-id cap, 5-minute TTL, and event discrimination across mail/text/call payload shapes.
- CLI subcommand group `openclaw inkbox {doctor,whoami,setup}` (interactive setup still a stub).
- Outbound recipient allowlist and inbound contact-id allowlist.
- Lazy Inkbox SDK client with first-call `whoami()` preflight that warns on non-agent-scoped keys.
- Six bundled skills (`inkbox-onboarding`, `inkbox-email-triage`, `inkbox-sms-responder`, `inkbox-call-handler`, `inkbox-contact-lookup`, `inkbox-credential-use`) — each with a tailored "raw Inkbox docs" fallback section pointing at `inkbox.ai/llms.txt` and `inkbox.ai/docs/all.md`.
- `PLAN.md` — 8-phase build roadmap and reference appendices.

### Notes

- This release is **agent-scoped only**. Admin-scoped operations (`createIdentity`, filter-mode flips, contact/note grant management, SMS opt-in writes) are deliberately not exposed.
