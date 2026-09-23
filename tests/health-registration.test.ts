import { describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => new Map<string, any>());
vi.mock("openclaw/plugin-sdk/health", () => ({
  getHealthCheck: (id: string) => registry.get(id),
  registerHealthCheck: (check: any) => {
    if (registry.has(check.id)) throw new Error(`duplicate health check: ${check.id}`);
    registry.set(check.id, check);
  },
}));

describe("health registration across host module graphs", () => {
  it("does not disable plugin discovery when the host registry already owns its checks", async () => {
    const first = await import("../src/health.js");
    first.registerInkboxHealthChecks();
    expect(registry.size).toBe(15);
    vi.resetModules();
    const reloaded = await import("../src/health.js");
    expect(reloaded.registerInkboxHealthChecks).not.toBe(first.registerInkboxHealthChecks);
    expect(() => reloaded.registerInkboxHealthChecks()).not.toThrow();
    expect(registry.size).toBe(15);
  });
});
