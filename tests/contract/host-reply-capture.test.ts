import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { dispatchInboundMessageWithDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { createInkboxTextReplyCapture } from "../../src/reply-capture.js";
import { sanitizeA2AProgressText } from "../../src/a2a-progress.js";

const require = createRequire(import.meta.url);
const dist = dirname(dirname(require.resolve("openclaw/plugin-sdk/reply-runtime")));
const baseline = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")).version === "2026.5.27";

describe("auxiliary answer capture", () => {
  it("keeps normal text while ignoring silence markers and error payloads", () => {
    const capture = createInkboxTextReplyCapture();
    for (const payload of [{ text: "NO_REPLY" }, { text: "[SILENT]" }, { text: "error", isError: true }]) expect(capture.transformReplyPayload(payload)).toBeNull();
    expect(capture.lastText()).toBe("");
    expect(capture.hasError()).toBe(true);
    expect(capture.transformReplyPayload({ text: " I am checking the calculation. " })).toBeNull();
    expect(capture.lastText()).toBe("I am checking the calculation.");
  });
});

describe.skipIf(baseline)("actual host auxiliary progress dispatch", () => {
  it.each([false, true])("captures a summary with intentional transform=%s", async (fixed) => {
    const directory = await mkdtemp(join(tmpdir(), "inkbox-progress-capture-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", directory);
    const capture = createInkboxTextReplyCapture();
    const oldCaptured: string[] = [];
    const summary = "I am checking the requested calculation.";
    const deliver = vi.fn(async (payload: { text?: string }) => {
      if (payload.text) oldCaptured.push(payload.text);
      return { visibleReplySent: false };
    });
    try {
      const result = await dispatchInboundMessageWithDispatcher({
        ctx: {
          Body: "Write a brief progress update.", From: "inkbox:warmup:progress",
          To: "inkbox-warmup:main", OriginatingChannel: "inkbox", OriginatingTo: "inkbox-warmup:main",
          Provider: "inkbox", Surface: "inkbox", ChatType: "direct",
          SessionKey: `agent:main:inkbox:direct:${randomUUID()}`, MessageSid: randomUUID(), CommandAuthorized: true,
        },
        cfg: { session: { store: join(directory, "sessions.json") }, agents: { defaults: { workspace: directory } } },
        dispatcherOptions: { deliver, ...(fixed ? { transformReplyPayload: capture.transformReplyPayload } : {}) },
        replyResolver: async () => ({ text: summary }),
      });
      if (fixed) {
        expect(capture.lastText()).toBe(summary);
        expect(deliver).not.toHaveBeenCalled();
        expect(result.noVisibleReplyFallbackDelivered).not.toBe(true);
        expect(sanitizeA2AProgressText(capture.lastText(), [], 60)).toBe(`${summary} (60s elapsed)`);
      } else {
        expect(oldCaptured[0]).toBe(summary);
        expect(oldCaptured).toHaveLength(2);
        expect(sanitizeA2AProgressText(oldCaptured.at(-1) ?? "", [], 60)).toBe("I'm continuing the requested work. (60s elapsed)");
      }
    } finally {
      vi.unstubAllEnvs();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
