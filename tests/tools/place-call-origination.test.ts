// Outbound-call line resolution: explicit choice, capability fallback, and
// channel-aware defaulting when the identity has BOTH a dedicated number and
// iMessage enabled.
//
// Regression guard for the bug where an agent on an iMessage conversation
// asked to "call me" and the call went out over the dedicated number instead
// of the shared iMessage line.
import { beforeEach, describe, expect, it } from "vitest";
import { resolveCallOrigination } from "../../src/tools/place-call.js";
import {
  recordInboundChannelHint,
  resetChannelHintsForTest,
} from "../../src/channel-hint.js";

function identity(hasNumber: boolean, imessage: boolean) {
  return {
    phoneNumber: hasNumber ? { id: "phone-1", number: "+15550000000" } : null,
    imessageEnabled: imessage,
  };
}

describe("resolveCallOrigination", () => {
  beforeEach(() => {
    resetChannelHintsForTest();
  });

  it("resolves unambiguously when only one line exists", () => {
    expect(resolveCallOrigination(identity(true, false), "")).toBe("dedicated_number");
    expect(resolveCallOrigination(identity(false, true), "")).toBe("shared_imessage_number");
    expect(resolveCallOrigination(identity(false, false), "")).toBeUndefined();
  });

  it("lets an explicit choice win over the conversation channel", () => {
    recordInboundChannelHint({ mode: "imessage", remoteAddress: "+15551230001" });
    expect(
      resolveCallOrigination(identity(true, true), "dedicated_number", "+15551230001"),
    ).toBe("dedicated_number");
    recordInboundChannelHint({ mode: "sms", remoteAddress: "+15551230001" });
    expect(
      resolveCallOrigination(identity(true, true), "shared_imessage_number", "+15551230001"),
    ).toBe("shared_imessage_number");
  });

  it("follows the conversation channel when both lines exist", () => {
    const both = identity(true, true);
    recordInboundChannelHint({ mode: "imessage", remoteAddress: "+15551230001" });
    expect(resolveCallOrigination(both, "", "+15551230001")).toBe("shared_imessage_number");
    recordInboundChannelHint({ mode: "sms", remoteAddress: "+15551230001" });
    expect(resolveCallOrigination(both, "", "+15551230001")).toBe("dedicated_number");
    recordInboundChannelHint({ mode: "voice", remoteAddress: "+15551230001" });
    expect(resolveCallOrigination(both, "", "+15551230001")).toBe("dedicated_number");
  });

  it("keys the hint by remote address, falling back to the latest turn", () => {
    // Two conversations on different channels: calling each person follows
    // THEIR channel, and an unknown number follows the current (latest) turn.
    recordInboundChannelHint({ mode: "imessage", remoteAddress: "+15551230001" });
    recordInboundChannelHint({ mode: "sms", remoteAddress: "+15551230002" });
    const both = identity(true, true);
    expect(resolveCallOrigination(both, "", "+15551230001")).toBe("shared_imessage_number");
    expect(resolveCallOrigination(both, "", "+15551230002")).toBe("dedicated_number");
    expect(resolveCallOrigination(both, "", "+15559990000")).toBe("dedicated_number");
  });

  it("defaults to the dedicated number when both lines exist and the channel is unknown", () => {
    expect(resolveCallOrigination(identity(true, true), "")).toBe("dedicated_number");
    // An email turn says nothing about phone lines.
    recordInboundChannelHint({ mode: "email", remoteAddress: "ada@example.com" });
    expect(resolveCallOrigination(identity(true, true), "")).toBe("dedicated_number");
  });

  it("uses the channel only to break ties, never to disable the only line", () => {
    // An iMessage-only identity stays shared even on an SMS-looking turn.
    recordInboundChannelHint({ mode: "sms", remoteAddress: "+15551230001" });
    expect(resolveCallOrigination(identity(false, true), "", "+15551230001")).toBe(
      "shared_imessage_number",
    );
  });
});
