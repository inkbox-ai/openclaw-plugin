import { Type } from "typebox";
import type { InkboxRuntime } from "../client.js";
import { runTool, toolText } from "../errors.js";

// Outbound SMS — single-message send from the identity's provisioned phone
// number. Returns a queued TextMessage; final delivery state arrives via the
// inbound webhook (Phase 2).
export function registerSendSms(api: any, runtime: InkboxRuntime): void {
  api.registerTool({
    name: "inkbox_send_sms",
    description:
      "Send an SMS from the configured Inkbox identity's phone number. Use for short outbound text messages. Recipient must have previously texted START to one of your numbers; otherwise the call returns a permission error.",
    parameters: Type.Object({
      to: Type.String({
        description: "Recipient phone number in E.164 format (e.g. +14155550123).",
      }),
      text: Type.String({
        minLength: 1,
        maxLength: 1600,
        description: "Message body (1–1600 chars).",
      }),
    }),
    async execute(_id: string, params: any) {
      return runTool(async () => {
        const identity = await runtime.getIdentity();
        const msg = await identity.sendText({ to: params.to, text: params.text });
        return toolText(
          `Sent SMS id=${msg.id} to=${params.to} status=${msg.deliveryStatus} (${params.text.length} chars)`,
        );
      });
    },
  });
}
