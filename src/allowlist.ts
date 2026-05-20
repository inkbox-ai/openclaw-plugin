// Outbound recipient allowlist + inbound contact allowlist. Both are
// opt-in via config — if the list is undefined or empty, no filtering
// is applied. If set, recipients/contacts not on the list are blocked.

export interface AllowlistConfig {
  allowedRecipients?: string[];
  allowedInboundContactIds?: string[];
}

// Normalize for comparison: lower-case + trim. Phone numbers must already
// be in E.164 in both the allowlist and the input.
function norm(s: string): string {
  return s.trim().toLowerCase();
}

// Check a single outbound recipient against the allowlist. Returns the
// reason string when blocked, or null when allowed.
export function checkOutboundRecipient(
  recipient: string,
  allowed: string[] | undefined,
): string | null {
  if (!allowed || allowed.length === 0) return null;
  const wanted = norm(recipient);
  const hit = allowed.some((entry) => norm(entry) === wanted);
  return hit ? null : `Recipient ${recipient} is not on the outbound allowlist.`;
}

// Check a batch of outbound recipients. Returns the first blocking reason,
// or null if every recipient passes.
export function checkOutboundRecipients(
  recipients: string[],
  allowed: string[] | undefined,
): string | null {
  for (const r of recipients) {
    const block = checkOutboundRecipient(r, allowed);
    if (block) return block;
  }
  return null;
}

// Check an inbound contact id against the inbound allowlist. Returns true
// when the event should be processed, false when it should be dropped.
// Conservative default: if a list is set and the event has no contact id,
// drop the event (unknown sender).
export function inboundContactAllowed(
  contactId: string | null | undefined,
  allowed: string[] | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!contactId) return false;
  return allowed.includes(contactId);
}
