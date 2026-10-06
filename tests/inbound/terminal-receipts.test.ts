import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const state = vi.hoisted(() => ({ dir: "", fault: "", indexed: false, hotSizes: [] as number[] }));
vi.mock("../../src/state.js", async () => ({ statePaths: () => ({ dir: state.dir }), ensureStateDir: async () => (await import("node:fs/promises")).mkdir(state.dir, { recursive: true }) }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: any, to: any) => {
    const target = String(to);
    if (target.includes("/sources/")) state.indexed = true;
    if ((state.fault === "receipt" && target.includes("/events/")) || (state.fault === "index" && target.includes("/sources/")) || (state.fault === "hot" && state.indexed && /companion-[a-f0-9]+\.json$/.test(target))) { state.fault = ""; throw new Error("synthetic interrupted durable write"); }
    if (/companion-[a-f0-9]+\.json$/.test(target)) state.hotSizes.push(Object.keys(JSON.parse(await fs.readFile(from, "utf8")).jobs).length);
    return fs.rename(from, to);
  }, open: async (...args: Parameters<typeof fs.open>) => {
    const file = await fs.open(...args), sync = file.sync.bind(file);
    file.sync = async () => { if (state.fault === "directory" && String(args[0]).endsWith(".receipts")) { state.fault = ""; throw new Error("synthetic interrupted directory sync"); } return sync(); };
    return file;
  } };
});
import { createCompanionReceiver } from "../../src/inbound/companion.js";
const identityId = "11111111-1111-4111-8111-111111111111";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const queues: ReturnType<typeof createCompanionReceiver>[] = [];
vi.setConfig({ testTimeout: 20_000 });
beforeEach(async () => { state.dir = await mkdtemp(join(tmpdir(), "terminal-receipts-")); state.fault = ""; state.indexed = false; state.hotSizes = []; });
afterEach(async () => { state.fault = ""; for (const queue of queues.splice(0)) { queue.close(); await queue.idle().catch(() => {}); } await rm(state.dir, { recursive: true, force: true }); });
function event(id: string, text = "question") { return { id: `event-${id}`, event_type: "imessage.received", companion: { channel: "imessage", phase: "ordinary", sequence: 1, scope_id: "conversation:main", conversation_id: "conversation" }, data: { message: { id, conversation_id: "conversation", sender_number: "+15555550100", content: text, sender_access: "direct", _ordinaryAddressed: true } }, _openclawNativeIMessage: { burstable: false } }; }
function setup(submit?: any, deliver?: any, config: Record<string, any> = {}) {
  const settings = { identity: "agent", imessageThreadedReplies: true, ...config };
  const model = submit ?? vi.fn(async (input: any) => { await input.validateBeforeDispatch(); return ["answer"]; });
  const send = deliver ?? vi.fn(async (input: any, _text: string, beforeSend: any) => { await beforeSend(); return `out-${input.event.data.message.id}`; });
  const queue = createCompanionReceiver({ accountId: "default", config: settings, runtime: { getIdentity: async () => ({ id: identityId }), getClient: async () => ({}) } as any, submit: model, deliver: send });
  queues.push(queue); return { queue, model, send, settings };
}
async function files() {
  const name = (await readdir(state.dir)).find((value) => /^companion-[a-f0-9]+\.json$/.test(value))!;
  const path = join(state.dir, name), archive = `${path}.receipts`;
  return { path, archive, hot: JSON.parse(await readFile(path, "utf8")) };
}
async function cold(archive: string) { return Promise.all((await readdir(join(archive, "events"))).filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(join(archive, "events", name), "utf8")))); }
async function run(queue: ReturnType<typeof createCompanionReceiver>, incoming: any) { await queue.accept(incoming); await queue.idle(); }

describe("indexed terminal receipt archive", () => {
  it("bounds terminal hot history while arrivals continuously replenish an active drain", async () => {
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.fn(async (input: any) => {
      await input.validateBeforeDispatch();
      const n = Number(input.event.data.message.id);
      if (n < 20) await f.queue.accept(event(String(n + 1)));
      else { entered(); await held; }
      return ["answer"];
    });
    const f = setup(model); await f.queue.accept(event("0")); await started;
    try {
      const { hot, archive } = await files();
      expect(Object.values(hot.jobs)).toHaveLength(1);
      expect(Object.values(hot.jobs)).toContainEqual(expect.objectContaining({ state: "submitting" }));
      expect(await cold(archive)).toHaveLength(20);
      expect(await f.queue.ownsDelivery("out-0")).toBe(true);
    } finally { release(); await f.queue.idle(); }
    expect(model).toHaveBeenCalledTimes(21); expect(f.send).toHaveBeenCalledTimes(21);
    expect(Object.keys((await files()).hot.jobs)).toHaveLength(0);
  });
  it("removes completed ordinary payloads from hot rewrites while retaining exact replay and callback proof across restart", async () => {
    const first = setup();
    for (let n = 0; n < 12; n++) await run(first.queue, event(String(n), "large ordinary input ".repeat(250)));
    const { hot, archive } = await files(); expect(Object.keys(hot.jobs)).toHaveLength(0); expect(await cold(archive)).toHaveLength(12);
    expect((await stat(archive)).mode & 0o777).toBe(0o700);
    const receiptFile = (await readdir(join(archive, "events")))[0]!;
    expect((await stat(join(archive, "events", receiptFile))).mode & 0o777).toBe(0o600);
    first.queue.close(); const second = setup();
    for (let n = 0; n < 12; n++) await run(second.queue, event(String(n)));
    expect(second.model).not.toHaveBeenCalled(); expect(second.send).not.toHaveBeenCalled();
    expect(await second.queue.ownsDelivery("out-3")).toBe(true);
    expect(await second.queue.ownsDelivery("unmatched-proactive", "conversation")).toBe(false);
    second.settings.imessageThreadedReplies = false; await run(second.queue, event("3")); second.settings.imessageThreadedReplies = true;
    await run(second.queue, event("3")); expect(second.model).not.toHaveBeenCalled();
  });
  it("keeps the first completed source canonical across alternate event IDs and rejects changed ancestry", async () => {
    const f = setup(); await run(f.queue, event("source"));
    const { archive } = await files(), indexes = await readdir(join(archive, "sources"));
    const before = await Promise.all(indexes.map((name) => readFile(join(archive, "sources", name), "utf8")));
    await run(f.queue, { ...event("source"), id: "different-event" });
    expect(f.model).toHaveBeenCalledOnce(); expect(f.send).toHaveBeenCalledOnce();
    expect(await Promise.all(indexes.map((name) => readFile(join(archive, "sources", name), "utf8")))).toEqual(before);
    const conflicting = event("source"); conflicting.id = "conflicting-event"; (conflicting.data.message as any).thread_id = "another-thread";
    await expect(f.queue.accept(conflicting)).rejects.toThrow("conflicting sender or native ancestry");
    expect(f.model).toHaveBeenCalledOnce();
  });
  it.each(["receipt", "index", "directory", "hot"])("recovers an interrupted %s commit without losing hot authority or replay proof", async (stage) => {
    const first = setup(); state.fault = stage;
    await first.queue.accept(event("interrupted")); await expect(first.queue.idle()).rejects.toThrow("synthetic interrupted");
    const interrupted = await files(); expect(Object.values(interrupted.hot.jobs)).toContainEqual(expect.objectContaining({ state: "done", outboundIds: ["out-interrupted"] }));
    first.queue.close(); const next = setup(); await next.queue.recover(); await next.queue.idle();
    expect(Object.keys((await files()).hot.jobs)).toHaveLength(0); expect(await next.queue.ownsDelivery("out-interrupted")).toBe(true);
    await run(next.queue, event("interrupted")); expect(next.model).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled();
  });
  it("migrates old terminal JSON in bounded idempotent batches without moving uncertainty", async () => {
    const f = setup(); await f.queue.accept(event("bootstrap")); await f.queue.idle(); const { path } = await files();
    const jobs: Record<string, any> = {};
    for (let n = 0; n < 70; n++) { const incoming = event(`legacy-${n}`); jobs[digest(`${identityId}:${incoming.id}`)] = { identityId, event: incoming, state: "done", nativeComplete: true, outboundIds: [`legacy-out-${n}`] }; }
    for (const status of ["pending", "reply_pending", "paused", "sending", "submitting"]) { const incoming = event(status); jobs[digest(`${identityId}:${incoming.id}`)] = { identityId, event: incoming, state: status, nativeThreaded: true }; }
    const unresolved = event("unresolved-terminal"); jobs[digest(`${identityId}:${unresolved.id}`)] = { identityId, event: unresolved, state: "done", nativeComplete: true, toolSends: { send: {} } };
    await writeFile(path, JSON.stringify({ jobs, activations: {} })); f.queue.close();
    const migrated = setup(undefined, undefined, { imessageThreadedReplies: false }); await migrated.queue.recover(); await migrated.queue.recover();
    const result = await files(); expect(Object.keys(result.hot.jobs)).toHaveLength(6); expect(await cold(result.archive)).toHaveLength(71);
    expect(state.hotSizes).toContain(12); expect(state.hotSizes).toContain(6);
    expect(migrated.model).not.toHaveBeenCalled(); expect(await migrated.queue.ownsDelivery("legacy-out-69")).toBe(true);
  });
  it("preserves captured Stop targets and prevents archived Stop replay from canceling fresh work", async () => {
    const first = setup(); await run(first.queue, event("idle-stop", "/stop")); first.queue.close();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.fn(async (input: any) => { await input.validateBeforeDispatch(); entered(); await held; return ["fresh"]; });
    const next = setup(model); await next.queue.accept(event("fresh")); await started;
    await next.queue.accept(event("idle-stop", "/stop"));
    await next.queue.accept({ ...event("idle-stop", "/stop"), id: "redelivered-stop" });
    release(); await next.queue.idle();
    expect(next.send).toHaveBeenCalledOnce(); expect(next.model).toHaveBeenCalledOnce();
    expect((await cold((await files()).archive)).find((record) => record.job.event.id === "event-idle-stop").job.stopTargets).toEqual([]);
  });
  it("retains SDK acceptance arriving during shutdown and permits only exact cold callback no-ops", async () => {
    let entered!: () => void, release!: () => void, captured: any;
    const started = new Promise<void>((resolve) => { entered = resolve; }), held = new Promise<void>((resolve) => { release = resolve; });
    const model = vi.fn(async (input: any) => { captured = input; await input.validateBeforeDispatch(); await input.beforeToolSend("tool"); entered(); await held; await input.afterToolSend("tool", "accepted", "answer"); return ["answer"]; });
    const first = setup(model); await first.queue.accept(event("late-accept")); await started; first.queue.close(); release(); await first.queue.idle();
    expect(Object.values((await files()).hot.jobs)).toContainEqual(expect.objectContaining({ state: "reply_pending", outboundIds: ["accepted"] }));
    const next = setup(); await next.queue.recover(); expect(next.model).not.toHaveBeenCalled(); expect(next.send).not.toHaveBeenCalled(); expect(await next.queue.ownsDelivery("accepted")).toBe(true);
    await captured.nativeTerminal(); await captured.afterToolSend("tool", "accepted", "answer");
    await expect(captured.afterToolSend("tool", "different-accepted", "answer")).rejects.toThrow("cannot be changed");
    await expect(captured.beforeToolSend("new-tool")).rejects.toThrow("no longer active");
    expect(Object.keys((await files()).hot.jobs)).toHaveLength(0);
  });
  it.each(["malformed", "foreign"])("fails closed on %s source indexes without repeating the model", async (mode) => {
    const f = setup(); await run(f.queue, event("indexed")); const { archive } = await files();
    if (mode === "foreign") await run(f.queue, event("unrelated"));
    const count = f.model.mock.calls.length;
    const indexes = await readdir(join(archive, "sources"));
    for (const name of indexes) {
      const path = join(archive, "sources", name), index = JSON.parse(await readFile(path, "utf8"));
      if (JSON.parse(index.key)[2] !== "indexed") continue;
      await writeFile(path, mode === "malformed" ? "{invalid" : JSON.stringify({ ...index, receipt: digest(`${identityId}:event-unrelated`) }));
    }
    await expect(f.queue.accept({ ...event("indexed"), id: "new-event" })).rejects.toThrow(mode === "malformed" ? "unreadable" : "does not match");
    expect(f.model).toHaveBeenCalledTimes(count); expect(f.send).toHaveBeenCalledTimes(count);
  });
});
