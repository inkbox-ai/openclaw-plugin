import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { inkboxPlugin } from "../../src/channel.js";

it("preserves exact native account readiness used by carrier ingress preflight", async () => {
  const require = createRequire(import.meta.url);
  const dist = dirname(dirname(require.resolve("openclaw/plugin-sdk/routing")));
  const minimum = JSON.parse(readFileSync(join(dist, "..", "package.json"), "utf8")).version === "2026.5.27";
  const name = "buildChannelAccountSnapshotFromAccount";
  const files = readdirSync(dist).filter((file) => file.startsWith("status-") && /\.(?:m?js)$/.test(file) && readFileSync(join(dist, file), "utf8").includes(`function ${name}(`));
  expect(files).toHaveLength(1);
  const exports = await import(pathToFileURL(join(dist, files[0])).href);
  const project = Object.values(exports).find((value) => typeof value === "function" && value.name === name) as any;
  expect(project).toBeTypeOf("function");
  const cfg = { channels: { inkbox: { enabled: true, apiKey: "synthetic-only", signingKey: "synthetic-signing", identity: "configured-agent" } } };
  const account = inkboxPlugin.config.resolveAccount(cfg, "default");
  for (const connected of [true, false]) {
    const snapshot = await project({ plugin: inkboxPlugin, cfg, accountId: "default", account,
      runtime: { accountId: "default", running: true, connected, mode: "inkbox-tunnel" } });
    expect(snapshot).toMatchObject({ accountId: "default", configured: true, running: true, connected, mode: "inkbox-tunnel" });
    if (minimum) expect(snapshot).not.toHaveProperty("identity");
    else expect(snapshot.identity).toBe("configured-agent");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-only");
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-signing");
  }
});
