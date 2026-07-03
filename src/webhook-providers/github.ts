import { createHmac, timingSafeEqual } from "node:crypto";
import { headerLookup, registerProvider, type WebhookVerifyInput } from "./base.js";

const SIGNATURE_HEADER = "X-Hub-Signature-256";

// GitHub webhooks (e.g. a workflow-run failure forwarded here). GitHub signs
// the raw request body as HMAC-SHA256 keyed by the webhook secret and sends
// it as `X-Hub-Signature-256: sha256=<hex>`. The secret is read from
// INKBOX_WEBHOOK_SECRET_GITHUB (see providerSecret in the webhook handler).
export const githubProvider = {
  name: "github",
  providerHeader: SIGNATURE_HEADER,
  verify({ body, headers, secret }: WebhookVerifyInput): boolean {
    // No configured secret → we cannot verify → fail closed.
    if (!secret) {
      return false;
    }
    const sent = headerLookup(headers, SIGNATURE_HEADER);
    if (!sent.startsWith("sha256=")) {
      return false;
    }
    const expected = createHmac("sha256", secret).update(body).digest("hex");
    const sentHex = sent.slice("sha256=".length);
    // Constant-time compare so a bad signature can't be timing-probed.
    const expectedBuf = Buffer.from(expected, "utf8");
    const sentBuf = Buffer.from(sentHex, "utf8");
    return expectedBuf.length === sentBuf.length && timingSafeEqual(expectedBuf, sentBuf);
  },
};

registerProvider(githubProvider);
