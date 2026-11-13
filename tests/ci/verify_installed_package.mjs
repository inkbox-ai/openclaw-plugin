import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "inkbox-openclaw-package-"));
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--json", "--pack-destination", directory], {
    encoding: "utf8",
  }),
);
const hostVersion = JSON.parse(
  readFileSync("node_modules/openclaw/package.json", "utf8"),
).version;
const source = JSON.parse(readFileSync("package.json", "utf8"));
writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, dependencies: {
  "@inkbox/inkbox": `file:${join(directory, packed.filename)}`, openclaw: hostVersion,
}, pnpm: source.pnpm }));
writeFileSync(join(directory, "pnpm-workspace.yaml"), "onlyBuiltDependencies:\n  - '@inkbox/sdk'\n");
execFileSync("npx", ["--yes", "pnpm@10.28.0", "install"], { cwd: directory, stdio: "inherit" });
const installed = join(directory, "node_modules/@inkbox/inkbox/package.json");
execFileSync(
  process.execPath,
  ["tests/ci/verify_sdk.mjs", installed],
  { stdio: "inherit" },
);
const entry = (
  await import(join(directory, "node_modules/@inkbox/inkbox/dist/index.js"))
).default;
if (entry.id !== "inkbox" || typeof entry.register !== "function")
  throw new Error("The packed native OpenClaw entry did not load.");
console.log(
  `Verified packed native plugin with OpenClaw ${hostVersion} and the pinned SDK source.`,
);

rmSync(directory, { recursive: true, force: true });
