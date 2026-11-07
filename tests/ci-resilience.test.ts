import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
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
  it("limits manual channel exclusions to the two phone requests without changing default coverage", () => {
    const workflow = readFileSync(resolve(".github/workflows/live-channels.yml"), "utf8");
    const manual = workflow.split("  workflow_dispatch:")[1].split("permissions:")[0];
    expect(manual).toMatch(/exclude_call_requests:[\s\S]*?type: boolean\s+default: false/);
    expect(workflow.split("  workflow_dispatch:")[0]).not.toContain("exclude_call_requests");
    expect(workflow).toContain("EXCLUDE_CALL_REQUESTS: ${{ github.event_name == 'workflow_dispatch' && inputs.exclude_call_requests == true }}");
    const step = workflow.split("      - name: Run live test")[1].split("      - name:")[0];
    const script = step.split("        run: |\n")[1].replace(/^          /gm, "");
    const root = mkdtempSync(resolve(tmpdir(), "channel-selection-"));
    try {
      writeFileSync(resolve(root, "python3"), '#!/bin/bash\nprintf "%s\\n" "$@" > "$CAPTURE_ARGS"\n', { mode: 0o755 });
      writeFileSync(resolve(root, "ingress"), "https://example.test/webhook\n");
      const run = (mode: string, exclude: string) => {
        execFileSync("bash", ["-e", "-c", script.replaceAll("${{ matrix.mode }}", mode)], {
          env: { ...process.env, PATH: `${root}:${process.env.PATH}`, EXCLUDE_CALL_REQUESTS: exclude,
            AUT_WEBHOOK_URL_FILE: resolve(root, "ingress"), CAPTURE_ARGS: resolve(root, "args") },
        });
        return readFileSync(resolve(root, "args"), "utf8").trim().split("\n");
      };
      const defaults = ["tests/live/channel_failure_diagnostics.py", "tests/live", "-v", "--tb=short", "--maxfail=1"];
      expect(run("real", "false")).toEqual(defaults);
      expect(run("real", "")).toEqual(defaults);
      expect(run("real", "arbitrary-filter")).toEqual(defaults);
      expect(run("real", "true")).toEqual([...defaults,
        "--deselect=tests/live/test_cross_channel.py::test_email_request_gets_call",
        "--deselect=tests/live/test_cross_channel.py::test_sms_request_gets_call",
      ]);
      expect(run("mock", "true")).toEqual(["-m", "pytest", "tests/live", "-v", "--tb=short"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("runs live gateways with the same host version outside the linked plugin tree", () => {
    for (const name of workflows.filter((value) => value.startsWith("live-"))) {
      const workflow = readFileSync(resolve(".github", "workflows", name), "utf8");
      expect(workflow).toContain('HOST_VERSION="$(node -p \'require("./node_modules/openclaw/package.json").version\')"');
      expect(workflow).toContain('install -g "openclaw@$HOST_VERSION"');
      expect(workflow).not.toContain("install -g openclaw@latest");
      expect(workflow).not.toContain('node_modules/.bin" >> "$GITHUB_PATH"');
      expect(workflow).not.toContain("openclaw@2026.5.27");
    }
  });
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
  it("uses published SDK installs without references to an obsolete local build action", () => {
    for (const name of workflows) {
      const workflow = readFileSync(resolve(".github", "workflows", name), "utf8");
      expect(workflow).not.toContain("./.github/actions/inkbox-sdk");
      expect(workflow).not.toContain("INKBOX_SDK_PATH");
      expect(workflow).not.toContain("INKBOX_PYTHON_SDK_PATH");
      if (name.startsWith("live-")) expect(workflow).toContain("inkbox==0.7.29");
    }
  });

});
