---
name: inkbox-identity-access
description: Use when the user asks which Inkbox agent identities can see a note, or asks to grant/revoke cross-identity note access. Contacts and generated contact facts are organization-wide.
user-invocable: false
---

# Inkbox identity access

Use this skill when managing per-identity visibility for Inkbox notes. Contacts and generated contact facts do not have per-identity grants.

## Optional tools

- `inkbox_list_note_access`
- `inkbox_grant_note_access`
- `inkbox_revoke_note_access`

## Workflow

1. Resolve the note id first. Use note list/get tools if the user names a note.
2. List current access before changing it when possible.
3. Grant and revoke notes only by explicit `identityId`; notes do not support wildcard grants.
4. If the user gives an agent handle instead of an identity UUID and no tool can resolve handles, explain that you need the identity id or a note access listing that contains it.

## Safety

Note access changes affect what other Inkbox agent identities can see. Confirm the target identity and note before changing access.
