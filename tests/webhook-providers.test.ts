import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { matchProvider, registerProvider } from "../src/webhook-providers/index.js";
import { githubProvider } from "../src/webhook-providers/github.js";

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
