# Changelog

All notable changes to `@inkbox/openclaw-plugin` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Inbound HTTP `publicUrl` override path (skip the Inkbox tunnel when OpenClaw is already publicly reachable).
- `inkbox_rate_status` diagnostic tool — surfaces phone-number SMS status and provisioning state.
- `inkbox_place_call` outbound voice tool (caller provides `clientWebsocketUrl` until the in-plugin audio bridge lands).
- `inkbox-outreach-sequence` skill covering multi-step outreach over email + SMS.

## [0.1.0] - 2026-05-20

Initial scaffold and feature-complete agent-scoped tool surface, minus channel-plugin promotion and interactive setup wizard.

### Added

- Tool plugin entry (`index.ts`) registering 31 agent tools:
  - Outbound: `inkbox_send_email`, `inkbox_send_sms`, `inkbox_forward_email` (opt).
  - Email reads: `inkbox_list_unread_emails`, `inkbox_list_emails`, `inkbox_get_email`, `inkbox_get_email_thread`, `inkbox_mark_emails_read` (opt).
  - SMS reads: `inkbox_list_text_conversations`, `inkbox_get_text_conversation`, `inkbox_list_texts` (opt), `inkbox_get_text` (opt), `inkbox_mark_text_read` (opt), `inkbox_mark_text_conversation_read` (opt).
  - Call reads: `inkbox_list_calls`, `inkbox_list_call_transcripts`.
  - Contacts: `inkbox_lookup_contact`, `inkbox_get_contact`, `inkbox_list_contacts`, `inkbox_export_contact_vcard` (opt).
  - Notes: `inkbox_list_notes`, `inkbox_get_note`, `inkbox_create_note`, `inkbox_update_note` (opt), `inkbox_delete_note` (opt).
  - Vault: `inkbox_credentials_list` (opt), `inkbox_credentials_get_login` (opt), `inkbox_credentials_get_api_key` (opt), `inkbox_credentials_get_ssh_key` (opt), `inkbox_totp_code` (opt).
  - Diagnostic: `inkbox_whoami` (opt).
- Inbound webhook delivery via Inkbox tunnel (`@inkbox/sdk/tunnels/connect`) with HMAC-SHA256 verification, request-id LRU dedup (10k entries), and event discrimination across mail/text/call payload shapes.
- CLI subcommand group `openclaw inkbox {doctor,whoami,setup}` (interactive setup still a stub).
- Outbound recipient allowlist and inbound contact-id allowlist.
- Lazy Inkbox SDK client with first-call `whoami()` preflight that warns on non-agent-scoped keys.
- Six bundled skills (`inkbox-onboarding`, `inkbox-email-triage`, `inkbox-sms-responder`, `inkbox-call-handler`, `inkbox-contact-lookup`, `inkbox-credential-use`) — each with a tailored "raw Inkbox docs" fallback section pointing at `inkbox.ai/llms.txt` and `inkbox.ai/docs/all.md`.
- `PLAN.md` — 8-phase build roadmap and reference appendices.

### Notes

- This release is **agent-scoped only**. Admin-scoped operations (`createIdentity`, filter-mode flips, contact/note grant management, SMS opt-in writes) are deliberately not exposed.
