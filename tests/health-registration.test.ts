import { beforeEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  checks: new Map<string, any>(),
  failOn: "",
}));
vi.mock("openclaw/plugin-sdk/health", () => ({
  getHealthCheck: (id: string) => host.checks.get(id),
  registerHealthCheck: (check: any) => {
    if (host.checks.has(check.id)) throw new Error("duplicate health check");
    if (check.id === host.failOn) throw new Error("registration interrupted");
    host.checks.set(check.id, check);
  },
}));

beforeEach(() => {
  host.checks.clear();
  host.failOn = "";
  vi.resetModules();
});

describe("health registration lifecycle", () => {
  it("preserves all checks when the plugin reloads but the host registry survives", async () => {
    const first = await import("../src/health.js");
    first.registerInkboxHealthChecks();
    const registered = [...host.checks.entries()];
    expect(registered).toHaveLength(15);

    vi.resetModules();
    const reloaded = await import("../src/health.js");
    expect(reloaded.registerInkboxHealthChecks).not.toBe(first.registerInkboxHealthChecks);
    expect(() => reloaded.registerInkboxHealthChecks()).not.toThrow();
    expect([...host.checks.entries()]).toEqual(registered);
    expect(registered.every(([, check]) => typeof check.detect === "function")).toBe(true);
  });

  it("finishes a partially interrupted registration without duplicating earlier checks", async () => {
    const { registerInkboxHealthChecks } = await import("../src/health.js");
    host.failOn = "inkbox/config-missing-identity";
    expect(registerInkboxHealthChecks).toThrow("registration interrupted");
    expect(host.checks.size).toBe(1);

    host.failOn = "";
    expect(registerInkboxHealthChecks).not.toThrow();
    expect(host.checks.size).toBe(15);
  });

  it("does not hide a conflicting check registered by another source", async () => {
    const other = { id: "inkbox/config-missing-api-key", kind: "plugin", source: "other" };
    host.checks.set(other.id, other);
    const { registerInkboxHealthChecks } = await import("../src/health.js");
    expect(registerInkboxHealthChecks).toThrow("duplicate health check");
    expect(host.checks.get(other.id)).toBe(other);
  });
});
