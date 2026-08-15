import { describe, expect, it } from "vitest";
import {
  beginA2AProgressActivityCapture,
  bindA2AProgressActivityToRun,
  normalizeA2AToolIdentifier,
  recordA2AProgressToolActivity,
} from "../src/a2a-progress-activity.js";
import {
  a2aProgressFallback,
  a2aReceiptText,
  DEFAULT_A2A_PROGRESS_INTERVAL_SECONDS,
  resolveA2AProgressIntervalSeconds,
  sanitizeA2AProgressText,
  taskAgentHistoryContains,
} from "../src/a2a-progress.js";

describe("A2A worker progress", () => {
  it("defaults to three minutes and renders the configured cadence", () => {
    expect(DEFAULT_A2A_PROGRESS_INTERVAL_SECONDS).toBe(180);
    expect(resolveA2AProgressIntervalSeconds(undefined)).toBe(180);
    expect(a2aReceiptText("task-1", 180)).toBe(
      "Task task-1 received. Work is queued and starting. Expect progress updates about every 3 minutes.",
    );
    expect(a2aReceiptText("task-1", 60)).toContain("about every 1 minute.");
  });

  it("uses one generic fallback and rejects terminal or identifier-echoing prose", () => {
    const fallback = a2aProgressFallback(60);
    expect(fallback).toBe("I'm continuing the requested work. (60s elapsed)");
    expect(sanitizeA2AProgressText("The task is complete.", ["run_tests"], 60)).toBe(fallback);
    expect(sanitizeA2AProgressText("I'm blocked waiting for input.", ["run_tests"], 60)).toBe(fallback);
    expect(sanitizeA2AProgressText("I'm using run tests to verify behavior.", ["run_tests"], 60)).toBe(fallback);
    expect(
      sanitizeA2AProgressText(
        `I'm carefully reviewing the requested calculation and its supporting context ${"x".repeat(80)} run tests.`,
        ["run_tests"],
        60,
      ),
    ).toBe(fallback);
  });

  it("always appends the authoritative elapsed time", () => {
    expect(
      sanitizeA2AProgressText(
        "I'm reviewing the calculation. (60s elapsed)",
        ["calculate_values"],
        121,
      ),
    ).toBe("I'm reviewing the calculation. (121s elapsed)");
  });

  it("captures only bounded normalized identifiers for the matching run", () => {
    const capture = beginA2AProgressActivityCapture({
      sessionKey: "session-progress",
      promptMarker: "[task-marker]",
    });
    try {
      bindA2AProgressActivityToRun(
        { prompt: "[task-marker]\nDo the work." },
        { sessionKey: "session-progress", runId: "run-progress" },
      );
      recordA2AProgressToolActivity(
        {
          toolName: " Run SQL Query ",
          runId: "run-progress",
          arguments: { query: "private-value" },
          result: "private-result",
        } as any,
        { sessionKey: "session-progress" },
      );
      recordA2AProgressToolActivity(
        { toolName: "run/sql query", runId: "other-run" },
        { sessionKey: "session-progress" },
      );
      for (let index = 0; index < 10; index += 1) {
        recordA2AProgressToolActivity(
          { toolName: ` Tool ${index} ${"x".repeat(100)}`, runId: "run-progress" },
          { sessionKey: "session-progress" },
        );
      }
      const identifiers = capture.snapshot();
      expect(identifiers).toHaveLength(8);
      expect(identifiers.every((identifier) => identifier.length <= 80)).toBe(true);
      expect(JSON.stringify(identifiers)).not.toContain("private-value");
      expect(JSON.stringify(identifiers)).not.toContain("private-result");
    } finally {
      capture.finish();
    }
    expect(normalizeA2AToolIdentifier(" List Directory Users ")).toBe(
      "list_directory_users",
    );
  });

  it("reconciles delivery from agent messages only", () => {
    const expected = "Task task-1 received.";
    expect(taskAgentHistoryContains({
      messages: [{ role: "caller", parts: [{ text: expected }] }],
    }, expected)).toBe(false);
    expect(taskAgentHistoryContains({
      messages: [{ role: "agent", parts: [{ text: expected }] }],
    }, expected)).toBe(true);
    expect(taskAgentHistoryContains({
      raw: { history: [{ role: "ROLE_AGENT", parts: [{ text: expected }] }] },
    }, expected)).toBe(true);
  });
});
