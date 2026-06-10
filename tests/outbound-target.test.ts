import { describe, expect, it } from "vitest";
import { inkboxPlugin } from "../src/channel.js";
import { normalizeInkboxTarget, parseInkboxTarget } from "../src/outbound.js";

describe("inkbox outbound target parsing", () => {
  it("recognizes email targets", () => {
    expect(parseInkboxTarget("email:person@example.com")).toEqual({
      mode: "email",
      value: "person@example.com",
    });
    expect(parseInkboxTarget("person@example.com")).toEqual({
      mode: "email",
      value: "person@example.com",
    });
  });

  it("recognizes sms targets", () => {
    expect(parseInkboxTarget("sms:+14155550123")).toEqual({
      mode: "sms",
      value: "+14155550123",
    });
    expect(parseInkboxTarget("+14155550123")).toEqual({
      mode: "sms",
      value: "+14155550123",
    });
  });

  it("recognizes SMS conversation targets", () => {
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseInkboxTarget(`conversation:${conversationId}`)).toEqual({
      mode: "sms-conversation",
      value: conversationId,
    });
    expect(parseInkboxTarget(`sms:${conversationId}`)).toEqual({
      mode: "sms-conversation",
      value: conversationId,
    });
    expect(parseInkboxTarget(conversationId)).toEqual({
      mode: "sms-conversation",
      value: conversationId,
    });
  });

  it("recognizes iMessage targets", () => {
    const conversationId = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseInkboxTarget(`imessage:conversation:${conversationId}`)).toEqual({
      mode: "imessage-conversation",
      value: conversationId,
    });
    expect(parseInkboxTarget(`imessage:${conversationId}`)).toEqual({
      mode: "imessage-conversation",
      value: conversationId,
    });
    expect(parseInkboxTarget(`inkbox:imessage:${conversationId}`)).toEqual({
      mode: "imessage-conversation",
      value: conversationId,
    });
    expect(parseInkboxTarget("imessage:+14155550123")).toEqual({
      mode: "imessage",
      value: "+14155550123",
    });
    // Without the explicit prefix, conversation ids stay on the SMS path.
    expect(parseInkboxTarget(conversationId)).toEqual({
      mode: "sms-conversation",
      value: conversationId,
    });
  });

  it("normalizes provider prefixes", () => {
    expect(normalizeInkboxTarget("inkbox:sms:+14155550123")).toBe("+14155550123");
    expect(normalizeInkboxTarget("inkbox:conversation:conv-1")).toBe("conv-1");
    expect(parseInkboxTarget("unknown")).toBeNull();
  });

  it("advertises group chat support", () => {
    expect(inkboxPlugin.capabilities.chatTypes).toContain("group");
  });
});
