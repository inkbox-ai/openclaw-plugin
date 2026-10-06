import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { bindNativeOwner, guardRetiredNativeRun, trackNativeOwner } from "../../src/native-owner.js";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
const modelKey = "openai/gpt-5.6-sol";

it("passes stopped native ownership through the installed host's before-agent-run gate", async () => {
  const files = readdirSync(hostDist).filter((file) => file.startsWith("hook-runner-global-") && (file.endsWith(".js") || file.endsWith(".mjs")) && readFileSync(join(hostDist, file), "utf8").includes("function initializeGlobalHookRunner("));
  expect(files).toHaveLength(1);
  const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
  const exported = (name: string) => { const value = Object.values(exports).find((value) => typeof value === "function" && value.name === name) as any; expect(value).toBeTypeOf("function"); return value; };
  const initialize = exported("initializeGlobalHookRunner"), current = exported("getGlobalHookRunner"), reset = exported("resetGlobalHookRunner");
  const owner = trackNativeOwner("stopped-session", async () => { throw new Error("source stopped"); }, async () => {});
  try {
    initialize({ hooks: [], plugins: [], trustedToolPolicies: [], typedHooks: [{ pluginId: "inkbox", hookName: "before_agent_run", handler: bindNativeOwner }] });
    const runner = current();
    const result = await runner.runBeforeAgentRun({ prompt: owner.marker }, { sessionKey: "stopped-session", runId: "stopped-run" });
    expect(result.decision.outcome).toBe("block");
    expect(result.decision.reason).toContain("no longer authorized");
    expect(guardRetiredNativeRun({}, { runId: "stopped-run" })?.block).toBe(true);
    expect(guardRetiredNativeRun({}, { runId: "different-run" })).toBeUndefined();
  } finally { owner.close(); reset(); }
});

it("explicitly selects the native runner in every real live fixture", () => {
  for (const name of ["channels", "a2a", "voice", "external-events"]) {
    const workflow = readFileSync(join(process.cwd(), `.github/workflows/live-${name}.yml`), "utf8");
    expect(workflow).toContain(`openclaw config set 'agents.defaults.models["${modelKey}"].agentRuntime.id' openclaw`);
  }
});

// The minimum May host predates the official-provider implicit Codex routing.
// A missing policy on a newer host is a compatibility failure, not a skip.
describe.skipIf(hostVersion === "2026.5.27")("actual host runner selection", () => {
  it("retains native provider metadata while explicitly selecting lifecycle-capable execution", async () => {
    const files = readdirSync(hostDist).filter((file) => file.startsWith("policy-") && (file.endsWith(".js") || file.endsWith(".mjs")) &&
      readFileSync(join(hostDist, file), "utf8").includes("function resolveAgentHarnessPolicy("));
    expect(files).toHaveLength(1);
    const exports = await import(pathToFileURL(join(hostDist, files[0])).href);
    const resolvePolicy = Object.values(exports).find((value) => typeof value === "function" && value.name === "resolveAgentHarnessPolicy") as (params: unknown) => { runtime: string };
    expect(resolvePolicy).toBeTypeOf("function");
    const route = { provider: "openai", modelId: "gpt-5.6-sol", modelApi: "openai-responses", modelBaseUrl: "https://api.openai.com/v1", env: {} };
    expect(resolvePolicy({ ...route, config: {} }).runtime).toBe("codex");
    expect(resolvePolicy({ ...route, config: { agents: { defaults: { models: { [modelKey]: { agentRuntime: { id: "openclaw" } } } } } } }).runtime).toBe("openclaw");
  });
});
