import { describe, expect, it } from "vitest";
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

  it("normalizes provider prefixes", () => {
    expect(normalizeInkboxTarget("inkbox:sms:+14155550123")).toBe("+14155550123");
    expect(parseInkboxTarget("unknown")).toBeNull();
  });
});
