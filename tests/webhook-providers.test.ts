import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchProvider, registerProvider } from "../src/webhook-providers/index.js";
import { githubProvider } from "../src/webhook-providers/github.js";
import { inkboxProvider } from "../src/webhook-providers/inkbox.js";

describe("matchProvider", () => {
  it("classifies by signature header before any verification runs", () => {
    expect(matchProvider({ "x-inkbox-signature": "sig" })?.name).toBe("inkbox");
    expect(matchProvider({ "x-hub-signature-256": "sha256=abc" })?.name).toBe("github");
  });

  it("matches headers case-insensitively", () => {
    expect(matchProvider({ "X-Hub-Signature-256": "sha256=abc" })?.name).toBe("github");
  });

  it("returns undefined for a request no registered source claims", () => {
    expect(matchProvider({ "x-random-header": "1" })).toBeUndefined();
    expect(matchProvider({})).toBeUndefined();
  });

  it("prefers Inkbox when both headers are present", () => {
    // A forged third-party header on an Inkbox-signed request must not
    // reroute it: Inkbox registers first and wins.
    expect(
      matchProvider({
        "x-inkbox-signature": "sig",
        "x-hub-signature-256": "sha256=abc",
      })?.name,
    ).toBe("inkbox");
  });
});

describe("registerProvider", () => {
  it("rejects a second provider claiming an already-registered header", () => {
    expect(() =>
      registerProvider({
        name: "github-clone",
        providerHeader: "X-Hub-Signature-256",
        verify: () => false,
      }),
    ).toThrow(/collision/);
  });
});

describe("github provider verify", () => {
  const body = JSON.stringify({ action: "completed" });
  const secret = "gh-secret";

  function signedHeaders(signingSecret: string): Record<string, string> {
    const digest = createHmac("sha256", signingSecret).update(body).digest("hex");
    return { "x-hub-signature-256": `sha256=${digest}` };
  }

  it("accepts a valid HMAC-SHA256 signature", () => {
    expect(
      githubProvider.verify({ body, headers: signedHeaders(secret), secret }),
    ).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(
      githubProvider.verify({ body, headers: signedHeaders("other"), secret }),
    ).toBe(false);
  });

  it("fails closed without a configured secret", () => {
    expect(
      githubProvider.verify({ body, headers: signedHeaders(secret), secret: "" }),
    ).toBe(false);
  });

  it("rejects a missing or unprefixed signature header", () => {
    expect(githubProvider.verify({ body, headers: {}, secret })).toBe(false);
    expect(
      githubProvider.verify({
        body,
        headers: { "x-hub-signature-256": "abcdef" },
        secret,
      }),
    ).toBe(false);
  });
});

describe("inkbox provider verify", () => {
  const body = JSON.stringify({ event_type: "message.received" });
  const secret = "whsec_inkbox-secret";
  const requestId = "req-1";
  const timestamp = "1747900800";

  function headers(signature: string): Record<string, string> {
    return {
      "x-inkbox-signature": signature,
      "x-inkbox-request-id": requestId,
      "x-inkbox-timestamp": timestamp,
    };
  }

  function sign(): string {
    const digest = createHmac("sha256", "inkbox-secret")
      .update(`${requestId}.${timestamp}.${body}`)
      .digest("hex");
    return `sha256=${digest}`;
  }

  it("accepts a valid signature", () => {
    expect(inkboxProvider.verify({ body, headers: headers(sign()), secret })).toBe(true);
  });

  it("rejects a malformed signature instead of throwing", () => {
    // The SDK's timing-safe compare throws on a length mismatch.
    expect(inkboxProvider.verify({ body, headers: headers("sha256=x"), secret })).toBe(false);
    expect(
      inkboxProvider.verify({ body, headers: headers(sign().slice(0, -1)), secret }),
    ).toBe(false);
  });
});
