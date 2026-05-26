import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";
import { formatJson } from "../format.js";

// Diagnostic tool — snapshot of channel readiness as the SDK reports it.
// Useful when the agent hits an SMS gating error and wants to know whether
// the issue is provisioning state (smsStatus=PENDING) or recipient consent
// (which the SDK can't preflight from here). Outbound rate caps are
// enforced server-side and only surface in error responses, so we report
// what's introspectable rather than caching state in-process.
export function registerRateStatus(api: any, runtime: InkboxRuntime): void {
  api.registerTool(
    {
      name: "inkbox_rate_status",
      description:
        "Return the current channel-readiness snapshot for the configured identity — mailbox status, phone number type + SMS provisioning state, incoming call routing. Use to debug 'why isn't my SMS sending' before retrying.",
      parameters: Type.Object({}),
      async execute() {
        return runTool(async () => {
          const identity = await runtime.getIdentity();
          const snapshot = {
            identityHandle: identity.agentHandle,
            mailbox: identity.mailbox
              ? {
                  emailAddress: identity.mailbox.emailAddress,
                  // sendingDomain reveals which sending domain is in use;
                  // helps explain why outbound is queued under a different
                  // domain than the user expected.
                  sendingDomain: identity.mailbox.sendingDomain,
                }
              : null,
            phoneNumber: identity.phoneNumber
              ? {
                  number: identity.phoneNumber.number,
                  type: identity.phoneNumber.type,
                  smsStatus: identity.phoneNumber.smsStatus,
                  incomingCallAction: identity.phoneNumber.incomingCallAction,
                }
              : null,
          };
          return toolText(formatJson(snapshot));
        });
      },
    },
    { optional: true },
  );
}
