import { describe, it, expect } from "vitest";
import { RequestIdDedup } from "../../src/inbound/dedup.js";

describe("RequestIdDedup", () => {
  it("reports unseen ids as not present", () => {
    const d = new RequestIdDedup();
    expect(d.has("req-1")).toBe(false);
  });

  it("reports remembered ids as present", () => {
    const d = new RequestIdDedup();
    d.remember("req-1");
    expect(d.has("req-1")).toBe(true);
  });

  it("tracks in-flight ids before commit", () => {
    const d = new RequestIdDedup();
    expect(d.begin("req-1")).toBe(true);
    expect(d.has("req-1")).toBe(true);
    expect(d.begin("req-1")).toBe(false);
    d.commit("req-1");
    expect(d.has("req-1")).toBe(true);
  });

  it("rolls back in-flight ids without remembering them", () => {
    const d = new RequestIdDedup();
    expect(d.begin("req-1")).toBe(true);
    d.rollback("req-1");
    expect(d.has("req-1")).toBe(false);
    expect(d.begin("req-1")).toBe(true);
  });

  it("is idempotent on remember", () => {
    const d = new RequestIdDedup();
    d.remember("req-1");
    d.remember("req-1");
    d.remember("req-1");
    expect(d.size()).toBe(1);
    expect(d.has("req-1")).toBe(true);
  });

  it("evicts the oldest entry when size exceeds maxSize", () => {
    const d = new RequestIdDedup(3);
    d.remember("a");
    d.remember("b");
    d.remember("c");
    expect(d.size()).toBe(3);
    d.remember("d");
    expect(d.size()).toBe(3);
    // "a" was oldest; should have been evicted.
    expect(d.has("a")).toBe(false);
    expect(d.has("b")).toBe(true);
    expect(d.has("c")).toBe(true);
    expect(d.has("d")).toBe(true);
  });

  it("handles repeated remember of the most recent without re-ordering", () => {
    const d = new RequestIdDedup(2);
    d.remember("a");
    d.remember("b");
    // Re-remembering "b" should not change anything.
    d.remember("b");
    d.remember("c");
    // "a" was first in; should have been evicted by "c".
    expect(d.has("a")).toBe(false);
    expect(d.has("b")).toBe(true);
    expect(d.has("c")).toBe(true);
  });
});
