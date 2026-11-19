import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_BODY_MAX_BYTES,
  SCRIPT_RETRY_DELAYS_MS,
  SCRIPT_STDERR_MAX_BYTES,
  SCRIPT_STDOUT_MAX_BYTES,
  buildInboundMessage,
  createInboundEventHandler,
  localDeliveryMode,
  runInboundScript,
  type InboundEventData,
} from "../../src/inbound/inbound-events.js";
import { dispatchInbound } from "../../src/inbound/dispatch.js";
import { handleInkboxWebhook } from "../../src/inbound/handler.js";
import { RequestIdDedup } from "../../src/inbound/dedup.js";

const SIGNING_KEY = "test-signing-key";
const DELIVERY_ID = "2b0c3f4e-8a51-4f3e-9d0a-5c1e7b6a9f10";

// The envelope the server signs and delivers to a hosted agent.
function inboundEvent(handler: Record<string, unknown> = { type: "agent" }, overrides: Record<string, unknown> = {}) {
  const deliveryId = (overrides.delivery_id as string | undefined) ?? DELIVERY_ID;
  const id = `evt_${createHmac("sha256", "id").update(deliveryId).digest("hex")}`;
  return {
    event_type: "inbound.received",
    timestamp: "2026-11-19T00:00:00+00:00",
    data: {
      event_id: "inbev_6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      delivery_id: DELIVERY_ID,
      received_at: "2026-11-19T00:00:00+00:00",
      source: { id: "inbsrc_0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", name: "payments", instructions: "Record paid invoices." },
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
    id,
    hosted_delivery: { version: 1, activation_id: "7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a", event_id: id, starts_agent: true },
  };
}

function signed(event: Record<string, any>, key = SIGNING_KEY) {
  const body = JSON.stringify(event);
  const timestamp = "1795046400";
  const signature = createHmac("sha256", key).update(`${event.id}.${timestamp}.${body}`).digest("hex");
  return {
    body,
    headers: { "content-type": "application/json", "x-inkbox-request-id": event.id, "x-inkbox-timestamp": timestamp, "x-inkbox-signature": `sha256=${signature}` },
  };
}

async function until(condition: () => boolean | Promise<boolean>, label = "condition") {
  // hrtime and setImmediate stay real under the fake timers some tests use.
  const deadline = process.hrtime.bigint() + 10_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let dir: string;
const handlers: Array<ReturnType<typeof createInboundEventHandler>> = [];

async function storedJobs(): Promise<any[]> {
  const files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  return Promise.all(files.map(async (name) => JSON.parse(await readFile(join(dir, name), "utf8"))));
}

async function allDone(): Promise<boolean> {
  return (await storedJobs()).every((job) => job.stage === "done");
}

function deps(overrides: Record<string, any> = {}) {
  return {
    dir,
    runTurn: vi.fn(async (_turn: any) => {}),
    reportFailure: vi.fn(async (_data: InboundEventData, _error: string) => {}),
    runScript: vi.fn(async (_command: string, _input: string) => ({ ok: true, stdout: "", error: "" })),
    ...overrides,
  };
}

function create(d: ReturnType<typeof deps>) {
  const handler = createInboundEventHandler(d);
  handlers.push(handler);
  return handler;
}

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "inkbox-inbound-")), "queue");
});

afterEach(async () => {
  for (const handler of handlers.splice(0)) handler.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await rm(join(dir, ".."), { recursive: true, force: true });
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
    expect(onInboundEvent).toHaveBeenCalledWith(expect.objectContaining({ hosted_delivery: expect.any(Object) }));
    expect(onExternal).not.toHaveBeenCalled();
  });

  it("ignores the event outside local mode", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "");
    const onInboundEvent = vi.fn();
    const result = await dispatchInbound(inboundEvent(), { onInboundEvent, onExternal: vi.fn() });
    expect(result.kind).toBe("inbound");
    expect(onInboundEvent).not.toHaveBeenCalled();
  });

  it("acks a signed delivery and dedupes retries on delivery_id", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "local");
    const onInboundEvent = vi.fn();
    const dedup = new RequestIdDedup(100);
    const event = inboundEvent();
    const first = signed(event);
    expect(await handleInkboxWebhook(first.body, first.headers, { signingKey: SIGNING_KEY, handlers: { onInboundEvent }, dedup }))
      .toEqual({ status: 200, body: "ok" });
    const retry = signed({ ...event, timestamp: "2026-11-19T00:01:00+00:00" });
    expect(await handleInkboxWebhook(retry.body, retry.headers, { signingKey: SIGNING_KEY, handlers: { onInboundEvent }, dedup }))
      .toEqual({ status: 200, body: "dup" });
    const replay = signed(inboundEvent(undefined, { delivery_id: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" }));
    expect(await handleInkboxWebhook(replay.body, replay.headers, { signingKey: SIGNING_KEY, handlers: { onInboundEvent }, dedup }))
      .toEqual({ status: 200, body: "ok" });
    expect(onInboundEvent).toHaveBeenCalledTimes(2);
  });

  it("requires a verified Inkbox signature", async () => {
    vi.stubEnv("INKBOX_DELIVERY_MODE", "local");
    const onInboundEvent = vi.fn();
    const onExternal = vi.fn();
    const event = inboundEvent();
    const options = { signingKey: SIGNING_KEY, externalEvents: true, handlers: { onInboundEvent, onExternal } };
    expect((await handleInkboxWebhook(JSON.stringify(event), {}, options)).status).toBe(401);
    const forged = signed(event, "other-key");
    expect((await handleInkboxWebhook(forged.body, forged.headers, options)).status).toBe(403);
    const unkeyed = signed(event, "");
    expect((await handleInkboxWebhook(unkeyed.body, unkeyed.headers, { ...options, signingKey: "" })).status).toBe(401);
    expect(onInboundEvent).not.toHaveBeenCalled();
    expect(onExternal).not.toHaveBeenCalled();
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
    expect(message).not.toContain("�");
    expect(buildInboundMessage(data, "a".repeat(AGENT_BODY_MAX_BYTES), "utf8")).not.toContain("(truncated)");
  });

  it("notes a binary body instead of including it", () => {
    const message = buildInboundMessage({ ...data, source: { ...data.source, instructions: null } },
      Buffer.from([0xff, 0xfe, 0]).toString("base64"), "base64");
    expect(message).toContain("(binary body, 3 bytes, not shown)");
    expect(message).not.toContain("Instructions for this source");
  });

  it("shows a base64 body that decodes to UTF-8 as text", () => {
    const message = buildInboundMessage(data, Buffer.from('{"note":"café"}').toString("base64"), "base64");
    expect(message).toContain('{"note":"café"}');
    expect(message).not.toContain("binary body");
  });
});

describe("createInboundEventHandler", () => {
  it("persists the delivery before acknowledging and completes it while the turn still runs", async () => {
    let release!: () => void;
    const d = deps({ runTurn: vi.fn(() => new Promise<void>((resolve) => { release = resolve; })) });
    const handler = create(d);
    expect(await handler.state(DELIVERY_ID)).toBe("absent");
    await handler.handle(inboundEvent());
    expect(await storedJobs()).toEqual([expect.objectContaining({ key: DELIVERY_ID, stage: "turn" })]);
    expect(await handler.state(DELIVERY_ID)).toBe("completed");
    await until(() => d.runTurn.mock.calls.length === 1, "turn");
    expect(handler.activity()).toBe(1);
    release();
    await until(() => handler.activity() === 0, "idle");
    expect(await storedJobs()).toEqual([expect.objectContaining({ key: DELIVERY_ID, stage: "done" })]);
    expect((await storedJobs())[0].data).toBeUndefined();
  });

  it("runs one agent turn per delivery and again for a replay", async () => {
    const d = deps();
    const handler = create(d);
    await handler.handle(inboundEvent());
    await handler.handle(inboundEvent());
    await handler.handle(inboundEvent(undefined, { delivery_id: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" }));
    await until(() => d.runTurn.mock.calls.length === 2 && handler.activity() === 0, "turns");
    expect(d.runTurn.mock.calls[0][0]).toEqual(expect.objectContaining({ source: "payments", eventId: "inbev_6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b" }));
    expect(d.runTurn.mock.calls[0][0].message).toContain('{"paid":true}');
    await handler.handle(inboundEvent());
    expect(d.runTurn).toHaveBeenCalledTimes(2);
  });

  it("dedupes on delivery_id across a restart", async () => {
    const d = deps();
    const first = create(d);
    await first.handle(inboundEvent());
    await until(() => first.activity() === 0, "idle");
    first.close();
    const second = create(d);
    await second.handle(inboundEvent());
    expect(await second.state(DELIVERY_ID)).toBe("completed");
    expect(d.runTurn).toHaveBeenCalledTimes(1);
  });

  it("runs queued work outside the delivery's async context", async () => {
    const scope = new AsyncLocalStorage<string>();
    let seen: string | undefined = "unset";
    const d = deps({ runTurn: vi.fn(async () => { seen = scope.getStore(); }) });
    const handler = create(d);
    await scope.run("delivery", () => handler.handle(inboundEvent()));
    await until(() => d.runTurn.mock.calls.length === 1 && handler.activity() === 0, "turn");
    expect(seen).toBeUndefined();
  });

  it("reports a failed agent turn with the delivery id", async () => {
    const d = deps({ runTurn: vi.fn(async () => { throw new Error("model unavailable"); }) });
    const handler = create(d);
    await handler.handle(inboundEvent());
    await until(allDone, "idle");
    expect(d.runTurn).toHaveBeenCalledTimes(1);
    expect(d.reportFailure).toHaveBeenCalledTimes(1);
    const [data, error] = d.reportFailure.mock.calls[0];
    expect(data.delivery_id).toBe(DELIVERY_ID);
    expect(error).toBe("agent turn failed: model unavailable");
  });

  it("passes the request to the script on stdin", async () => {
    const d = deps();
    const handler = create(d);
    await handler.handle(inboundEvent({ type: "script", command: "handle-payment" }));
    await until(() => handler.activity() === 0, "idle");
    const [command, input] = d.runScript.mock.calls[0];
    expect(command).toBe("handle-payment");
    expect(JSON.parse(input)).toEqual({
      source: "payments",
      event_id: "inbev_6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b",
      headers: { "content-type": "application/json" },
      body: '{"paid":true}',
      body_encoding: "utf8",
    });
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(d.reportFailure).not.toHaveBeenCalled();
  });

  it("passes the full body on stdin and caps the script output in the agent message", async () => {
    const big = "b".repeat(AGENT_BODY_MAX_BYTES + 10);
    const d = deps({ runScript: vi.fn(async () => ({ ok: true, stdout: big, error: "" })) });
    const handler = create(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }, { request: { body: big, body_encoding: "utf8" } }));
    await until(() => handler.activity() === 0, "idle");
    expect(JSON.parse(d.runScript.mock.calls[0][1]).body).toBe(big);
    const message = d.runTurn.mock.calls[0][0].message as string;
    expect(message.endsWith(`${"b".repeat(AGENT_BODY_MAX_BYTES)}\n(truncated)`)).toBe(true);
  });

  it("retries a failing script after 10 s, 30 s, 2 min and 10 min, then reports it once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const d = deps({ runScript: vi.fn(async () => ({ ok: false, stdout: "", error: "boom" })) });
    const handler = create(d);
    await handler.handle(inboundEvent({ type: "script", command: "false" }));
    for (const [index, delay] of SCRIPT_RETRY_DELAYS_MS.entries()) {
      await until(async () => (await storedJobs())[0]?.attempts === index + 1, `attempt ${index + 1}`);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(d.runScript).toHaveBeenCalledTimes(index + 1);
      expect(handler.activity()).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await until(() => d.reportFailure.mock.calls.length === 1 && handler.activity() === 0, "report");
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(d.runScript).toHaveBeenCalledTimes(5);
    expect(d.reportFailure).toHaveBeenCalledWith(expect.objectContaining({ delivery_id: DELIVERY_ID }), "boom");
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("resumes a script retry after a restart without starting over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const failing = vi.fn(async () => ({ ok: false, stdout: "", error: "boom" }));
    const first = create(deps({ runScript: failing }));
    await first.handle(inboundEvent({ type: "script", command: "false" }));
    await until(async () => (await storedJobs())[0]?.attempts === 1, "first run");
    first.close();
    const d = deps({ runScript: failing });
    const second = create(d);
    await second.ready;
    expect(second.activity()).toBe(1);
    for (const [index, delay] of SCRIPT_RETRY_DELAYS_MS.entries()) {
      await until(async () => (await storedJobs())[0]?.attempts === index + 1, `attempt ${index + 1}`);
      await vi.advanceTimersByTimeAsync(delay);
    }
    await until(allDone, "report");
    expect(failing).toHaveBeenCalledTimes(5);
    expect(d.reportFailure).toHaveBeenCalledTimes(1);
  });

  it("retries a failed report with backoff without re-running the script and treats 409 as done", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const reportFailure = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 503"), { statusCode: 503 }))
      .mockRejectedValueOnce(Object.assign(new Error("HTTP 409: stale_delivery"), { statusCode: 409 }));
    const runScript = vi.fn(async () => ({ ok: false, stdout: "", error: "boom" }));
    const handler = create(deps({ runScript, reportFailure }));
    await handler.handle(inboundEvent({ type: "script", command: "false" }));
    for (const delay of SCRIPT_RETRY_DELAYS_MS) {
      await until(async () => (await storedJobs())[0].dueAt > Date.now(), "backoff");
      await vi.advanceTimersByTimeAsync(delay);
    }
    await until(() => reportFailure.mock.calls.length === 1, "first report");
    await until(async () => (await storedJobs())[0].attempts === 1 && (await storedJobs())[0].stage === "report", "report backoff");
    // A pending failure report does not keep the runtime awake.
    expect(handler.activity()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await until(allDone, "done");
    expect(reportFailure).toHaveBeenCalledTimes(2);
    expect(runScript).toHaveBeenCalledTimes(5);
  });

  it("stops retrying once the script succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const runScript = vi.fn()
      .mockResolvedValueOnce({ ok: false, stdout: "", error: "boom" })
      .mockResolvedValueOnce({ ok: true, stdout: "Invoice 42 needs review", error: "" });
    const d = deps({ runScript });
    const handler = create(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }));
    await until(async () => (await storedJobs())[0]?.attempts === 1, "first run");
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => handler.activity() === 0, "idle");
    expect(runScript).toHaveBeenCalledTimes(2);
    expect(d.reportFailure).not.toHaveBeenCalled();
    expect(d.runTurn.mock.calls[0][0].message).toContain("Invoice 42 needs review");
    expect(d.runTurn.mock.calls[0][0].message).not.toContain('{"paid":true}');
  });

  it("reports an agent turn interrupted by a restart instead of repeating it", async () => {
    const first = create(deps({ runTurn: vi.fn(() => new Promise<void>(() => {})) }));
    await first.handle(inboundEvent());
    await until(async () => (await storedJobs())[0]?.started === true, "turn started");
    first.close();
    const d = deps();
    create(d);
    await until(() => d.reportFailure.mock.calls.length === 1, "report");
    expect(d.runTurn).not.toHaveBeenCalled();
    expect(d.reportFailure.mock.calls[0][1]).toBe("agent turn was interrupted by a restart");
  });

  it("reports a failed turn on script output without re-running the script", async () => {
    const runScript = vi.fn(async () => ({ ok: true, stdout: "summary", error: "" }));
    const d = deps({ runScript, runTurn: vi.fn(async () => { throw new Error("model unavailable"); }) });
    const handler = create(d);
    await handler.handle(inboundEvent({ type: "script", command: "x" }));
    await until(allDone, "done");
    expect(runScript).toHaveBeenCalledTimes(1);
    expect(d.runTurn).toHaveBeenCalledTimes(1);
    expect(d.reportFailure).toHaveBeenCalledTimes(1);
  });

  it.each([
    [200, false], [409, false], [400, false], [404, false], [408, true], [429, true], [500, true], [undefined, true],
  ])("treats a report response of %s as retry=%s", async (status, retried) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const reportFailure = status === 200
      ? vi.fn(async () => {})
      : vi.fn(async () => { throw Object.assign(new Error(`HTTP ${status ?? "network"}`), status ? { statusCode: status } : {}); });
    const handler = create(deps({ reportFailure, runTurn: vi.fn(async () => { throw new Error("boom"); }) }));
    await handler.handle(inboundEvent());
    await until(() => reportFailure.mock.calls.length === 1, "first report");
    await until(async () => (await storedJobs())[0].stage === (retried ? "report" : "done") &&
      (!retried || (await storedJobs())[0].attempts === 1), "settled");
    await vi.advanceTimersByTimeAsync(30_000);
    await until(() => reportFailure.mock.calls.length === (retried ? 2 : 1), "retry");
    expect(handler.activity()).toBe(0);
  });

  it("counts a script run before it starts and never runs a sixth time after a restart", async () => {
    const seen: number[] = [];
    const runScript = vi.fn(async () => {
      seen.push((await storedJobs())[0].attempts);
      return new Promise<never>(() => {});
    });
    const first = create(deps({ runScript }));
    await first.handle(inboundEvent({ type: "script", command: "x" }));
    await until(() => seen.length === 1, "first run");
    expect(seen).toEqual([1]);
    const [stored] = await storedJobs();
    const { writeFile } = await import("node:fs/promises");
    const [name] = (await readdir(dir)).filter((file) => file.endsWith(".json"));
    // Five runs have started; the fifth was cut off by a restart.
    await writeFile(join(dir, name), JSON.stringify({ ...stored, attempts: 5, dueAt: 0 }));
    const d = deps();
    create(d);
    await until(() => d.reportFailure.mock.calls.length === 1, "report");
    expect(d.runScript).not.toHaveBeenCalled();
    expect(d.reportFailure.mock.calls[0][1]).toBe("script run was interrupted by a restart");
  });

  it("keeps retrying a failure report past 24 hours until it is accepted", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const reportFailure = vi.fn(async () => { throw Object.assign(new Error("HTTP 503"), { statusCode: 503 }); });
    const handler = create(deps({ reportFailure, runTurn: vi.fn(async () => { throw new Error("boom"); }) }));
    await handler.handle(inboundEvent());
    await until(() => reportFailure.mock.calls.length === 1, "first report");
    for (let hour = 0; hour < 30; hour++) {
      await until(async () => (await storedJobs())[0].dueAt > Date.now(), "backoff");
      await vi.advanceTimersByTimeAsync(3_600_000);
    }
    await until(async () => (await storedJobs())[0].dueAt > Date.now(), "backoff");
    expect((await storedJobs())[0].stage).toBe("report");
    expect(reportFailure.mock.calls.length).toBeGreaterThan(20);
    reportFailure.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await until(allDone, "done");
  });

  it("caps the reported error at 2000 characters", async () => {
    const d = deps({ runTurn: vi.fn(async () => { throw new Error(`${"e".repeat(5_000)}END`); }) });
    const handler = create(d);
    await handler.handle(inboundEvent());
    await until(allDone, "done");
    const error = d.reportFailure.mock.calls[0][1];
    expect(error).toHaveLength(2000);
    expect(error.endsWith("END")).toBe(true);
  });

  it("close kills a running script, aborts a running turn, and refuses new deliveries", async () => {
    let turnSignal: AbortSignal | undefined;
    const runTurn = vi.fn((_turn: any, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      turnSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const handler = create(deps({ runScript: undefined, runTurn }));
    await handler.handle(inboundEvent({ type: "script", command: "sleep 30" }));
    await handler.handle(inboundEvent(undefined, { delivery_id: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" }));
    await until(() => runTurn.mock.calls.length === 1, "turn");
    await until(async () => (await storedJobs()).some((job) => job.stage === "script" && job.attempts === 1), "script");
    const started = Date.now();
    await handler.close();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(turnSignal?.aborted).toBe(true);
    await expect(handler.handle(inboundEvent(undefined, { delivery_id: "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d" }))).rejects.toThrow();
    // The interrupted work stays queued for the next start: the script is retried, the turn reported.
    const jobs = await storedJobs();
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "script", attempts: 1 }),
      expect.objectContaining({ stage: "turn", started: true }),
    ]));
  });

  it("ignores events without a delivery_id", async () => {
    const d = deps();
    const handler = create(d);
    await handler.handle(inboundEvent(undefined, { delivery_id: undefined }));
    expect(await storedJobs()).toEqual([]);
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("rejects the delivery when it cannot be stored", async () => {
    const d = deps({ dir: "/dev/null/inbound" });
    const handler = create(d);
    await expect(handler.handle(inboundEvent())).rejects.toThrow();
    expect(await handler.state(DELIVERY_ID)).toBe("absent");
  });
});

describe("runInboundScript", () => {
  it("runs in the home directory with stdin and captures stdout", async () => {
    const result = await runInboundScript("pwd; cat", "hello");
    expect(result).toEqual({ ok: true, stdout: `${homedir()}\nhello`, error: "" });
  });

  it("reports the stderr tail on a non-zero exit", async () => {
    const result = await runInboundScript("echo bad input >&2; exit 3", "");
    expect(result).toEqual({ ok: false, stdout: "", error: "bad input" });
  });

  it("reports the exit code when stderr is empty", async () => {
    expect(await runInboundScript("exit 4", "")).toMatchObject({ ok: false, error: "exit code 4" });
  });

  it("drains large output and keeps 64 KiB of stdout and a 4 KiB stderr tail", async () => {
    const result = await runInboundScript(
      "head -c 3000000 /dev/zero | tr '\\0' a; head -c 3000000 /dev/zero | tr '\\0' e >&2; echo END >&2; exit 1", "", undefined, 20_000);
    expect(result.ok).toBe(false);
    expect(result.stdout).toBe(`${"a".repeat(SCRIPT_STDOUT_MAX_BYTES)}\n(truncated)`);
    expect(Buffer.byteLength(result.error)).toBeLessThanOrEqual(SCRIPT_STDERR_MAX_BYTES);
    expect(result.error.endsWith("END")).toBe(true);
  });

  it("kills the script and its children on timeout", async () => {
    expect(await runInboundScript("sleep 30 & sleep 30", "", undefined, 200)).toMatchObject({ ok: false, error: "timed out after 0 s" });
  });

  it("keeps exactly 64 KiB of stdout without a marker", async () => {
    const result = await runInboundScript(`head -c ${SCRIPT_STDOUT_MAX_BYTES} /dev/zero | tr '\\0' a`, "");
    expect(result.stdout).toBe("a".repeat(SCRIPT_STDOUT_MAX_BYTES));
  });

  it("kills the script when the signal aborts", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const run = runInboundScript("sleep 30 & sleep 30", "", abort.signal);
    setTimeout(() => abort.abort(), 50);
    expect((await run).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
