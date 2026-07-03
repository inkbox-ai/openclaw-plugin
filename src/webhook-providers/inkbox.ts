import { verifyWebhook } from "@inkbox/sdk";
import { registerProvider, type WebhookVerifyInput } from "./base.js";

// Events Inkbox itself emits — inbound mail, text, iMessage, and calls.
// Inkbox stamps `X-Inkbox-Signature` as an HMAC-SHA256 over the request id,
// timestamp, and raw body using the org signing key. The SDK owns the
// canonical scheme, so we reuse it verbatim instead of re-implementing it.
export const inkboxProvider = {
  name: "inkbox",
  providerHeader: "X-Inkbox-Signature",
  verify({ body, headers, secret }: WebhookVerifyInput): boolean {
    return verifyWebhook({ payload: body, headers, secret });
  },
};

registerProvider(inkboxProvider);
