import { afterEach, expect, it, vi } from "vitest";
import * as hints from "../src/channel-hint.js";
import * as calls from "../src/outbound-call-context.js";

afterEach(() => { hints.resetChannelHintsForTest(); vi.restoreAllMocks(); });

it("shares bounded inbound origination hints with prepared call tools", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  hints.recordInboundChannelHint({ mode: "imessage", remoteAddress: "+15555550100" });
  vi.resetModules();
  const tools = await import("../src/channel-hint.js");
  expect(tools.recordInboundChannelHint).not.toBe(hints.recordInboundChannelHint);
  expect(tools.resolveChannelHint("+15555550100")).toBe("imessage");
  hints.recordInboundChannelHint({ mode: "sms", remoteAddress: "+15555550200" });
  expect(tools.resolveChannelHint("+15555550100")).toBe("imessage");
  expect(tools.resolveChannelHint("+15555550200")).toBe("dedicated");
  hints.recordInboundChannelHint({ mode: "email" });
  expect(tools.resolveChannelHint()).toBeUndefined();
  now += 24 * 60 * 60 * 1_000 + 1;
  expect(tools.resolveChannelHint("+15555550100")).toBeUndefined();
});

it("consumes a prepared outbound call's context once in the gateway graph", async () => {
  let now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const context = calls.registerOutboundCallContext({ toNumber: "+15555550100", purpose: "Synthetic call", openingMessage: "Hello" })!;
  const url = new URL(calls.decorateCallWebsocketUrlWithContext("wss://example.test/call", context));
  vi.resetModules();
  const gateway = await import("../src/outbound-call-context.js");
  expect(gateway.registerOutboundCallContext).not.toBe(calls.registerOutboundCallContext);
  expect(gateway.consumeOutboundCallContextFromUrl(new URL("wss://example.test/call?inkbox_call_context_id=unknown"))).toBeUndefined();
  expect(gateway.consumeOutboundCallContextFromUrl(url)).toEqual(context);
  expect(calls.consumeOutboundCallContextFromUrl(url)).toBeUndefined();
  const expired = gateway.registerOutboundCallContext({ toNumber: "+15555550200", context: "Expired context" })!;
  now += 10 * 60 * 1_000 + 1;
  expect(calls.consumeOutboundCallContextFromUrl(new URL(calls.decorateCallWebsocketUrlWithContext("wss://example.test/call", expired)))).toBeUndefined();
});
