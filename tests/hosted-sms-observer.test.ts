import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createObserver, safeRecord, startPreload } from "./live/hosted_sms_sdk_observer.mjs";

const target = "+15550000002", marker = "maple cloud river";
function observer(readTarget = () => target, emitOverride?: (row: any) => void) {
  const records: any[] = [];
  return { records, observer: createObserver({ marker, readTarget, emit: emitOverride ?? ((row: any) => records.push(row)) }) };
}

describe("CI-only SDK observer", () => {
  it("returns the identical original Promise and accepted object with same receiver/args", async () => {
    const value = { id: "private-id", text: "private-result" };
    const pending = Promise.resolve(value);
    let receiver: unknown, args: unknown[];
    class Identity { sendText(...input: unknown[]) { receiver = this; args = input; return pending; } }
    const { observer: watch, records } = observer();
    watch.attach(Identity);
    const instance = new Identity(), options = { to: target, text: marker };
    expect(instance.sendText(options)).toBe(pending);
    expect(await pending).toBe(value);
    expect(receiver).toBe(instance); expect(args!).toEqual([options]);
    expect(records.at(-1)).toMatchObject({ status: "accepted", marker_matches: true, target_matches: true, unique_accepted: 1 });
    expect(JSON.stringify(records)).not.toMatch(/private-id|private-result|maple|1555/);
  });

  it("preserves the original synchronous exception and asynchronous rejection", async () => {
    const error = Error("private-error");
    class Throwing { sendText() { throw error; } }
    const { observer: watch, records } = observer(); watch.attach(Throwing);
    try { new Throwing().sendText(); throw Error("expected original throw"); } catch (caught) { expect(caught).toBe(error); }
    const pending = Promise.reject(error);
    class Rejecting { sendText() { return pending; } }
    watch.attach(Rejecting);
    expect(new Rejecting().sendText()).toBe(pending);
    await expect(pending).rejects.toBe(error);
    expect(records.at(-1).status).toBe("rejected");
    expect(JSON.stringify(records)).not.toContain("private-error");
  });

  it("does not affect the send when target lookup or evidence emission fails", async () => {
    const value = { id: "accepted" };
    const pending = Promise.resolve(value);
    class Identity { sendText() { return pending; } }
    const { observer: watch } = observer(() => { throw Error("observer only"); }, () => { throw Error("observer sink"); });
    watch.attach(Identity);
    expect(new Identity().sendText()).toBe(pending);
    expect(await pending).toBe(value);
  });

  it("tracks repeated accepted IDs without treating unrelated markers/targets as matching sends", async () => {
    class Identity { sendText(_payload: unknown) { return Promise.resolve({ id: "same-private-id" }); } }
    const { observer: watch, records } = observer(); watch.attach(Identity); watch.attach(Identity);
    const instance = new Identity();
    for (const payload of [{ to: target, text: marker }, { to: target, text: marker }, { to: "+15559999999", text: marker }, { to: target, text: "different" }, { conversationId: "private", text: marker }]) await instance.sendText(payload);
    const accepted = records.filter(row => row.status === "accepted");
    expect(records.filter(row => row.module_bound)).toHaveLength(1);
    expect(accepted[1]).toMatchObject({ same_id_as_prior: true, unique_accepted: 1 });
    expect(accepted[2]).toMatchObject({ target_matches: false, same_id_as_prior: false });
    expect(accepted[3]).toMatchObject({ marker_matches: false });
    expect(accepted[4]).toMatchObject({ target_known: false, target_matches: false });
  });

  it("uses accepted recipient metadata for conversation replies and does not hide contradictory recipients", async () => {
    let result: any = { id: "conversation-receipt", remotePhoneNumber: target };
    class Identity { sendText(_payload: unknown) { return Promise.resolve(result); } }
    const { observer: watch, records } = observer(); watch.attach(Identity);
    await new Identity().sendText({ conversationId: "private", text: marker });
    expect(records.at(-1)).toMatchObject({ target_known: true, target_matches: true, target_basis: "response", unique_accepted: 1 });
    result = { id: "other-receipt", recipients: [{ recipientPhoneNumber: "+15559999999" }] };
    await new Identity().sendText({ to: target, text: marker });
    expect(records.at(-1)).toMatchObject({ target_matches: false, target_basis: "response", unique_accepted: 1 });
  });

  it("bounds accepted ID memory and marks unavailable correlation after the cap", async () => {
    let n = 0;
    class Identity { sendText(_payload: unknown) { return Promise.resolve({ id: `private-${n++}` }); } }
    const { observer: watch, records } = observer(); watch.attach(Identity);
    const instance = new Identity();
    for (let i = 0; i < 140; i++) await instance.sendText({ to: target, text: marker });
    expect(records.at(-1)).toMatchObject({ unique_accepted: 128, id_tracking_available: false, ordinal: 128, truncated: true });
  });

  it("drops arbitrary fields and unsupported class shapes instead of reporting zero sends", () => {
    expect(safeRecord({ phase: "sdk", status: "accepted", id: "private", marker_matches: true, ordinal: true })).toEqual({ phase: "sdk", status: "accepted", marker_matches: true });
    expect(safeRecord({ phase: "private", status: "accepted" })).toBeNull();
    const { observer: watch, records } = observer(); watch.attach({});
    expect(records).toEqual([{ phase: "observer", status: "unavailable", module_bound: false }]);
  });

  it("leaves unknown SDK versions and non-module formats byte-identical", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkbox-sdk-observer-"));
    try {
      const fs = await import("node:fs/promises");
      await fs.mkdir(join(dir, "dist"));
      await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@inkbox/sdk", version: "99.0.0" }));
      let captured: any;
      const output = join(dir, "safe.json");
      startPreload({ marker, statePath: join(dir, "missing"), outputPath: output, hooks: (options: any) => { captured = options; return {}; } });
      const original = { format: "module", source: "export class AgentIdentity {}" };
      const result = captured.load(new URL(`file://${dir}/dist/agent_identity.js`).href, {}, () => original);
      expect(result).toBe(original);
      expect(JSON.parse(await readFile(output, "utf8")).at(-1)).toMatchObject({ status: "unavailable", module_bound: false });
      const ordinary = { format: "commonjs", source: "private arbitrary module" };
      expect(captured.load("file:///other.js", {}, () => ordinary)).toBe(ordinary);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("intercepts both published SDK graphs loaded by the actual native plugin loader", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkbox-native-sdk-observer-"));
    try {
      // Explicit allowlist: no Inkbox/OpenAI credentials or user config inherited.
      const { stdout } = await promisify(execFile)(process.execPath, ["tests/ci/hosted_sms_sdk_contract.mjs"], {
        cwd: process.cwd(), timeout: 60_000, maxBuffer: 128_000,
        env: { PATH: process.env.PATH!, LANG: "C.UTF-8", OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: join(dir, "config.json"), XDG_STATE_HOME: join(dir, "xdg"), XDG_CACHE_HOME: join(dir, "cache"), TMPDIR: dir },
      });
      expect(stdout).toContain("two actual native-loaded module graphs observed");
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
  }, 65_000);

  it("projects the actual native channel logger without exposing call identifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inkbox-contact-log-contract-"));
    try {
      const callId = "00000000-0000-0000-0000-000000000001";
      for (const style of ["compact", "pretty", "json"]) {
        const config = join(dir, `${style}.json`);
        await writeFile(config, JSON.stringify({ logging: { level: "silent", consoleLevel: "info", consoleStyle: style } }));
        const env = { PATH: process.env.PATH!, LANG: "C.UTF-8", NO_COLOR: "1", OPENCLAW_STATE_DIR: dir,
          OPENCLAW_CONFIG_PATH: config, XDG_STATE_HOME: join(dir, "xdg"), XDG_CACHE_HOME: join(dir, "cache"), TMPDIR: dir };
        const code = `import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
          const log = createSubsystemLogger("channels").child("inkbox");
          log.info("Inkbox realtime bridge ready: call_id=${callId} provider=openai");
          log.info("Inkbox realtime audio negotiated: call_id=${callId} format=pcm_s16le_16000");
          log.info("Inkbox realtime direct contact read inkbox_list_contacts for call_id=${callId}");
          log.info("Inkbox realtime bridge closed: call_id=${callId} reason=completed");`;
        const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], {
          cwd: process.cwd(), env, timeout: 30_000, maxBuffer: 64_000,
        });
        const path = join(dir, `${style}.log`);
        await writeFile(path, stdout);
        const python = `import sys,json;sys.path.insert(0,"tests/live");import hosted_sms_diagnostics as o;t=o.Trace();o.read_contact_log({"call_id":sys.argv[1]},t,sys.argv[2]);print(json.dumps(t.records))`;
        const projected = await promisify(execFile)("python3", ["-c", python, callId, path], {
          cwd: process.cwd(), env, timeout: 10_000, maxBuffer: 8_000,
        });
        expect(JSON.parse(projected.stdout)).toEqual([expect.objectContaining({ phase: "contact", status: "observed",
          bridge_ready_observed: true, hd_audio_observed: true, bridge_closed_observed: true,
          contact_completion_observed: true, list_completions: 1, tool_admission: "unknown",
          catalog_availability: "unknown", sdk_result: "unknown", model_completion: "unknown" })]);
        expect(projected.stdout).not.toContain(callId);
      }
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }); }
  }, 100_000);

});
