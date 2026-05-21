import { describe, it, expect } from "vitest";
import { InkboxAPIError } from "@inkbox/sdk";
import { mapInkboxError, runTool, toolError, toolText } from "../src/errors.js";

function apiError(statusCode: number, detail: string | object): InkboxAPIError {
  // InkboxAPIError accepts (statusCode, detail). Construct as a real instance
  // so the instanceof check in mapInkboxError matches.
  return new InkboxAPIError(statusCode, detail as any);
}

describe("toolText / toolError", () => {
  it("toolText is not an error", () => {
    const r = toolText("hi");
    expect(r.isError).toBeUndefined();
    expect(r.content[0]).toEqual({ type: "text", text: "hi" });
  });

  it("toolError is flagged isError", () => {
    const r = toolError("nope");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("nope");
  });
});

describe("mapInkboxError", () => {
  it("surfaces sender_sms_pending as plain-language guidance", () => {
    const out = mapInkboxError(apiError(403, "sender_sms_pending"));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("propagating to carriers");
  });

  it("surfaces recipient_not_opted_in", () => {
    const out = mapInkboxError(apiError(403, "recipient_not_opted_in"));
    expect(out.content[0].text).toContain("opted in");
    expect(out.content[0].text).toContain("START");
  });

  it("surfaces recipient_opted_out", () => {
    const out = mapInkboxError(apiError(403, "recipient_opted_out"));
    expect(out.content[0].text).toContain("opted out");
  });

  it("falls through to a generic 403 message for unknown detail strings", () => {
    const out = mapInkboxError(apiError(403, "something_else"));
    expect(out.content[0].text).toContain("Permission denied");
    expect(out.content[0].text).toContain("something_else");
  });

  it("handles 404, 409, 422 with their canonical labels", () => {
    expect(mapInkboxError(apiError(404, "no such")).content[0].text).toContain("Not found");
    expect(mapInkboxError(apiError(409, "dupe")).content[0].text).toContain("Conflict");
    expect(mapInkboxError(apiError(422, "bad")).content[0].text).toContain("Validation");
  });

  it("stringifies structured detail objects", () => {
    const out = mapInkboxError(apiError(409, { code: "dupe", existingId: "x" }));
    expect(out.content[0].text).toContain("dupe");
    expect(out.content[0].text).toContain("existingId");
  });

  it("handles non-InkboxAPIError exceptions", () => {
    const out = mapInkboxError(new Error("network down"));
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("network down");
  });

  it("handles thrown non-Error values", () => {
    const out = mapInkboxError("oops");
    expect(out.content[0].text).toContain("oops");
  });
});

describe("runTool", () => {
  it("returns the function's result on success", async () => {
    const out = await runTool(async () => toolText("done"));
    expect(out.content[0].text).toBe("done");
    expect(out.isError).toBeUndefined();
  });

  it("maps thrown errors to a ToolTextResult error", async () => {
    const out = await runTool(async () => {
      throw apiError(404, "not found");
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("Not found");
  });

  it("does not swallow non-Inkbox errors", async () => {
    const out = await runTool(async () => {
      throw new TypeError("bad shape");
    });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain("bad shape");
  });
});
