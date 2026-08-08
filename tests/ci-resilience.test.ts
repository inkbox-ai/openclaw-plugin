import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflows = [
  "canary.yml",
  "tests.yml",
  "live-a2a.yml",
  "live-channels.yml",
  "live-external-events.yml",
  "live-voice.yml",
];

describe("CI resilience contracts", () => {
  it("bounds setup-only npm retries in every host workflow", () => {
    for (const name of workflows) {
      const workflow = readFileSync(
        resolve(".github", "workflows", name),
        "utf8",
      );
      expect(workflow).toContain("tests/ci/npm_with_retry.sh");
      expect(workflow).not.toMatch(/^\s*npm (?:ci|install)/m);
    }
  });

  it("does not publish content-bearing live logs or identity state", () => {
    for (const name of workflows.filter((value) => value.startsWith("live-"))) {
      const workflow = readFileSync(
        resolve(".github", "workflows", name),
        "utf8",
      );
      expect(workflow).not.toContain("actions/upload-artifact");
      expect(workflow).not.toMatch(/cat \"\$(?:GATEWAY_LOG|DRIVER_LOG|DRIVER_STATE)/);
      expect(workflow).not.toContain("openclaw-*.log");
      expect(workflow).not.toContain("AUT handle:");
      if (name !== "live-a2a.yml") {
        expect(workflow).toContain("--tb=short");
      }
    }
  });

  it("keeps cross-channel live side effects single-attempt", () => {
    const source = readFileSync(
      resolve("tests", "live", "test_cross_channel.py"),
      "utf8",
    );
    expect(source).toContain("CALL_ATTEMPTS = 1");
    expect(source).toContain("EMAIL_ATTEMPTS = 1");
  });
});
