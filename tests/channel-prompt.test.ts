import { describe, expect, it } from "vitest";
import { inkboxPlugin } from "../src/channel.js";

const cfg = {
  channels: {
    inkbox: {
      apiKey: "ApiKey_test",
      identity: "smoke-agent",
    },
  },
};

describe("inkbox channel agent prompt", () => {
  it("treats inkbox_whoami as the active identity source of truth", () => {
    const hints = inkboxPlugin.agentPrompt?.messageToolHints?.({ cfg });
    const rules = inkboxPlugin.agentPrompt?.inboundFormattingHints?.({})?.rules;

    expect(hints?.join("\n")).toContain(
      "`inkbox_whoami` is the source of truth for the active sending identity",
    );
    expect(hints?.join("\n")).toContain("Do not infer or invent the active identity");
    expect(rules?.join("\n")).toContain(
      "configured account identity resolved by `inkbox_whoami`",
    );
    expect(rules?.join("\n")).toContain("Do not infer or invent the active identity");
    expect(rules?.join("\n")).toContain(
      "Inbound messages may start with an [inkbox:...] routing marker",
    );
    expect(rules?.join("\n")).toContain("never echo it");
    expect(rules?.join("\n")).toContain(
      "NEVER call inkbox_send_email, inkbox_send_sms, or inkbox_send_imessage",
    );
    expect(rules?.join("\n")).toContain(
      "MUST use the matching Inkbox send tool before finishing the turn",
    );
    expect(rules?.join("\n")).toContain(
      "A normal reply on the inbound channel does not satisfy that request",
    );
    expect(rules?.join("\n")).toContain("include the literal requested values");
    expect(rules?.join("\n")).toContain(
      "marker authenticates the current sender",
    );
    expect(rules?.join("\n")).toContain("do not refuse it on generic privacy grounds");
    expect(rules?.join("\n")).toContain(
      "does not authorize disclosing another contact's details",
    );
  });
});
