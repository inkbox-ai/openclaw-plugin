import { describe, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ getIdentity: vi.fn(), whoami: vi.fn(async () => ({ authType: "api_key", authSubtype: "api_key_agent_scoped_claimed" })) }));
vi.mock("@inkbox/sdk", () => ({
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_CLAIMED: "api_key_agent_scoped_claimed",
  AUTH_SUBTYPE_API_KEY_AGENT_SCOPED_UNCLAIMED: "api_key_agent_scoped_unclaimed",
  Inkbox: class { getIdentity = calls.getIdentity; whoami = calls.whoami; },
}));
import { createInkboxRuntime } from "../src/client.js";
describe("identity startup recovery", () => {
  it("does not cache failed initialization forever and reuses a recovered identity", async () => {
    calls.getIdentity.mockReset().mockRejectedValueOnce(new Error("temporary startup failure")).mockResolvedValue({ id: "identity-one" });
    const runtime = createInkboxRuntime({ apiKey: "synthetic-test-key", identity: "example-agent" });
    await expect(runtime.getIdentity()).rejects.toThrow("temporary startup failure");
    expect(await runtime.getIdentity()).toEqual({ id: "identity-one" });
    await runtime.getIdentity(); expect(calls.getIdentity).toHaveBeenCalledTimes(2);
  });
  it("a late failed old initialization cannot discard a newer identity selection", async () => {
    let reject!: (error: Error) => void;
    calls.getIdentity.mockReset().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue({ id: "identity-two" });
    let identity = "old-agent";
    const runtime = createInkboxRuntime(() => ({ apiKey: "synthetic-test-key", identity }));
    const old = runtime.getIdentity(); const rejected = expect(old).rejects.toThrow("old startup");
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"));
    identity = "new-agent"; expect(await runtime.getIdentity()).toEqual({ id: "identity-two" });
    reject(new Error("old startup")); await rejected;
    expect(await runtime.getIdentity()).toEqual({ id: "identity-two" }); expect(calls.getIdentity).toHaveBeenCalledTimes(2);
  });
});
