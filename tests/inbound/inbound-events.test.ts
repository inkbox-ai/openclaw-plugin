import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@inkbox/sdk", () => ({ verifyWebhook: vi.fn(() => true) }));

import {
  AGENT_BODY_MAX_BYTES,
  SCRIPT_RETRY_DELAYS_MS,
  buildInboundMessage,
  createInboundEventHandler,
  localDeliveryMode,
  runInboundScript,
  type InboundEventData,
} from "../../src/inbound/inbound-events.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";
import { RequestIdDedup } from "../../src/inbound/dedup.js";

function inboundEvent(handler: Record<string, unknown> = { type: "agent" }, overrides: Record<string, unknown> = {}) {
  return {
    event_type: "inbound.received",
    timestamp: "2026-11-19T00:00:00Z",
    data: {
      event_id: "inbev_1",
      delivery_id: "inbdlv_1",
      received_at: "2026-11-19T00:00:00Z",
      source: { id: "inbsrc_1", name: "payments", instructions: "Record paid invoices." },
      handler,
      signature_verified: true,
      request: {
        method: "POST",
        query: {},
        headers: { "content-type": "application/json" },
        content_type: "application/json",
        body: '{"paid":true}',
        body_encoding: "utf8",
      },
      ...overrides,
    },
  };
}

async function settle(handler: ReturnType<typeof createInboundEventHandler>, id = "inbdlv_1") {
  await vi.waitFor(() => expect(handler.state(id)).toBe("completed"));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("localDeliveryMode", () => {
  it("is on only for INKBOX_DELIVERY_MODE=local", () => {
    expect(localDeliveryMode({ INKBOX_DELIVERY_MODE: "local" })).toBe(true);
    expect(localDeliveryMode({ INKBOX_DELIVERY_MODE: " LOCAL " })).toBe(true);
    expect(localDeliveryMode({ INKBOX_DELIVERY_MODE: "tunnel" })).toBe(false);
    expect(localDeliveryMode({})).toBe(false);
  });
});

describe("inbound.received routing", () => {
  it("delivers to onInboundEvent in local mode", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "local");
    const onInboundEvent = vi.fn();
    const onExternal = vi.fn();
    const result = await dispatchInbound(inboundEvent(), { onInboundEvent, onExternal });
    expect(result.kind).toBe("inbound");
    expect(onInboundEvent).toHaveBeenCalledTimes(1);
    expect(onExternal).not.toHaveBeenCalled();
  });

  it("ignores the event outside local mode", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "");
    const onInboundEvent = vi.fn();
    const onExternal = vi.fn();
    const result = await dispatchInbound(inboundEvent(), { onInboundEvent, onExternal });
    expect(result.kind).toBe("inbound");
    expect(onInboundEvent).not.toHaveBeenCalled();
    expect(onExternal).not.toHaveBeenCalled();
  });

  it("acks with 2xx and dedupes retries by delivery id", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "local");
    const onInboundEvent = vi.fn();
    const dedup = new RequestIdDedup(100);
    const body = JSON.stringify(inboundEvent());
    const headers = (id: string) => ({ "x-inkbox-request-id": id, "x-inkbox-signature": "s", "x-inkbox-timestamp": "1" });
    const first = await handleInkboxWebhook(body, headers("req-1"), { signingKey: "k", handlers: { onInboundEvent }, dedup });
    const second = await handleInkboxWebhook(body, headers("req-2"), { signingKey: "k", handlers: { onInboundEvent }, dedup });
    expect(first.status).toBe(200);
    expect(second).toEqual({ status: 200, body: "dup" });
    expect(onInboundEvent).toHaveBeenCalledTimes(1);
    const replay = inboundEvent(undefined, { delivery_id: "inbdlv_2" });
    expect(await handleInkboxWebhook(JSON.stringify(replay), headers("req-3"), { signingKey: "k", handlers: { onInboundEvent }, dedup }))
      .toEqual({ status: 200, body: "ok" });
    expect(onInboundEvent).toHaveBeenCalledTimes(2);
  });

  it("acks with 2xx outside local mode without waking the agent", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "");
    const onInboundEvent = vi.fn();
    const out = await handleInkboxWebhook(JSON.stringify(inboundEvent()),
      { "x-inkbox-request-id": "r", "x-inkbox-signature": "s", "x-inkbox-timestamp": "1" },
      { signingKey: "k", handlers: { onInboundEvent } });
    expect(out.status).toBe(200);
    expect(onInboundEvent).not.toHaveBeenCalled();
  });
});

describe("buildInboundMessage", () => {
  const data = inboundEvent().data as unknown as InboundEventData;

  it("marks the content untrusted, then instructions, then the body", () => {
    const message = buildInboundMessage(data, '{"paid":true}', "utf8");
    const header = message.indexOf("UNTRUSTED EXTERNAL CONTENT from inbound source \"payments\"");
    const instructions = message.indexOf("Record paid invoices.");
    const body = message.indexOf('{"paid":true}');
    expect(header).toBeGreaterThan(-1);
    expect(instructions).toBeGreaterThan(header);
    expect(body).toBeGreaterThan(instructions);
  });

  it("caps the body at 64 KiB on a character boundary", () => {
    const body = "a".repeat(AGENT_BODY_MAX_BYTES - 1) + "é" + "tail";
    const message = buildInboundMessage(data, body, "utf8");
    expect(message.endsWith(`${"a".repeat(AGENT_BODY_MAX_BYTES - 1)}\n(truncated)`)).toBe(true);
    expect(message).not.toContain("\uFFFD");
    expect(buildInboundMessage(data, "a".repeat(AGENT_BODY_MAX_BYTES), "utf8")).not.toContain("(truncated)");
  });

  it("notes a binary body instead of including it", () => {
    const message = buildInboundMessage({ ...data, source: { ...data.source, instructions: null } },
      Buffer.from([0, 1, 2]).toString("base64"), "base64");
    expect(message).toContain("(binary body, 3 bytes, not shown)");
    expect(message).not.toContain("Instructions for this source");
  });
});

describe("createInboundEventHandler", () => {
  function deps(scriptResults: Array<{ ok: boolean; stdout?: string; error?: string }> = []) {
    const results = [...scriptResults];
    return {
      runTurn: vi.fn(async () => {}),
      reportFailure: vi.fn(async () => {}),
      runScript: vi.fn(async () => {
        const next = results.shift() ?? { ok: true };
        return { ok: next.ok, stdout: next.stdout ?? "", error: next.error ?? "" };
      }),
      sleep: vi.fn(async () => {}),
    };
  }

  it("runs one agent turn keyed by source and dedupes on delivery id", async () => {
    const d = deps();
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent());
    await handler.handle(inboundEvent());
    await settle(handler);
    expect(d.runTurn).toHaveBeenCalledTimes(1);
    expect(d.runTurn).toHaveBeenCalledWith(expect.objectContaining({ source: "payments", eventId: "inbev_1" }));
    expect((d.runTurn.mock.calls[0] as any)[0].message).toContain('{"paid":true}');
  });

  it("runs a replay of the same event again", async () => {
    const d = deps();
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent());
    await handler.handle(inboundEvent(undefined, { delivery_id: "inbdlv_2" }));
    await settle(handler);
    await settle(handler, "inbdlv_2");
    expect(d.runTurn).toHaveBeenCalledTimes(2);
  });

  it("falls back to the event id without a delivery id", async () => {
    const d = deps();
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent(undefined, { delivery_id: undefined }));
    await handler.handle(inboundEvent(undefined, { delivery_id: undefined }));
    await settle(handler, "inbev_1");
    expect(d.runTurn).toHaveBeenCalledTimes(1);
  });

  it("reports pending while the handler runs", async () => {
    let release!: () => void;
    const d = deps();
    d.runTurn.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const handler = createInboundEventHandler(d);
    expect(handler.state("inbdlv_1")).toBe("absent");
    await handler.handle(inboundEvent());
    expect(handler.state("inbdlv_1")).toBe("pending");
    await vi.waitFor(() => expect(release).toBeDefined());
    release();
    await settle(handler);
  });

  it("passes the request to the script on stdin", async () => {
    const d = deps([{ ok: true }]);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "handle-payment" }));
    await settle(handler);
    const [command, input] = d.runScript.mock.calls[0] as unknown as [string, string];
    expect(command).toBe("handle-payment");
    expect(JSON.parse(input)).toEqual({
      source: "payments",
      event_id: "inbev_1",
      headers: { "content-type": "application/json" },
      body: '{"paid":true}',
      body_encoding: "utf8",
    });
  });

  it("finishes without an agent turn when the script prints nothing", async () => {
    const d = deps([{ ok: true, stdout: "  \n" }]);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "true" }));
    await settle(handler);
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it("caps script output in the agent message but passes the full body on stdin", async () => {
    const big = "b".repeat(AGENT_BODY_MAX_BYTES + 10);
    const d = deps([{ ok: true, stdout: big }]);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }, { request: { body: big, body_encoding: "utf8" } }));
    await settle(handler);
    expect(JSON.parse((d.runScript.mock.calls[0] as any)[1]).body).toBe(big);
    const message = (d.runTurn.mock.calls[0] as any)[0].message as string;
    expect(message.endsWith(`${"b".repeat(AGENT_BODY_MAX_BYTES)}\n(truncated)`)).toBe(true);
  });

  it("wakes the agent with the script output", async () => {
    const d = deps([{ ok: true, stdout: "Invoice 42 needs review" }]);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }));
    await settle(handler);
    const turn = (d.runTurn.mock.calls[0] as any)[0];
    expect(turn.message).toContain("Invoice 42 needs review");
    expect(turn.message).not.toContain('{"paid":true}');
  });

  it("runs a failing script 5 times with backoff and then reports failure", async () => {
    vi.useFakeTimers();
    try {
      const failures = Array.from({ length: 6 }, () => ({ ok: false, error: "boom" }));
      const { sleep: _sleep, ...rest } = deps(failures);
      const d = { ...rest, sleep: undefined };
      const handler = createInboundEventHandler(d);
      await handler.handle(inboundEvent({ type: "script", command: "false" }));
      for (const [index, delay] of [10_000, 30_000, 120_000, 600_000].entries()) {
        await vi.advanceTimersByTimeAsync(delay - 1);
        expect(d.runScript).toHaveBeenCalledTimes(index + 1);
        await vi.advanceTimersByTimeAsync(1);
      }
      await vi.advanceTimersByTimeAsync(3_600_000);
      expect(d.runScript).toHaveBeenCalledTimes(5);
      expect(d.reportFailure).toHaveBeenCalledTimes(1);
      expect(d.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ event_id: "inbev_1" }), "boom");
      expect(d.runTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the retry schedule 10 s, 30 s, 2 min, 10 min", async () => {
    const failures = Array.from({ length: 6 }, () => ({ ok: false, error: "boom" }));
    const d = deps(failures);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "false" }));
    await settle(handler);
    expect(d.runScript).toHaveBeenCalledTimes(5);
    expect(d.sleep.mock.calls.map((call: any) => call[0])).toEqual(SCRIPT_RETRY_DELAYS_MS);
    expect(SCRIPT_RETRY_DELAYS_MS).toEqual([10_000, 30_000, 120_000, 600_000]);
    expect(d.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ event_id: "inbev_1" }), "boom");
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("stops retrying once the script succeeds", async () => {
    const d = deps([{ ok: false, error: "boom" }, { ok: true, stdout: "done" }]);
    const handler = createInboundEventHandler(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }));
    await settle(handler);
    expect(d.runScript).toHaveBeenCalledTimes(2);
    expect(d.sleep).toHaveBeenCalledTimes(1);
    expect(d.reportFailure).not.toHaveBeenCalled();
    expect(d.runTurn).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed events", async () => {
    const d = deps();
    const handler = createInboundEventHandler(d);
    await handler.handle({ event_type: "inbound.received", data: { source: { name: "x" } } });
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(d.runScript).not.toHaveBeenCalled();
  });
});

describe("runInboundScript", () => {
  it("runs in the home directory with stdin and captures stdout", async () => {
    const result = await runInboundScript("pwd; cat", "hello");
    expect(result).toEqual({ ok: true, stdout: `${homedir()}\nhello`, error: "" });
  });

  it("reports the stderr tail on a non-zero exit", async () => {
    const result = await runInboundScript("echo bad input >&2; exit 3", "");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("bad input");
  });

  it("reports the exit code when stderr is empty", async () => {
    const result = await runInboundScript("exit 4", "");
    expect(result).toMatchObject({ ok: false, error: "exit code 4" });
  });

  it("kills the script and its children on timeout", async () => {
    const result = await runInboundScript("sleep 30 & sleep 30", "", 200);
    expect(result).toMatchObject({ ok: false, error: "timed out after 0 s" });
  });
});
