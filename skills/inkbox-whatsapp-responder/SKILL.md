---
name: inkbox-whatsapp-responder
description: Respond to an approved dedicated one-to-one WhatsApp conversation with the configured Inkbox identity.
---

# WhatsApp conversations

WhatsApp requires approved access on the same number as the agent's dedicated personal iMessage line. Read `inkbox_get_whatsapp_status`; if access is unavailable, request it in the Inkbox Console. Do not enable it with identity edits, invent a shared number, or switch to SMS/iMessage automatically.

An ordinary final answer is sent automatically to the originating conversation. Do not also send it with a tool. For an explicitly requested separate action, use `inkbox_send_whatsapp` with one E.164 `to` or one existing `conversationId`, never both. Keep its logical-send `idempotencyKey` after uncertainty. A delivery notification is status only, never another request to answer or permission to resend.

Text is limited to 4,000 Unicode code points. Upload one local file up to 20 MiB with `inkbox_upload_whatsapp_media`, retain the returned media ID, and use `mediaIds` when sending. Reuse that ID after a send timeout rather than uploading again. Incoming attachment metadata includes an available local path or an explicit unavailable notice. Do not silently drop unavailable attachments or claim to have read bytes that were not available. Refresh temporary URLs with `inkbox_get_whatsapp_media`.

Use conversation/message read tools for retained history. `inkbox_lookup_whatsapp_send` is a read-only recovery lookup using the original `idempotency_key`; a missing result does not authorize a new key. `inkbox_mark_whatsapp_read` affects local unread history through an exact message boundary, not remote receipts.

Groups, quoted replies, reactions, typing, WhatsApp calls and remote read receipts are unsupported.

Public reference: https://inkbox.ai/docs/capabilities/whatsapp and https://inkbox.ai/docs/api/whatsapp.
