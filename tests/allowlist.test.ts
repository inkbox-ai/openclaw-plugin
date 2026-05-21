import { describe, it, expect } from "vitest";
import {
  checkOutboundRecipient,
  checkOutboundRecipients,
  inboundContactAllowed,
} from "../src/allowlist.js";

describe("checkOutboundRecipient", () => {
  it("returns null when no allowlist is set", () => {
    expect(checkOutboundRecipient("foo@example.com", undefined)).toBeNull();
    expect(checkOutboundRecipient("foo@example.com", [])).toBeNull();
  });

  it("passes recipients on the list", () => {
    expect(
      checkOutboundRecipient("ada@example.com", ["ada@example.com", "+15551234567"]),
    ).toBeNull();
  });

  it("blocks recipients not on the list", () => {
    const result = checkOutboundRecipient("evil@example.com", ["ada@example.com"]);
    expect(result).toContain("evil@example.com");
    expect(result).toContain("not on the outbound allowlist");
  });

  it("case-insensitive and trim-tolerant", () => {
    expect(
      checkOutboundRecipient("  ADA@Example.COM  ", ["ada@example.com"]),
    ).toBeNull();
  });
});

describe("checkOutboundRecipients", () => {
  it("returns null when all recipients pass", () => {
    expect(
      checkOutboundRecipients(["a@x.com", "b@x.com"], ["a@x.com", "b@x.com"]),
    ).toBeNull();
  });

  it("blocks on the first non-matching recipient", () => {
    const result = checkOutboundRecipients(
      ["ok@x.com", "blocked@x.com", "also@x.com"],
      ["ok@x.com"],
    );
    expect(result).toContain("blocked@x.com");
  });

  it("passes when allowlist undefined", () => {
    expect(checkOutboundRecipients(["a@x.com", "b@x.com"], undefined)).toBeNull();
  });
});

describe("inboundContactAllowed", () => {
  it("allows everything when no allowlist", () => {
    expect(inboundContactAllowed("contact-1", undefined)).toBe(true);
    expect(inboundContactAllowed(null, undefined)).toBe(true);
    expect(inboundContactAllowed("contact-1", [])).toBe(true);
  });

  it("allows contact ids on the list", () => {
    expect(inboundContactAllowed("contact-1", ["contact-1", "contact-2"])).toBe(true);
  });

  it("blocks contact ids not on the list", () => {
    expect(inboundContactAllowed("contact-3", ["contact-1"])).toBe(false);
  });

  it("drops events with no contact id when an allowlist is set (conservative)", () => {
    expect(inboundContactAllowed(null, ["contact-1"])).toBe(false);
    expect(inboundContactAllowed(undefined, ["contact-1"])).toBe(false);
  });
});
