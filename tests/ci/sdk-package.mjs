import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const source = process.env.INKBOX_SDK_PATH;
const global = args.some((arg) => arg === "-g" || arg === "--global");
if (!source || global || !["ci", "install"].includes(args[0])) {
  const result = spawnSync("npm", args, { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  process.exit(result.status ?? 1);
}

const tarball = resolve(source);
const manifest = readFileSync("package.json");
const original = readFileSync("package-lock.json");
const version = JSON.parse(manifest).dependencies["@inkbox/sdk"];
const packed = JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"]));
const lock = JSON.parse(original);
const sdk = lock.packages["node_modules/@inkbox/sdk"];
if (version !== "0.7.3" || packed.name !== "@inkbox/sdk" || packed.version !== version || sdk.version !== version) {
  throw new Error("CI SDK artifact must match the declared 0.7.3 dependency.");
}
const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
console.log(`Unreleased SDK source artifact: ${integrity}; matches release lock: ${sdk.integrity === integrity}`);
sdk.resolved = pathToFileURL(tarball).href;
sdk.integrity = integrity;
const command = args[0] === "install"
  ? [...args.filter((arg) => !arg.startsWith("@inkbox/sdk@")), tarball]
  : args;
let status = 1;
try {
  // Only the SDK resolution changes; npm ci still enforces every other locked dependency.
  writeFileSync("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  const result = spawnSync("npm", command, { stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  status = result.status ?? 1;
  if (status === 0) {
    const installed = JSON.parse(readFileSync("node_modules/@inkbox/sdk/package.json"));
    if (installed.version !== version) throw new Error("CI installed an unexpected SDK version.");
    const { CompanionResource } = await import(pathToFileURL(resolve("node_modules/@inkbox/sdk/dist/index.js")).href);
    if (typeof CompanionResource?.prototype.loadInitialization !== "function") throw new Error("CI SDK is missing Companion initialization.");
  }
} finally {
  writeFileSync("package.json", manifest);
  writeFileSync("package-lock.json", original);
}
process.exit(status);
