import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const hostDist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
const hostVersion = JSON.parse(readFileSync(join(hostDist, "..", "package.json"), "utf8")).version;
const modelKey = "openai/gpt-5.6-sol";

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
    const files = readdirSync(hostDist).filter((file) => file.startsWith("policy-") && file.endsWith(".js") &&
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
