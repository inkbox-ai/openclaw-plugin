import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
const observer = resolve("tests/live/channel_native_observer.mjs");
const scope = { inbound_id: "fixture-source", text: "Send email with code abcdef. Return NO_REPLY.", marker: "abcdef" };
const sessionKey = "agent:main:inkbox:direct:fixture";
const log = (id = scope.inbound_id, key = sessionKey, sessionId = "unknown") => JSON.stringify({
  subsystem: "diagnostic", message: `message received: channel=inkbox chatId=fixture messageId=${id} sessionId=${sessionId} sessionKey=${key} source=dispatchInboundMessage`,
});
const load = () => import(pathToFileURL(observer).href);

function env(state: string) {
  // No live/model/auth credentials enter the native fixture process.
  return { PATH: process.env.PATH, HOME: state, TMPDIR: process.env.TMPDIR ?? tmpdir(),
    OPENCLAW_STATE_DIR: state, XDG_CACHE_HOME: join(state, "cache"), XDG_CONFIG_HOME: join(state, "config"),
    OPENCLAW_NO_RESPAWN: "1", GATEWAY_LOG: join(state, "gateway.log") };
}
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  function walk(path: string) {
    for (const name of readdirSync(path)) {
      const file = join(path, name), stat = statSync(file);
      out[file.slice(dir.length)] = stat.isDirectory() ? "directory" : `${stat.mtimeMs}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
      if (stat.isDirectory()) walk(file);
    }
  }
  walk(dir);
  return out;
}
function child(state: string) {
  const output = execFileSync(process.execPath, [observer], { env: env(state), cwd: process.cwd(),
    input: JSON.stringify(scope), encoding: "utf8", timeout: 15000, maxBuffer: 65536, stdio: ["pipe", "pipe", "pipe"] });
  return JSON.parse(output);
}

describe("exact-source post-outcome native diagnostics", () => {
  it("requires the exact source, actual native format and one unambiguous session", async () => {
    const { sourceSession } = await load();
    expect(sourceSession(log(), scope.inbound_id)).toEqual({ kind: "found", sessionKey, sessionId: "unknown" });
    expect(sourceSession(log("foreign"), scope.inbound_id)).toEqual({ kind: "missing" });
    expect(sourceSession(`${log()}\n${log(scope.inbound_id, "agent:main:other")}`, scope.inbound_id)).toEqual({ kind: "ambiguous" });
    expect(sourceSession(`${log()}\n${log(scope.inbound_id, sessionKey, "another")}`, scope.inbound_id)).toEqual({ kind: "ambiguous" });
    expect(sourceSession(log().replace("dispatchInboundMessage", "other"), scope.inbound_id)).toEqual({ kind: "missing" });
    expect(sourceSession(log().replace('"diagnostic"', '"other"'), scope.inbound_id)).toEqual({ kind: "missing" });
    const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "inkbox-native-log-"));
    try {
      const config = join(state, "openclaw.json");
      writeFileSync(config, JSON.stringify({ logging: { consoleStyle: "json", consoleLevel: "trace", file: join(state, "native.log") } }));
      const script = `
        import {readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
        const dist=${JSON.stringify(hostDist)};
        const file=readdirSync(dist).find(f=>/^subsystem-.*\\.(?:m?js)$/.test(f)&&readFileSync(join(dist,f),'utf8').includes('function createSubsystemLogger('));
        const exports=await import(pathToFileURL(join(dist,file)).href);
        const create=Object.values(exports).find(f=>typeof f==='function'&&f.name==='createSubsystemLogger');
        create('diagnostic').debug(${JSON.stringify(JSON.parse(log()).message)});`;
      const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        env: { ...env(state), OPENCLAW_CONFIG_PATH: config, OPENCLAW_LOG_LEVEL: "trace" },
        timeout: 20000, maxBuffer: 65536, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(sourceSession(output, scope.inbound_id)).toEqual({ kind: "found", sessionKey, sessionId: "unknown" });
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 25000);

  it("reports ingress only without consulting native config, stores or transcript projections", async () => {
    const { observeNative } = await load();
    const supplied = { log: log(),
      get store() { throw new Error("must not read native store"); },
      get transcript() { throw new Error("must not read native transcript"); } };
    const result = await observeNative(scope, supplied);
    expect(result[0]).toEqual({ phase: "native", status: "observed", ingress_observed: true,
      ambiguous: false, truncated: false, transcript: "unknown", model_start: "unknown",
      tool_evidence: "unavailable", completion: "unknown" });
    expect(JSON.stringify(result)).not.toContain(scope.text);
    const source = readFileSync(observer, "utf8");
    expect(source).not.toMatch(/import\s*\(/);
    expect(source).not.toContain("openclaw/plugin-sdk");
  });

  it("keeps missing, foreign, ambiguous and truncated log evidence explicit", async () => {
    const { observeNative } = await load();
    expect((await observeNative({ ...scope, inbound_id: undefined }, { log: log() }))[0]).not.toHaveProperty("ingress_observed");
    expect((await observeNative(scope, { log: log("foreign") }))[0]).toMatchObject({ ingress_observed: false, status: "unavailable" });
    const oldLog = process.env.GATEWAY_LOG;
    process.env.GATEWAY_LOG = join(tmpdir(), `absent-${randomUUID()}`);
    try { expect((await observeNative(scope))[0]).not.toHaveProperty("ingress_observed"); }
    finally { if (oldLog === undefined) delete process.env.GATEWAY_LOG; else process.env.GATEWAY_LOG = oldLog; }
    expect((await observeNative(scope, { log: log(), logTruncated: true }))[0]).toMatchObject({ status: "unavailable", truncated: true, ingress_observed: true });
    expect((await observeNative(scope, { log: `${log()}\n${log(scope.inbound_id, "agent:main:other")}` }))[0]).toMatchObject({ status: "unavailable", ambiguous: true, ingress_observed: true });
    expect((await observeNative(scope, { log: JSON.stringify({ subsystem: "agent", message: JSON.parse(log()).message }) }))[0]).toMatchObject({ status: "unavailable", ingress_observed: false });
  });

  it("absent-state ingress observation creates no state or files", () => {
    const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "inkbox-native-read-"));
    try {
      writeFileSync(join(state, "gateway.log"), log() + "\n");
      const before = snapshot(state);
      const result = child(state);
      expect(result[0]).toMatchObject({ status: "observed", transcript: "unknown", ingress_observed: true });
      expect(snapshot(state)).toEqual(before);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 25000);

  it("actual hot-state and changed logging config remain untouched by ingress-only observation", () => {
    const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "inkbox-native-hot-"));
    try {
      const id = randomUUID();
      writeFileSync(join(state, "gateway.log"), log(scope.inbound_id, sessionKey, id) + "\n");
      if (hostVersion !== "2026.5.27") {
        const setup = `
          import {upsertSessionEntry} from 'openclaw/plugin-sdk/session-store-runtime';
          import {appendSessionTranscriptMessageByIdentity} from 'openclaw/plugin-sdk/session-transcript-runtime';
          const target={agentId:'main',sessionKey:${JSON.stringify(sessionKey)}};
          await upsertSessionEntry({...target,entry:{sessionId:${JSON.stringify(id)},updatedAt:Date.now()}});
          await appendSessionTranscriptMessageByIdentity({...target,sessionId:${JSON.stringify(id)},message:{role:'user',content:[{type:'text',text:${JSON.stringify(scope.text)}}],timestamp:Date.now()}});
          process.exit(0);`;
        execFileSync(process.execPath, ["--input-type=module", "-e", setup], { env: env(state), cwd: process.cwd(),
          timeout: 20000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
      }
      const before = snapshot(state);
      const result = child(state);
      expect(result[0]).toMatchObject({ status: "observed", transcript: "unknown", ingress_observed: true,
        tool_evidence: "unavailable", model_start: "unknown", completion: "unknown" });
      expect(snapshot(state)).toEqual(before);
      // This config transition made the previous public catalog reader write
      // config-health metadata. The log-only observer never loads that API,
      // so even a real hot database plus changed redaction config stays intact.
      writeFileSync(join(state, "openclaw.json"), JSON.stringify({ logging: { redactPatterns: [scope.marker] } }));
      const beforeChangedConfigRead = snapshot(state);
      expect(child(state)[0]).toMatchObject({ status: "observed", ingress_observed: true,
        transcript: "unknown", truncated: false, ambiguous: false, model_start: "unknown", completion: "unknown" });
      expect(snapshot(state)).toEqual(beforeChangedConfigRead);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 45000);

  it("actual live-writer observation preserves database/WAL contents and closes its child", async () => {
    const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "inkbox-native-live-read-"));
    let writer: ReturnType<typeof spawn> | undefined;
    try {
      const id = randomUUID();
      writeFileSync(join(state, "gateway.log"), log(scope.inbound_id, sessionKey, id) + "\n");
      if (hostVersion === "2026.5.27") {
        const before = snapshot(state);
        expect(child(state)[0]).toMatchObject({ status: "observed", transcript: "unknown" });
        expect(snapshot(state)).toEqual(before);
        return;
      }
      const setup = `
        import {upsertSessionEntry} from 'openclaw/plugin-sdk/session-store-runtime';
        import {appendSessionTranscriptMessageByIdentity} from 'openclaw/plugin-sdk/session-transcript-runtime';
        const target={agentId:'main',sessionKey:${JSON.stringify(sessionKey)}};
        await upsertSessionEntry({...target,entry:{sessionId:${JSON.stringify(id)},updatedAt:Date.now()}});
        await appendSessionTranscriptMessageByIdentity({...target,sessionId:${JSON.stringify(id)},message:{role:'user',content:[{type:'text',text:${JSON.stringify(scope.text)}}],timestamp:Date.now()}});
        process.stdout.write('ready\\n');
        process.stdin.resume();process.stdin.on('end',()=>process.exit(0));`;
      writer = spawn(process.execPath, ["--input-type=module", "-e", setup], { env: env(state), cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
      writer.stderr!.resume();
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("native fixture readiness timeout")), 20000);
        writer!.stdout!.once("data", data => {
          clearTimeout(timer);
          if (String(data) === "ready\n") resolveReady();
          else reject(new Error("unexpected native fixture output"));
        });
        writer!.once("exit", () => { clearTimeout(timer); reject(new Error("native fixture ended before observation")); });
      });
      // Freeze only this credential-free setup process after committed native
      // writes. Its open handles model the live gateway while excluding its
      // unrelated periodic state writes from the observer side-effect check.
      writer.kill("SIGSTOP");
      await new Promise(resolveWait => setTimeout(resolveWait, 100));
      const before = snapshot(state);
      expect(child(state)[0]).toMatchObject({ status: "observed", transcript: "unknown", completion: "unknown" });
      expect(snapshot(state)).toEqual(before);
      const closed = new Promise<number | null>((resolveExit, reject) => {
        const timer = setTimeout(() => reject(new Error("native fixture close timeout")), 5000);
        writer!.once("exit", code => { clearTimeout(timer); resolveExit(code); });
      });
      writer.kill("SIGCONT");
      writer.stdin!.end();
      expect(await closed).toBe(0);
    } finally {
      if (writer && writer.exitCode === null) {
        writer.kill("SIGKILL");
        await new Promise<void>(resolveExit => writer!.once("exit", () => resolveExit()));
      }
      rmSync(state, { recursive: true, force: true });
    }
  }, 45000);


  it("actual native cold archive stays cold and unchanged during observation", () => {
    const state = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "inkbox-native-cold-read-"));
    try {
      const id = randomUUID();
      writeFileSync(join(state, "gateway.log"), log(scope.inbound_id, sessionKey, id) + "\n");
      if (hostVersion !== "2026.5.27") {
        const setup = `
          import {upsertSessionEntry} from 'openclaw/plugin-sdk/session-store-runtime';
          import {appendSessionTranscriptMessageByIdentity} from 'openclaw/plugin-sdk/session-transcript-runtime';
          import {readdirSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {pathToFileURL} from 'node:url';
          const dist=${JSON.stringify(hostDist)};
          const file=readdirSync(dist).find(f=>/^session-cold-storage-[^.]+\\.mjs$/.test(f)&&readFileSync(join(dist,f),'utf8').includes('async function runSessionColdStorageMaintenance('));
          if(!file)throw Error('native cold fixture API unavailable');
          const exports=await import(pathToFileURL(join(dist,file)).href);
          const maintain=Object.values(exports).find(f=>typeof f==='function'&&f.name==='runSessionColdStorageMaintenance');
          const target={agentId:'main',sessionKey:${JSON.stringify(sessionKey)}};
          const realNow=Date.now;Date.now=()=>realNow()-60*86400000;
          await upsertSessionEntry({...target,entry:{sessionId:${JSON.stringify(id)},updatedAt:Date.now()}});
          await appendSessionTranscriptMessageByIdentity({...target,sessionId:${JSON.stringify(id)},message:{role:'user',content:[{type:'text',text:${JSON.stringify(scope.text)}}],timestamp:Date.now()}});
          Date.now=realNow;
          const result=await maintain({config:{agents:{list:[{id:'main'}]},session:{maintenance:{coldStorage:{enabled:true,afterDays:30}}}}});
          if(result.archivedTranscripts!==1)throw Error('native fixture did not archive exactly one transcript');
          process.exit(0);`;
        execFileSync(process.execPath, ["--input-type=module", "-e", setup], { env: env(state), cwd: process.cwd(),
          timeout: 25000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"] });
      }
      const before = snapshot(state);
      expect(child(state)[0]).toMatchObject({ status: "observed", transcript: "unknown", ingress_observed: true });
      expect(snapshot(state)).toEqual(before);
    } finally { rmSync(state, { recursive: true, force: true }); }
  }, 45000);

});
