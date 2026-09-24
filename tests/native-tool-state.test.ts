import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { instrumentToolState, projectToolState } from "./ci/native_tool_state.mjs";

const KEY = Symbol.for("inkbox.ciNativeToolState.v1");
const require = createRequire(import.meta.url);
const fixture = `function resolvePluginToolsFromRegistry(params, loadState) {
\tconst { context, env, onlyPluginIds, allowlist, snapshot } = loadState;
\tconst runtimeRegistry = params.registry;
\tconst toolOwners = new Map();
\tconst findRuntimeOwner = (id) => runtimeRegistry.plugins.find(p => p.id === id);
\tconst missingPluginIds = onlyPluginIds;
\tif (missingPluginIds.length > 0) {
\t\tfor (const id of missingPluginIds) toolOwners.set(id, {tools: runtimeRegistry.tools});
\t}
\tconst orderedManifests = loadState.loadOptions.manifestRegistry?.plugins ?? snapshot.plugins;
\tconst tools = [];
\tconst factories = {report() { params.reports++; }};
\tfor (const { id: pluginId } of orderedManifests) {
\t\tconst owner = toolOwners.get(pluginId);
\t\tif (owner) tools.push(...owner.tools);
\t}
\tif (params.fail) throw params.fail;
\tfactories.report();
\treturn tools;
}`;

describe("temporary CI native tool-state observer", () => {
  it("projects only closed booleans and bounded counts", () => {
    const line = projectToolState("owner", 10000, {selected: true, registrations: 99999,
      complete: "private@example.com", returned: -1, path: "/private/config", owner: {secret: true}});
    expect(line).toContain("assembly=9999");
    expect(line).toContain("registrations=9999");
    expect(line).toContain("complete=unknown");
    expect(line).toContain("returned=unknown");
    expect(line).not.toMatch(/private|secret|example/);
    expect(projectToolState("untrusted phase", 1, {})).toBeUndefined();
  });

  it("requires each unique native anchor and leaves unsupported sources alone", () => {
    expect(instrumentToolState(fixture)).toBeTypeOf("string");
    expect(instrumentToolState(fixture + fixture)).toBeUndefined();
    expect(instrumentToolState(fixture.replace("const findRuntimeOwner =", "const other ="))).toBeUndefined();
    expect(instrumentToolState(instrumentToolState(fixture))).toBeUndefined();
    expect(instrumentToolState("not native source")).toBeUndefined();
  });

  it("preserves native results/errors even when the observer throws", () => {
    const run = new Function("getPluginInstance", instrumentToolState(fixture) + "\nreturn resolvePluginToolsFromRegistry;")((record: unknown) => record);
    const nativeError = new Error("original synthetic error");
    const tool = { name: "inkbox_synthetic" };
    const record = { id: "inkbox", toolRegistrationComplete: false };
    const params = {registry: {plugins: [record], tools: [tool]}, reports: 0, fail: undefined as Error | undefined};
    const snapshot = {plugins: [record], byPluginId: new Map([["inkbox", record]]), index: {plugins: [{pluginId: "inkbox", enabled: true}]}};
    const state = {context: {}, env: {}, onlyPluginIds: ["inkbox"], allowlist: {}, snapshot, loadOptions: {manifestRegistry: {plugins: [record]}}};
    const previous = (globalThis as any)[KEY];
    try {
      (globalThis as any)[KEY] = {next() { throw new Error("observer error"); }, emit() { throw new Error("observer error"); }};
      expect(run(params, state)).toEqual([tool]);
      expect(params.reports).toBe(1);
      params.fail = nativeError;
      expect(() => run(params, state)).toThrow(nativeError);
      expect(params.reports).toBe(1);
    } finally { (globalThis as any)[KEY] = previous; }
  });

  it("distinguishes selected ownership, cold registrations and final output", () => {
    const run = new Function("getPluginInstance", instrumentToolState(fixture) + "\nreturn resolvePluginToolsFromRegistry;")((record: unknown) => record);
    const records: string[] = [];
    const record = {id: "inkbox", toolRegistrationComplete: false};
    const previous = (globalThis as any)[KEY];
    try {
      (globalThis as any)[KEY] = {next: () => 1, emit: (...args: unknown[]) => records.push((projectToolState as any)(...args))};
      run({registry: {plugins: [record], tools: [{name: "inkbox_synthetic", pluginId: "inkbox"}]}, reports: 0}, {
        context: {}, env: {}, onlyPluginIds: ["inkbox"], allowlist: {},
        snapshot: {plugins: [record], byPluginId: new Map([["inkbox", record]]), index: {plugins: [{pluginId: "inkbox", enabled: true}]}},
        loadOptions: {manifestRegistry: {plugins: [record]}},
      });
      expect(records).toHaveLength(3);
      expect(records[0]).toContain("selected=true snapshot=true scoped=false index=true enabled=true ordered=true owner=true complete=false cold=true registrations=1");
      expect(records[2]).toContain("returned=1");
    } finally { (globalThis as any)[KEY] = previous; }
  });

  it("accepts the inspected native host source without syntax changes", () => {
    const root = path.resolve(path.dirname(require.resolve("openclaw/plugin-sdk/channel-core")), "../..");
    const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    if (manifest.version !== "2026.9.6") return; // This temporary observer is version-gated, not a host compatibility requirement.
    const candidates = readdirSync(path.join(root, "dist")).filter(name => /^tools-[A-Za-z0-9_-]+\.mjs$/.test(name));
    const accepted = candidates.map(name => instrumentToolState(readFileSync(path.join(root, "dist", name), "utf8"))).filter(Boolean);
    expect(accepted).toHaveLength(1);
    const parsed = ts.createSourceFile("native.mjs", accepted[0]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    expect((parsed as any).parseDiagnostics).toEqual([]);
  });

  it("installs only for the exact host root and preserves an executed native fixture", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "inkbox-native-probe-"));
    try {
      mkdirSync(path.join(root, "dist"));
      writeFileSync(path.join(root, "package.json"), JSON.stringify({name: "openclaw", version: "2026.9.6", type: "module"}));
      writeFileSync(path.join(root, "dist", "tools-CvXdkvXK.mjs"),
        "const getPluginInstance = (record) => record;\n" + fixture + "\nexport { resolvePluginToolsFromRegistry };\n");
      writeFileSync(path.join(root, "openclaw.mjs"), `
        import { resolvePluginToolsFromRegistry as run } from './dist/tools-CvXdkvXK.mjs';
        const record = {id:'inkbox',toolRegistrationComplete:false};
        const tool = {name:'inkbox_synthetic',pluginId:'inkbox'};
        const result = run({registry:{plugins:[record],tools:[tool]},reports:0},{
          context:{},env:{},onlyPluginIds:['inkbox'],allowlist:{},
          snapshot:{plugins:[record],byPluginId:new Map([['inkbox',record]]),index:{plugins:[{pluginId:'inkbox',enabled:true}]}},
          loadOptions:{manifestRegistry:{plugins:[record]}}
        });
        process.stdout.write(result[0] === tool ? 'native_result_preserved' : 'wrong_result');
      `);
      const executable = path.join(root, "openclaw.mjs");
      const output = spawnSync(process.execPath, ["--import", path.resolve("tests/ci/native_tool_state.mjs"), executable], {
        env: {...process.env, INKBOX_CI_NATIVE_HOST: executable}, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
      expect(output.status).toBe(0);
      expect(output.stdout).toBe("native_result_preserved");
      expect(output.stderr).toContain("native_tool_probe status=installed");
      expect(output.stderr).toContain("native_tool_probe phase=owner assembly=1");
      expect(output.stderr).toContain("returned=1");
      expect(output.stderr).not.toContain(root);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
