import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson } from "../format.js";

// Diagnostic tool — returns the resolved identity, mailbox, phone, and auth
// subtype the plugin is operating under. Useful when the agent or user is
// debugging configuration ("am I sending from the right identity?").
export function registerWhoami(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_whoami",
      description:
        "Return the resolved Inkbox identity, mailbox address, phone number, and API key auth subtype. Use for debugging configuration or confirming which identity outbound messages are being sent from.",
      parameters: Type.Object({}),
      async execute() {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const identity = await runtime.getIdentity();
          // whoami() returns the auth context (api_key vs jwt, scoped vs admin).
          // Pair with the identity record so the user sees what they're sending
          // from, not just what they're authenticated as.
          const info = await inkbox.whoami();
          const summary = {
            authType: info.authType,
            // Discriminated union — only api_key responses carry authSubtype.
            authSubtype:
              info.authType === "api_key" ? info.authSubtype : undefined,
            keyLabel:
              info.authType === "api_key" ? info.label : undefined,
            organizationId: info.organizationId,
            identity: {
              handle: identity.handle,
              emailAddress: identity.mailbox?.emailAddress ?? null,
              phoneNumber: identity.phoneNumber?.number ?? null,
              smsStatus: identity.phoneNumber?.smsStatus ?? null,
            },
          };
          return toolText(formatJson(summary));
        });
      },
    },
    { optional: true },
  );
}
