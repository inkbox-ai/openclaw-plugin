---
name: inkbox-identity-access
description: Use when the user asks which Inkbox agent identities can see a contact or note, or asks to grant/revoke cross-identity note access. Contacts are organization-wide; notes remain identity-scoped.
user-invocable: false
---

# Inkbox identity access

Use this skill when explaining organization-wide contact visibility or managing per-identity note access.

## Optional tools

- `inkbox_list_note_access`
- `inkbox_grant_note_access`
- `inkbox_revoke_note_access`

## Workflow

1. If the request concerns a contact, explain that every identity in the organization can see it and that contact access cannot be granted or revoked per identity.
2. For notes, resolve the note id with the note lookup/list/get tools.
3. List current note access before changing it when possible.
4. Grant and revoke note access only by explicit `identityId`; notes do not support wildcard grants.
5. If the user gives an agent handle instead of an identity UUID and no tool can resolve handles, explain that you need the identity id or a note access listing that contains it.

## Safety

Note access changes affect what other Inkbox agent identities can see. Confirm the target identity and note before changing access.
