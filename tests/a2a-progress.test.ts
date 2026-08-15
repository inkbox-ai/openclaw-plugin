import { describe, expect, it } from "vitest";
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

  it("uses coarse activity only and rejects terminal model claims", () => {
    const fallback = a2aProgressFallback(
      ["researching information", "running verification checks"],
      60,
    );
    expect(fallback).toBe(
      "I'm researching information and running verification checks. (60s elapsed)",
    );
    expect(sanitizeA2AProgressText("The task is complete.", fallback, 60)).toBe(fallback);
    expect(sanitizeA2AProgressText("I'm blocked waiting for input.", fallback, 60)).toBe(fallback);
  });

  it("always appends the authoritative elapsed time", () => {
    const fallback = a2aProgressFallback([], 121);

    expect(
      sanitizeA2AProgressText(
        "I'm reviewing the calculation. (60s elapsed)",
        fallback,
        121,
      ),
    ).toBe("I'm reviewing the calculation. (121s elapsed)");
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
