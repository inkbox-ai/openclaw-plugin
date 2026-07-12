import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  installTunnelWarnFilter,
  isExpectedIdleCapWarning,
} from "../../src/inbound/tunnel.js";

describe("tunnel warn filter", () => {
  const savedWarn = console.warn;
  let sink: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Substitute a spy as the "original" console.warn so the filter wraps
    // it and we can assert exactly what passes through.
    sink = vi.fn();
    console.warn = sink;
  });

  afterEach(() => {
    console.warn = savedWarn;
  });

  it("suppresses the expected intake idle-cap warning", () => {
    installTunnelWarnFilter();
    console.warn("/_system/intake slot=3 -> status=408 reason=intake-idle-cap");
    expect(sink).not.toHaveBeenCalled();
  });

  it("keeps 401 owner-token warnings visible", () => {
    installTunnelWarnFilter();
    console.warn(
      "/_system/intake slot=3 -> status=401 reason=owner-token-invalid",
    );
    expect(sink).toHaveBeenCalledWith(
      "/_system/intake slot=3 -> status=401 reason=owner-token-invalid",
    );
  });

  it("keeps status=408 with a different reason visible", () => {
    installTunnelWarnFilter();
    console.warn("/_system/intake slot=3 -> status=408 reason=intake-superseded");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("keeps unrelated tunnel warnings visible", () => {
    installTunnelWarnFilter();
    console.warn("tunnel runtime: h2 session error", new Error("boom"));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it("passes non-string first arguments through", () => {
    installTunnelWarnFilter();
    const err = new Error("status=408 reason=intake-idle-cap");
    console.warn(err);
    expect(sink).toHaveBeenCalledWith(err);
  });

  it("is idempotent — a second install does not re-wrap", () => {
    installTunnelWarnFilter();
    const wrapped = console.warn;
    installTunnelWarnFilter();
    expect(console.warn).toBe(wrapped);
    // Still exactly one layer: a passthrough line reaches the sink once.
    console.warn("tunnel runtime disconnected");
    expect(sink).toHaveBeenCalledTimes(1);
  });
});

describe("isExpectedIdleCapWarning", () => {
  it("requires all three markers", () => {
    expect(
      isExpectedIdleCapWarning(
        "/_system/intake slot=0 -> status=408 reason=intake-idle-cap",
      ),
    ).toBe(true);
    expect(isExpectedIdleCapWarning("status=408 reason=intake-idle-cap")).toBe(
      false,
    );
    expect(
      isExpectedIdleCapWarning("/_system/intake slot=0 -> status=408 reason="),
    ).toBe(false);
    expect(isExpectedIdleCapWarning(undefined)).toBe(false);
  });
});
