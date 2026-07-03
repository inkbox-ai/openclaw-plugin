// Inbound-webhook source identification + signature verification.
//
// Importing a provider module is what registers it — list every provider
// module here so `import "./webhook-providers/index.js"` wires up the full
// registry. Inkbox is registered first so its events always match ahead of
// third-party sources.
import "./inkbox.js";
import "./github.js";

export { matchProvider, registerProvider } from "./base.js";
export type { WebhookProvider, WebhookVerifyInput } from "./base.js";
