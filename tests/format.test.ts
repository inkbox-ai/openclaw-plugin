import { describe, it, expect } from "vitest";
import { formatJson, formatWithHeader, takeAsync } from "../src/format.js";

describe("formatJson", () => {
  it("wraps a value as a fenced json code block", () => {
    const out = formatJson({ a: 1, b: "two" });
    expect(out.startsWith("```json\n")).toBe(true);
    expect(out.endsWith("\n```")).toBe(true);
    expect(out).toContain('"a": 1');
    expect(out).toContain('"b": "two"');
  });
});

describe("formatWithHeader", () => {
  it("prefixes a one-line header above the json body", () => {
    const out = formatWithHeader("Found 3 items.", [1, 2, 3]);
    expect(out.startsWith("Found 3 items.\n\n")).toBe(true);
    expect(out).toContain("```json");
  });
});

describe("takeAsync", () => {
  it("caps at limit even when source is longer", async () => {
    async function* source() {
      for (let i = 0; i < 100; i++) yield i;
    }
    const got = await takeAsync(source(), 5);
    expect(got).toEqual([0, 1, 2, 3, 4]);
  });

  it("returns everything when source is shorter than limit", async () => {
    async function* source() {
      yield "a";
      yield "b";
    }
    const got = await takeAsync(source(), 100);
    expect(got).toEqual(["a", "b"]);
  });

  it("stops iteration after the cap (does not exhaust source)", async () => {
    let yielded = 0;
    async function* source() {
      while (true) {
        yielded++;
        yield yielded;
      }
    }
    await takeAsync(source(), 3);
    // Source was asked for one extra to hit the break, so 3 or 4 is fine.
    // The point is it didn't run forever.
    expect(yielded).toBeLessThanOrEqual(4);
  });
});
