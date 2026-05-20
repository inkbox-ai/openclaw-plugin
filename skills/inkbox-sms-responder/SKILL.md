---
name: inkbox-sms-responder
description: Use when the user asks to send a text, reply to an SMS, or process the SMS queue — also use automatically when an inbound `text.received` event arrives from Inkbox. Handles per-conversation context, opt-in/opt-out gates, and the 10DLC carrier propagation window.
user-invocable: false
---

# Inkbox SMS responder

The Inkbox plugin gives you a working phone number under an agent identity. Use this skill for any SMS conversation — short, conversational, opt-in-gated.

## Required tools

- `inkbox_list_text_conversations` — start here for triage; one row per remote number
- `inkbox_get_text_conversation` — pull message history for one remote number before composing
- `inkbox_send_sms` — outbound (E.164, ≤1600 chars)

## Optional (allowlist needed)

- `inkbox_list_texts`, `inkbox_get_text` — low-level access
- `inkbox_mark_text_read`, `inkbox_mark_text_conversation_read` — clear unread state

## Workflow

1. **Pull conversations.** Call `inkbox_list_text_conversations` (defaults: `limit: 25`, newest-updated first). Each row shows `remotePhoneNumber`, `latestText`, `unreadCount`, `totalCount`.

2. **Pick a conversation to handle.** Read the latest text in the row. If you need history, call `inkbox_get_text_conversation` with the remote number and a reasonable `limit` (50 is fine).

3. **Compose and send.** Call `inkbox_send_sms` with `to` in E.164 (`+15551234567`) and `text` ≤1600 chars. Keep the tone conversational — SMS isn't email.

4. **Mark as handled** if you have the optional tool allowlisted: `inkbox_mark_text_conversation_read` with the remote number.

## Gates and errors

- **Opt-in required.** Recipients must have texted `START` to one of your Inkbox numbers. If they haven't, `inkbox_send_sms` returns the plain-language error "Recipient has not opted in to SMS." Surface this to the user; do not try to bypass.
- **Opt-out is final.** If a recipient texted `STOP`, sending returns "Recipient has opted out of SMS." Do not attempt to message them again on the same number.
- **Carrier propagation window.** Newly provisioned local numbers take ~10–15 min to propagate to carriers. During this window, sends return "Your Inkbox phone number is still propagating to carriers." Wait it out; don't retry tight-loop.
- **Toll-free numbers cannot send SMS** today. If the identity's phone is toll-free, sends will fail — recommend the user provision a local number via the setup wizard.
- **Rate cap.** Roughly 15 outbound sends per number per 24h. The plugin surfaces this as a 409. Pause sending and wait.

## SMS-specific style

- Short. Often a single sentence is right.
- Don't include subject lines, signatures, or links unless explicitly asked.
- One thought per message; if it needs multiple parts, send them as separate messages rather than a 1600-char wall.

## What this skill does NOT cover

- Provisioning phone numbers (that's the setup wizard).
- Org-level SMS opt-in registry writes (admin-only, customer-managed 10DLC campaigns only).
- MMS sending (current SDK supports SMS only for outbound).
