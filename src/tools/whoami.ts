import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson } from "../format.js";

// Inbound-call config is identity-scoped: one row covers the dedicated
// number AND the shared iMessage line. Absent config (404) is a valid state,
// not an error — report it as null.
async function readIncomingCallAction(identity: any): Promise<string | null> {
  if (typeof identity.getIncomingCallAction !== "function") {
    // Legacy SDK without the identity-scoped surface — fall back to the
    // number-scoped field.
    return identity.phoneNumber?.incomingCallAction ?? null;
  }
  try {
    const config = await identity.getIncomingCallAction();
    return config?.incomingCallAction ?? null;
  } catch {
    return null;
  }
}

// Diagnostic tool — returns the resolved identity, mailbox, phone, and auth
// subtype the plugin is operating under. Useful when the agent or user is
// debugging configuration ("am I sending from the right identity?").
export function registerWhoami(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_whoami",
      description:
        "Return the resolved Inkbox identity, mailbox address, calling/messaging lines, and API key auth subtype. Use for debugging configuration or confirming which identity outbound messages are being sent from.",
      parameters: Type.Object({}),
      async execute() {
        return runTool(async () => {
          const inkbox = await runtime.getClient();
          const identity = await runtime.getIdentity();
          // whoami() returns the auth context (api_key vs jwt, scoped vs admin).
          // Pair with the identity record so the user sees what they're sending
          // from, not just what they're authenticated as.
          const info = await inkbox.whoami();
          // Present the two lines with explicit labels so the agent describes
          // them correctly: its OWN dedicated phone line vs the SHARED
          // iMessage line. The dedicated number is the one for SMS + voice;
          // the iMessage line's number is managed by Inkbox and never surfaced.
          const dedicatedNumber = identity.phoneNumber?.number ?? null;
          const imessageEnabled = Boolean((identity as any).imessageEnabled);
          const summary = {
            authType: info.authType,
            // Discriminated union — only api_key responses carry authSubtype.
            authSubtype:
              info.authType === "api_key" ? info.authSubtype : undefined,
            keyLabel:
              info.authType === "api_key" ? info.label : undefined,
            organizationId: info.organizationId,
            identity: {
              handle: identity.agentHandle,
              id: identity.id,
              displayName: identity.displayName,
              emailAddress: identity.mailbox?.emailAddress ?? null,
              sendingDomain: identity.mailbox?.sendingDomain ?? null,
              mailboxFilterMode: identity.mailbox?.filterMode ?? null,
              phoneNumber: dedicatedNumber,
              phoneNumberId: identity.phoneNumber?.id ?? null,
              phoneNumberType: identity.phoneNumber?.type ?? null,
              smsStatus: identity.phoneNumber?.smsStatus ?? null,
              smsErrorCode: identity.phoneNumber?.smsErrorCode ?? null,
              incomingCallAction: await readIncomingCallAction(identity),
              phoneFilterMode: identity.phoneNumber?.filterMode ?? null,
              tunnelPublicHost: identity.tunnel?.publicHost ?? null,
            },
            lines: {
              dedicated_phone_line: dedicatedNumber ?? "(none provisioned)",
              dedicated_phone_line_note:
                "Your own phone line for SMS and voice calls. Call from it with origination=dedicated_number.",
              shared_imessage_line: imessageEnabled ? "enabled" : "disabled",
              shared_imessage_line_note:
                "Voice + iMessage with people connected to you over iMessage. Its number is managed by Inkbox and not shown. Call over it with origination=shared_imessage_number.",
            },
          };
          return toolText(formatJson(summary));
        });
      },
    },
    { optional: true },
  );
}
