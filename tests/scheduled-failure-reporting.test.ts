import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readWorkflow = (name: string) =>
  readFileSync(path.join(root, ".github", "workflows", name), "utf8");

describe("scheduled failure reporting", () => {
  it("uses one scheduled and signed reporting path", () => {
    const canary = readWorkflow("canary.yml");
    const stack = readWorkflow("live-stack.yml");
    const report = readWorkflow("scheduled-failure-report.yml");

    expect(canary).toContain("workflow_call:");
    expect(canary).not.toContain("schedule:");
    expect(canary).not.toContain("notify:");
    expect(stack).toContain("schedule:");
    expect(stack).toContain("uses: ./.github/workflows/canary.yml");
    expect(stack).not.toContain("workflow_run:");
    expect(stack).not.toContain("notify:");
    expect(report).toContain('workflows: ["Full stack e2e"]');
    expect(report).toContain("github.event.workflow_run.event == 'schedule'");
    expect(report).toContain("timed_out");
    expect(report).toContain("startup_failure");
    expect(report).toContain("if: always()");
    expect(report).toContain("actions: read");
    expect(report).toContain("X-Hub-Signature-256");
    expect(report).toContain("chat_thread_key");
  });
});
