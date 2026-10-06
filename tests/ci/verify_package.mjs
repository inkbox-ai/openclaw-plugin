import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const [packed] = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json"], { encoding: "utf8" }));
const included = new Set(packed.files.map(({ path }) => path));
for (const path of [manifest.main, ...manifest.openclaw.extensions]) {
  if (!included.has(path.replace(/^\.\//, ""))) throw new Error(`Published package is missing native entry ${path}`);
}
for (const path of ["openclaw.plugin.json", "dist/src/slack.js", "dist/src/native-source.js", "dist/src/native-owner.js"]) {
  if (!included.has(path)) throw new Error(`Published package is missing ${path}`);
}
const entry = (await import(new URL(`../../${manifest.openclaw.extensions[0]}`, import.meta.url))).default;
if (entry.id !== "inkbox" || typeof entry.register !== "function") throw new Error("Compiled native channel entry did not load");
console.log(`Verified ${packed.name}@${packed.version}: all native entries and runtime modules are publishable.`);
