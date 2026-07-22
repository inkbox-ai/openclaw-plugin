---
name: inkbox-contact-lookup
description: Use when the user asks "who is X", "what's the email for Y", "find a contact named Z", "save this contact", or any question that needs contact context. Contacts are shared across the Inkbox organization; contact rules and vCard flows are separate surfaces.
user-invocable: false
---

# Inkbox contact lookup

OpenClaw receives contact context on inbound email, SMS, iMessage, and calls when Inkbox resolves the sender, and it can read or update the organization's shared contacts.

## Required tools

- `inkbox_list_contacts` — name-based searches like "who is Alex?"
- `inkbox_lookup_contact` — exact or partial email/phone filters
- `inkbox_get_contact` — fetch a full contact by UUID after list/lookup returns one
- `inkbox_create_contact` — save a new person or contact card
- `inkbox_update_contact` — change an existing contact after you know its UUID
- `inkbox_delete_contact` — delete a contact only after the target is explicit and confirmed

There is no vCard export/import tool in this harness. Contact rule and note access tools are separate tools; use those only when the user explicitly asks to manage allow/block rules or note sharing.

## Workflow

1. **Use resolved inbound context first.** If the message starts with an `[inkbox:...]` marker containing contact fields, use those fields and do not invent missing identity details.
2. **Look up named people.** If the user asks about a named person, call `inkbox_list_contacts` with the name before saying you do not know.
3. **Use literal addresses when supplied.** If the user gives an email address or phone number, use it directly with `inkbox_send_email`, `inkbox_send_sms`, `inkbox_send_imessage`, or `inkbox_place_call`; optionally call `inkbox_lookup_contact` if the user asks who it belongs to.
4. **Create contacts when asked.** If the user asks you to save someone new and provides at least one useful field, call `inkbox_create_contact`.
5. **Update contacts by UUID.** If the user asks you to edit a contact, resolve the contact with list/lookup/get first, then call `inkbox_update_contact` with only the fields that should change. Omitted fields remain unchanged.
6. **Delete cautiously.** If the user asks to delete a contact, confirm the exact target when there is any ambiguity, then call `inkbox_delete_contact` with the UUID.
7. **Ask when the target is ambiguous.** If lookup returns multiple plausible contacts, ask which contact the user means before sending, calling, updating, or deleting.

## Access semantics

- Every identity in the organization can read contacts. Creating, updating, or deleting a contact affects the shared address book.
- Contacts created through `inkbox_create_contact` are Inkbox address-book records, not workspace memories.
- Contacts do not have per-identity access grants. The `inkbox-identity-access` skill manages notes only.

## What this skill does NOT cover

- vCard export/import — not exposed as an agent tool.
- Arbitrary workspace memory. Use Inkbox notes for persistent notes and Inkbox contacts for address-book facts.

## When you need more — raw Inkbox docs

If a lookup filter, contact field, or access semantics question isn't covered here, go to the source:

- **https://inkbox.ai/llms.txt** — LLM-friendly index of every Inkbox doc page.
- **https://inkbox.ai/docs/all.md** — the full Inkbox documentation concatenated as one markdown file.

Prefer fetching these over guessing field names or filter semantics.
