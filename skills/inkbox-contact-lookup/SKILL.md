---
name: inkbox-contact-lookup
description: Use when the user asks "who is X", "what's the email for Y", "find a contact named Z", or any question that needs to resolve a name or domain to a contact record. Also use as a prereq before sending email/SMS to a name (rather than a literal address).
user-invocable: false
---

# Inkbox contact lookup

The Inkbox plugin gives the agent access to contacts the identity has been granted by an admin. Use this skill to resolve "who is X" or "find me the contact for Y" before doing anything else (replying, calling, texting).

## Required tools

- `inkbox_lookup_contact` — reverse-lookup by exactly one filter (email, phone, emailDomain, emailContains, phoneContains)
- `inkbox_get_contact` — fetch a full contact record by UUID
- `inkbox_list_contacts` — free-text search via `q`, with `order: "recent" | "name"`

## Optional (allowlist needed)

- `inkbox_export_contact_vcard` — vCard 4.0 string export

## Workflow

1. **Lookup-first.** If the user mentions an email or phone, try `inkbox_lookup_contact` first — it's the cheapest path. Pass exactly one filter:
   - `{ "email": "ada@example.com" }`
   - `{ "phone": "+15551234567" }`
   - `{ "emailDomain": "example.com" }`
   - `{ "emailContains": "ada" }`
   - `{ "phoneContains": "555" }`

2. **Fall back to free-text search.** For name-based queries ("find Ada Lovelace"), use `inkbox_list_contacts` with `q: "Ada"`. Match by `givenName` + `familyName` in the results.

3. **Pull the full record when you need it.** If lookup/list returns a contact and you need addresses, vCard fields, or all phone/email entries, call `inkbox_get_contact` with the `id`.

4. **Then act.** Use the resolved email or phone to call `inkbox_send_email`, `inkbox_send_sms`, etc.

## Access semantics

- Contact reads are **filtered server-side** by per-identity grants. If a contact doesn't appear in your list/lookup results, this identity doesn't have access — not necessarily that the contact doesn't exist.
- Lookup may return zero results. Don't retry with the same filter; either widen (try `emailDomain` instead of `email`) or fall back to a free-text `list` query.
- Grant management is admin-only. If the user complains "I can see this contact in the Console but not here," recommend they grant the identity access in the Inkbox Console.

## What this skill does NOT cover

- Granting / revoking contact access (admin-only).
- Bulk vCard import — that's an admin flow, not exposed as an agent tool.
- Creating contacts — admin-only in current plugin scope.
