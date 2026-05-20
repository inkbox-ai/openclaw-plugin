---
name: inkbox-email-triage
description: Use when the user asks to check email, triage their inbox, reply to messages, or when an inbound `message.received` event has just arrived from Inkbox. Covers reading unread mail, deciding reply vs forward vs archive, and clearing the unread queue.
user-invocable: false
---

# Inkbox email triage

The Inkbox plugin gives you a working mailbox under an agent identity. Use this skill whenever you're processing inbound email or working through the unread queue.

## Required tools

- `inkbox_list_unread_emails` — start here
- `inkbox_get_email` — for full body when the list summary isn't enough
- `inkbox_get_email_thread` — pull the rest of a thread before replying
- `inkbox_send_email` — write a reply (always pass `inReplyToMessageId` for threading)
- `inkbox_mark_emails_read` (optional, allowlist needed) — clear processed messages

## Workflow

1. **Pull the queue.** Call `inkbox_list_unread_emails` with `limit` matching how much you intend to process this turn (default 25 is reasonable). Each result has `id`, `threadId`, `subject`, `fromAddress`, and a body preview.

2. **Decide per message.** For each unread email:
   - **Trivial reply** → call `inkbox_send_email` immediately with `inReplyToMessageId` set to the original message's `id`. The recipient's client will thread it.
   - **Needs context** → call `inkbox_get_email_thread` with the message's `threadId` to read the full conversation before composing.
   - **Forward to someone** → call `inkbox_forward_email` (optional tool — must be allowlisted). Prefer `mode: "inline"` to re-attach original parts.
   - **No action** → skip; don't mark as read unless you actually processed it.

3. **Clear the queue.** Once a batch is handled, call `inkbox_mark_emails_read` with the ids you processed. Only do this if the tool is allowlisted; otherwise leave them and the user can mark them read manually.

## Reply hygiene

- Always thread replies. The `inReplyToMessageId` parameter on `inkbox_send_email` takes the original message's `id` and threads correctly in the recipient's client.
- Keep the same subject (or prefix with `Re:` once, not stacked).
- If you're replying to a thread, glance at the most recent ~2 messages from `getThread` so you don't repeat what's already been said.

## Errors you may see

- 403 with `recipient_not_opted_in` — only applies to SMS, not email. If you see this on email, surface it as-is.
- 404 — message id is wrong or the message has been deleted; skip and move on.

## What this skill does NOT cover

- Granting other identities access to contacts/notes (admin-only, do via the Inkbox Console).
- Domain-level rule changes (admin-only).
- Inbound webhook handling — that happens at the plugin level, you just see the events as session input.
